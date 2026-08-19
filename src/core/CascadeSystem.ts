import * as THREE from "three";
import type { TissueLayer } from "./TissueLayer";
import type { CellularLayer } from "./CellularLayer";
import type { EventLog } from "./EventLog";

/**
 * Cross-scale coupling. Local, lossy, relaxing. Not a physiology engine.
 *
 * Upward kernels are emitted only by the Assembler after a successful write.
 * Downward terms are pulled from Tissue / Cellular at query time (spatial,
 * instantaneous, no extra state). Loop gain is broken by construction:
 *   - upward never writes Tissue load
 *   - downward never writes Nano fieldAmp / integrity (only rest floor + γ)
 *   - occupancy upward is applied at Cellular, not re-added to Molecular
 *
 * Channels (focused set):
 *   UP    integrity  REINFORCE → molecular stability + cellular membrane stress
 *   UP    occupancy  BIND      → cellular Vm / stress (θ already written on mol)
 *   UP    field      FIELD     → molecular energy well + cellular stress
 *   UP    thermal    THRM high → occupancy jitter + membrane disturbance
 *   DOWN  load       tissue mechanical field → mol θ baseline, cell stress,
 *                    nano integrity rest floor
 *   DOWN  perfusion  vessel/ECM context → mol θ baseline
 *   DOWN  vm         cellular depolarization → nano coherence (readout only)
 *
 * Kernels: mag · exp(−d²/2r²) · exp(−age/τ). Cap 16. Sum clamped.
 * ScaleManager is not imported. Timing lives in update(dt).
 */

export type CascadeKind = "integrity" | "occupancy" | "field" | "thermal";

export interface CascadeReader {
  integrityAt(p: THREE.Vector3): number;
  occupancyAt(p: THREE.Vector3): number;
  fieldAt(p: THREE.Vector3): number;
  thermalAt(p: THREE.Vector3): number;
  loadAt(p: THREE.Vector3): number;
  perfusionAt(p: THREE.Vector3): number;
  membraneStressAt(p: THREE.Vector3): number;
  coherenceModAt(p: THREE.Vector3): number;
  integrityRestDelta(p: THREE.Vector3): number;
}

interface Kernel {
  kind: CascadeKind;
  position: THREE.Vector3;
  magnitude: number;
  radius: number;
  tau: number;
  age: number;
  label: string;
}

const MAX_KERNELS = 16;
const SUM_CAP = 0.55;

export class CascadeSystem implements CascadeReader {
  private readonly kernels: Kernel[] = [];
  private last: Kernel | null = null;
  private readonly tissueCache = new Map<string, ReturnType<TissueLayer["sampleAt"]>>();

  constructor(
    private readonly tissue: TissueLayer,
    private readonly cellular: CellularLayer,
    private readonly log?: EventLog,
  ) {}

  /**
   * Assembler write consequence. Magnitude is clamped. Oldest kernel drops
   * if the buffer is full — no unbounded accumulation.
   */
  emit(
    kind: CascadeKind,
    p: THREE.Vector3,
    magnitude: number,
    radius: number,
    tau: number,
    label: string,
  ): void {
    const mag = THREE.MathUtils.clamp(magnitude, -0.5, 0.5);
    if (Math.abs(mag) < 0.03) return;
    if (this.kernels.length >= MAX_KERNELS) this.kernels.shift();
    const k: Kernel = {
      kind,
      position: p.clone(),
      magnitude: mag,
      radius,
      tau,
      age: 0,
      label,
    };
    this.kernels.push(k);
    this.last = k;
    this.log?.push("CPL", `${label} ${mag.toFixed(2)}`);
  }

  liveKernels(): ReadonlyArray<{
    kind: CascadeKind;
    label: string;
    mag: number;
    tauLeft: number;
  }> {
    const out: Array<{
      kind: CascadeKind;
      label: string;
      mag: number;
      tauLeft: number;
    }> = [];
    for (const k of this.kernels) {
      const mag = Math.abs(k.magnitude) * Math.exp(-k.age / k.tau);
      if (mag < 0.04) continue;
      out.push({
        kind: k.kind,
        label: k.label,
        mag,
        tauLeft: Math.max(0, k.tau - k.age),
      });
    }
    out.sort((a, b) => b.mag - a.mag);
    return out;
  }

  update(dt: number): void {
    if (dt <= 0) return;
    this.tissueCache.clear();
    for (let i = this.kernels.length - 1; i >= 0; i--) {
      this.kernels[i].age += dt;
      if (this.kernels[i].age > this.kernels[i].tau * 4) {
        this.kernels.splice(i, 1);
      }
    }
    if (this.last && this.last.age > this.last.tau * 4) this.last = null;
  }

  integrityAt(p: THREE.Vector3): number {
    return this.sum("integrity", p);
  }

  occupancyAt(p: THREE.Vector3): number {
    return this.sum("occupancy", p);
  }

  fieldAt(p: THREE.Vector3): number {
    return this.sum("field", p);
  }

  thermalAt(p: THREE.Vector3): number {
    return this.sum("thermal", p);
  }

  loadAt(p: THREE.Vector3): number {
    return this.tissueAt(p).load;
  }

  perfusionAt(p: THREE.Vector3): number {
    const t = this.tissueAt(p);
    const v = t.vesselClass ? Math.exp(-t.vesselDist / 0.42) : 0;
    return THREE.MathUtils.clamp(0.55 * t.ecmIndex + 0.45 * v, 0, 1);
  }

  /**
   * Cellular membrane stress. Integrity / field / thermal kernels + tissue load.
   * Lossy mix, capped.
   */
  membraneStressAt(p: THREE.Vector3): number {
    const s =
      0.70 * this.integrityAt(p) +
      0.45 * this.fieldAt(p) +
      0.40 * this.occupancyAt(p) +
      0.50 * this.thermalAt(p) +
      0.22 * this.loadAt(p);
    return THREE.MathUtils.clamp(s, 0, SUM_CAP);
  }

  /**
   * Nano coherence modifier, signed. Depolarized / stressed membrane
   * decoheres. Thermal decoheres. Not a write to fieldAmp.
   */
  coherenceModAt(p: THREE.Vector3): number {
    const cell = this.cellular.sampleNearest(p, 0.85);
    let depol = 0;
    if (cell) {
      depol = THREE.MathUtils.clamp((cell.vm + 78) / 22, -0.3, 0.7);
    }
    return THREE.MathUtils.clamp(
      -0.16 * depol - 0.22 * this.thermalAt(p) - 0.10 * this.loadAt(p),
      -0.35,
      0.15,
    );
  }

  /** Shift of nano integrity rest floor. High tissue load → harder to hold. */
  integrityRestDelta(p: THREE.Vector3): number {
    return -0.10 * this.loadAt(p);
  }

  hudLine(): string {
    if (!this.last) return "";
    const left = Math.abs(this.last.magnitude) * Math.exp(-this.last.age / this.last.tau);
    if (left < 0.04) return "";
    return `${this.last.label}  ${left.toFixed(2)}`;
  }

  private sum(kind: CascadeKind, p: THREE.Vector3): number {
    let acc = 0;
    for (const k of this.kernels) {
      if (k.kind !== kind) continue;
      const d = p.distanceTo(k.position);
      const g = Math.exp(-0.5 * (d / Math.max(k.radius, 1e-4)) ** 2);
      const decay = Math.exp(-k.age / k.tau);
      acc += k.magnitude * g * decay;
    }
    return THREE.MathUtils.clamp(acc, -SUM_CAP, SUM_CAP);
  }

  private tissueAt(p: THREE.Vector3): ReturnType<TissueLayer["sampleAt"]> {
    const key = `${(p.x * 8) | 0}:${(p.y * 8) | 0}:${(p.z * 8) | 0}`;
    let s = this.tissueCache.get(key);
    if (!s) {
      s = this.tissue.sampleAt(p);
      this.tissueCache.set(key, s);
    }
    return s;
  }
}
