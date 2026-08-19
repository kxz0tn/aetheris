import * as THREE from "three";
import {
  cellularPresence,
  molecularPresence,
  nanoPresence,
  tissuePresence,
  type ScaleManager,
} from "./ScaleManager";
import type { MacroTwin } from "./MacroTwin";
import type { TissueLayer } from "./TissueLayer";
import type { CellularLayer } from "./CellularLayer";
import type { MolecularLayer } from "./MolecularLayer";
import type { NanoFieldLayer } from "./NanoFieldLayer";
import { Assembler } from "./Assembler";
import type { AssemblerSnapshot } from "./Assembler";
import type { CascadeSystem } from "./CascadeSystem";
import type { EventLog } from "./EventLog";

/**
 * Phase 4 instruments. Observation and contact sampling only.
 * No fabrication. No world writes. ScaleManager stays geometry-free.
 *
 *   T     cycle NONE → SCANNER → PROBE → ASSEMBLER
 *   Q     scanner channel  /  assembler action
 *   E / LMB (pointer-lock)   probe sample / assembler execute
 *
 * Scanner: non-destructive spectral gain.
 * Probe: ray sample of existing query APIs.
 * Assembler: constrained write (see Assembler.ts).
 */

export type ToolId = "none" | "scanner" | "probe" | "assembler";

export interface InstrumentSnapshot {
  tool: ToolId;
  scannerChannel: string;
  scannerSig: string;
  assembler: AssemblerSnapshot;
  probe: ProbeReading | null;
}
export type ScanChannel =
  | "structure"
  | "vascular"
  | "cellular"
  | "fields"
  | "molecular"
  | "nano";

const CHANNELS: readonly ScanChannel[] = [
  "structure",
  "vascular",
  "cellular",
  "fields",
  "molecular",
  "nano",
];

const CHANNEL_LABEL: Record<ScanChannel, string> = {
  structure: "STRUCTURE",
  vascular: "VASCULAR",
  cellular: "CELLULAR",
  fields: "FIELDS",
  molecular: "MOLECULAR",
  nano: "NANO/FIELD",
};

export interface ProbeReading {
  point: THREE.Vector3;
  load: number;
  loadKPa: number;
  ecmIndex: number;
  vesselClass: string | null;
  vesselDist: number;
  cellKind: string | null;
  cellDist: number;
  vm: number | null;
  molClass: string | null;
  occupancy: number | null;
  energy: number | null;
  nanoIntegrity: number | null;
  nanoField: number | null;
  nanoSub: number | null;
  coherence: number | null;
  stress: number | null;
  band: string;
}

export class InstrumentRig {
  private tool: ToolId = "none";
  private channel: ScanChannel = "structure";
  private reading: ProbeReading | null = null;

  private readonly scanner: ScanPlane;
  private readonly probe: ProbeReticle;
  private readonly assembler: Assembler;

  private readonly look = new THREE.Vector3();
  private readonly hit = new THREE.Vector3();

  constructor(
    scene: THREE.Scene,
    private readonly camera: THREE.PerspectiveCamera,
    private readonly twin: MacroTwin,
    private readonly tissue: TissueLayer,
    private readonly cellular: CellularLayer,
    private readonly molecular: MolecularLayer,
    private readonly nano: NanoFieldLayer,
    private readonly scale: ScaleManager,
    cascade: CascadeSystem,
    log?: EventLog,
  ) {
    this.scanner = new ScanPlane(scene);
    this.probe = new ProbeReticle(scene);
    this.assembler = new Assembler(nano, molecular, scale, cascade, log);
  }

  cycleTool(): ToolId {
    this.tool =
      this.tool === "none"
        ? "scanner"
        : this.tool === "scanner"
          ? "probe"
          : this.tool === "probe"
            ? "assembler"
            : "none";
    this.reading = null;
    this.applyGains();
    return this.tool;
  }

  cycleChannel(): ScanChannel {
    if (this.tool === "assembler") {
      this.assembler.cycleAction();
      return this.channel;
    }
    if (this.tool !== "scanner") return this.channel;
    const i = CHANNELS.indexOf(this.channel);
    this.channel = CHANNELS[(i + 1) % CHANNELS.length];
    this.applyGains();
    return this.channel;
  }

  /** Probe sample or assembler execute. */
  fire(): void {
    if (this.tool !== "probe" && this.tool !== "assembler") return;
    this.camera.getWorldDirection(this.look);
    const origin = this.camera.position;
    const scale = this.scale.getCurrentScale();
    const tmax = THREE.MathUtils.clamp(2.4 + 14 * scale, 1.1, 20);
    const capture = THREE.MathUtils.clamp(0.07 + 0.40 * scale, 0.055, 0.55);

    const best = this.pickAlongRay(origin, this.look, tmax, capture);
    const p = best ?? origin.clone().addScaledVector(this.look, Math.min(1.6, tmax * 0.35));

    if (this.tool === "assembler") {
      this.assembler.execute(p, capture);
      this.probe.mark(p, this.look);
      return;
    }

    const tissueOn = tissuePresence(scale) > 0.06;
    const cellOn = cellularPresence(scale) > 0.08;
    const molOn = molecularPresence(scale) > 0.08;
    const nanoOn = nanoPresence(scale) > 0.08;
    const ts = this.tissue.sampleAt(p);
    const cs = cellOn ? this.cellular.sampleNearest(p, capture) : null;
    const ms = molOn ? this.molecular.sampleNearest(p, capture * 0.85) : null;
    const ns = nanoOn ? this.nano.sampleNearest(p, capture) : null;

    const axis =
      ms
        ? this.look.clone()
        : cs
          ? this.look.clone()
          : this.tissue.nearestVesselAxis(p) ?? new THREE.Vector3(0, 1, 0);

    this.reading = {
      point: p.clone(),
      load: ts.load,
      loadKPa: ts.loadKPa,
      ecmIndex: ts.ecmIndex,
      vesselClass: tissueOn ? ts.vesselClass : null,
      vesselDist: ts.vesselDist,
      cellKind: cs ? cs.kind : null,
      cellDist: cs ? cs.dist : Infinity,
      vm: cs ? cs.vm : null,
      molClass: ms ? ms.cls : null,
      occupancy: ms ? ms.occupancy : null,
      energy: ms ? ms.energy : null,
      nanoIntegrity: ns ? ns.integrity : null,
      nanoField: ns ? ns.fieldAmp : null,
      nanoSub: ns ? ns.substrate : null,
      coherence: ns ? ns.coherence : null,
      stress: cs ? cs.stress : ms ? ms.stress : null,
      band: this.scale.getSample().label,
    };
    this.probe.mark(p, axis);
  }

  update(dt: number): void {
    const scale = this.scale.getCurrentScale();
    this.camera.getWorldDirection(this.look);
    const dist = THREE.MathUtils.clamp(1.8 * Math.sqrt(scale) + 0.22, 0.22, 3.4);
    this.hit.copy(this.camera.position).addScaledVector(this.look, dist);

    this.scanner.setActive(this.tool === "scanner");
    this.probe.setActive(this.tool === "probe" || this.tool === "assembler");
    this.assembler.update(dt);
    if (this.tool === "assembler") {
      this.assembler.preview(this.hit);
    }

    if (this.tool === "scanner") {
      this.scanner.pose(this.camera, this.look, dist, scale);
      this.scanner.paintHits(
        this.hit,
        dist,
        scale,
        this.channel,
        this.tissue,
        this.cellular,
        this.molecular,
        this.nano,
      );
    }
    if (this.tool === "probe" || this.tool === "assembler") {
      this.probe.poseAim(this.hit);
    }
  }

  get activeTool(): ToolId {
    return this.tool;
  }

  get thermalLoad(): number {
    return this.assembler.thermalLoad;
  }

  snapshot(): InstrumentSnapshot {
    const scale = this.scale.getCurrentScale();
    let sig = "OK";
    if (this.channel === "cellular" && cellularPresence(scale) < 0.08) sig = "NO SIGNAL";
    if (this.channel === "vascular" && tissuePresence(scale) < 0.06) sig = "NO SIGNAL";
    if (this.channel === "fields" && tissuePresence(scale) < 0.06) sig = "WEAK";
    if (this.channel === "molecular" && molecularPresence(scale) < 0.08) sig = "NO SIGNAL";
    if (this.channel === "nano" && nanoPresence(scale) < 0.08) sig = "NO SIGNAL";
    return {
      tool: this.tool,
      scannerChannel: CHANNEL_LABEL[this.channel],
      scannerSig: sig,
      assembler: this.assembler.snapshot(),
      probe: this.reading,
    };
  }

  dispose(): void {
    this.scanner.dispose();
    this.probe.dispose();
  }

  private applyGains(): void {
    if (this.tool !== "scanner") {
      this.twin.setScanGain(1);
      this.tissue.setScanGains(1, 1, 1);
      this.cellular.setScanGain(1);
      this.molecular.setScanGain(1, 1);
      this.nano.setScanGain(1, 1);
      return;
    }
    const dim = 0.15;
    const boost = 1.28;
    const g = {
      structure: dim,
      vascular: dim,
      cellular: dim,
      fields: dim,
      molecular: dim,
      nano: dim,
    };
    g[this.channel] = boost;
    this.twin.setScanGain(g.structure);
    this.tissue.setScanGains(g.structure, g.vascular, g.fields);
    this.cellular.setScanGain(g.cellular);
    this.molecular.setScanGain(g.molecular, g.fields);
    this.nano.setScanGain(g.nano, g.fields);
  }

  private pickAlongRay(
    origin: THREE.Vector3,
    dir: THREE.Vector3,
    tmax: number,
    capture: number,
  ): THREE.Vector3 | null {
    let bestT = -1;
    let bestD = capture;
    const tmp = new THREE.Vector3();
    let snapped: THREE.Vector3 | null = null;

    const consider = (p: THREE.Vector3, snap: boolean): void => {
      const t = tmp.copy(p).sub(origin).dot(dir);
      if (t < 0.08 || t > tmax) return;
      const closest = origin.clone().addScaledVector(dir, t);
      const d = closest.distanceTo(p);
      if (d < bestD) {
        bestD = d;
        bestT = t;
        snapped = snap ? p.clone() : null;
      }
    };

    const steps = 18;
    for (let i = 1; i <= steps; i++) {
      const t = (i / steps) * tmax;
      const q = origin.clone().addScaledVector(dir, t);
      const cell = this.cellular.sampleNearest(q, capture);
      if (cell) consider(cell.position, true);
      const mol = this.molecular.sampleNearest(q, capture);
      if (mol) consider(mol.position, true);
      const nn = this.nano.sampleNearest(q, capture);
      if (nn) consider(nn.position, true);
      const ts = this.tissue.sampleAt(q);
      if (ts.vesselClass && ts.vesselDist < capture) consider(q, false);
      if (ts.ecmIndex > 0.55) consider(q, false);
    }

    if (bestT < 0) return null;
    return snapped ?? origin.clone().addScaledVector(dir, bestT);
  }
}

/** Holographic scan plane in front of the camera. Observation only. */
class ScanPlane {
  private readonly group = new THREE.Group();
  private readonly hits: THREE.Points;
  private readonly hitPos: Float32Array;
  private readonly hitAttr: THREE.BufferAttribute;
  private readonly mat: THREE.LineBasicMaterial;
  private readonly hitMat: THREE.PointsMaterial;
  private readonly grid: THREE.LineSegments;
  private readonly _right = new THREE.Vector3();
  private readonly _up = new THREE.Vector3();
  private readonly _hit = new THREE.Vector3();

  constructor(scene: THREE.Scene) {
    this.group.name = "ScanPlane";
    this.mat = new THREE.LineBasicMaterial({
      color: 0xc8c8c8,
      transparent: true,
      opacity: 0.42,
      fog: true,
      depthWrite: false,
    });
    this.grid = new THREE.LineSegments(this.buildGrid(1), this.mat);
    this.group.add(this.grid);

    this.hitPos = new Float32Array(64 * 3);
    const geo = new THREE.BufferGeometry();
    this.hitAttr = new THREE.BufferAttribute(this.hitPos, 3);
    geo.setAttribute("position", this.hitAttr);
    this.hitMat = new THREE.PointsMaterial({
      color: 0xffffff,
      size: 0.04,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.85,
      fog: true,
      depthWrite: false,
    });
    this.hits = new THREE.Points(geo, this.hitMat);
    this.group.add(this.hits);
    this.group.visible = false;
    scene.add(this.group);
  }

  setActive(on: boolean): void {
    this.group.visible = on;
  }

  pose(
    camera: THREE.PerspectiveCamera,
    look: THREE.Vector3,
    dist: number,
    scale: number,
  ): void {
    const half = THREE.MathUtils.clamp(1.15 * Math.sqrt(scale) + 0.16, 0.16, 2.1);
    this.group.position.copy(camera.position).addScaledVector(look, dist);
    this.group.quaternion.copy(camera.quaternion);
    this.group.scale.setScalar(half);
    this.hitMat.size = THREE.MathUtils.clamp(0.018 + 0.04 * Math.sqrt(scale), 0.016, 0.06);
  }

  paintHits(
    center: THREE.Vector3,
    dist: number,
    scale: number,
    channel: ScanChannel,
    tissue: TissueLayer,
    cellular: CellularLayer,
    molecular: MolecularLayer,
    nano: NanoFieldLayer,
  ): void {
    const half = THREE.MathUtils.clamp(1.15 * Math.sqrt(scale) + 0.16, 0.16, 2.1);
    const n = 6;
    let w = 0;
    this._right.set(1, 0, 0).applyQuaternion(this.group.quaternion);
    this._up.set(0, 1, 0).applyQuaternion(this.group.quaternion);
    const thresh = THREE.MathUtils.clamp(0.10 + 0.35 * scale, 0.08, 0.5);
    void dist;

    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const u = (i / (n - 1) - 0.5) * 2 * half;
        const v = (j / (n - 1) - 0.5) * 2 * half;
        const p = this._hit
          .copy(center)
          .addScaledVector(this._right, u)
          .addScaledVector(this._up, v);
        let keep = false;
        if (channel === "cellular") {
          const c = cellular.sampleNearest(p, thresh);
          keep = !!c;
        } else if (channel === "molecular") {
          const m = molecular.sampleNearest(p, thresh);
          keep = !!m;
        } else if (channel === "nano") {
          const n = nano.sampleNearest(p, thresh);
          keep = !!n;
        } else if (channel === "fields") {
          const t = tissue.sampleAt(p);
          const m = molecular.sampleNearest(p, thresh * 1.2);
          const n = nano.sampleNearest(p, thresh);
          const c = cellular.sampleNearest(p, thresh);
          keep =
            t.load > 0.28 ||
            t.ecmIndex > 0.4 ||
            (!!m && (m.energy < 0.55 || m.occupancy > 0.70 || m.stress > 0.16)) ||
            (!!n && n.fieldAmp > 0.5) ||
            (!!c && c.stress > 0.16);
        } else if (channel === "vascular") {
          const t = tissue.sampleAt(p);
          keep = !!t.vesselClass && t.vesselDist < thresh * 1.4;
        } else {
          const t = tissue.sampleAt(p);
          keep = t.ecmIndex > 0.22 || t.load > 0.2;
        }
        if (!keep) continue;
        const o = w * 3;
        this.hitPos[o] = p.x;
        this.hitPos[o + 1] = p.y;
        this.hitPos[o + 2] = p.z;
        w++;
        if (w >= 64) break;
      }
      if (w >= 64) break;
    }
    this.hits.geometry.setDrawRange(0, w);
    this.hitAttr.needsUpdate = true;
  }

  dispose(): void {
    this.grid.geometry.dispose();
    this.hits.geometry.dispose();
    this.mat.dispose();
    this.hitMat.dispose();
    this.group.removeFromParent();
  }

  private buildGrid(half: number): THREE.BufferGeometry {
    const v: number[] = [];
    const push = (
      ax: number, ay: number, az: number,
      bx: number, by: number, bz: number,
    ): void => {
      v.push(ax, ay, az, bx, by, bz);
    };
    const h = half;
    push(-h, -h, 0, h, -h, 0);
    push(h, -h, 0, h, h, 0);
    push(h, h, 0, -h, h, 0);
    push(-h, h, 0, -h, -h, 0);
    const div = 4;
    for (let i = 1; i < div; i++) {
      const a = -h + (2 * h * i) / div;
      push(a, -h, 0, a, h, 0);
      push(-h, a, 0, h, a, 0);
    }
    // Corner ticks.
    const t = h * 0.18;
    push(-h, -h, 0, -h - t, -h, 0);
    push(-h, -h, 0, -h, -h - t, 0);
    push(h, -h, 0, h + t, -h, 0);
    push(h, h, 0, h, h + t, 0);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(v, 3));
    return geo;
  }
}

/** Contact reticle + last-sample filament. */
class ProbeReticle {
  private readonly group = new THREE.Group();
  private readonly aim: THREE.LineSegments;
  private readonly markG = new THREE.Group();
  private readonly mat: THREE.LineBasicMaterial;
  private readonly markMat: THREE.LineBasicMaterial;

  constructor(scene: THREE.Scene) {
    this.mat = new THREE.LineBasicMaterial({
      color: 0xe8e8e8,
      transparent: true,
      opacity: 0.7,
      fog: true,
      depthWrite: false,
    });
    this.markMat = new THREE.LineBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.9,
      fog: true,
    });
    this.aim = new THREE.LineSegments(this.buildCross(0.08), this.mat);
    this.group.add(this.aim);
    this.group.add(this.markG);
    this.group.visible = false;
    scene.add(this.group);
  }

  setActive(on: boolean): void {
    this.group.visible = on;
    if (!on) this.clearMark();
  }

  poseAim(p: THREE.Vector3): void {
    this.aim.position.copy(p);
  }

  mark(p: THREE.Vector3, axis: THREE.Vector3): void {
    this.clearMark();
    const a = axis.clone().normalize();
    const soup: number[] = [];
    const r = 0.06;
    // Sample point triad.
    soup.push(p.x - r, p.y, p.z, p.x + r, p.y, p.z);
    soup.push(p.x, p.y - r, p.z, p.x, p.y + r, p.z);
    soup.push(p.x, p.y, p.z - r, p.x, p.y, p.z + r);
    // Data filament along local axis.
    const tip = p.clone().addScaledVector(a, 0.22);
    soup.push(p.x, p.y, p.z, tip.x, tip.y, tip.z);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(soup, 3));
    this.markG.add(new THREE.LineSegments(geo, this.markMat));
  }

  dispose(): void {
    this.clearMark();
    this.aim.geometry.dispose();
    this.mat.dispose();
    this.markMat.dispose();
    this.group.removeFromParent();
  }

  private clearMark(): void {
    for (const c of [...this.markG.children]) {
      this.markG.remove(c);
      if (c instanceof THREE.LineSegments) c.geometry.dispose();
    }
  }

  private buildCross(s: number): THREE.BufferGeometry {
    const v = new Float32Array([
      -s, 0, 0, s, 0, 0,
      0, -s, 0, 0, s, 0,
      0, 0, -s * 0.4, 0, 0, s * 0.4,
    ]);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(v, 3));
    return geo;
  }
}
