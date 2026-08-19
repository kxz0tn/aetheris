import * as THREE from "three";
import { nanoPresence, type ScaleManager } from "./ScaleManager";
import type { MolecularLayer } from "./MolecularLayer";
import type { NanoFieldLayer } from "./NanoFieldLayer";
import type { CascadeSystem } from "./CascadeSystem";
import type { EventLog } from "./EventLog";

/**
 * Nano-Assembler. First writing instrument. Not a free-build tool.
 *
 * Constraint model (HUD-visible):
 *   E      energy store, 0–100 U.  1 U ≈ 10 kT. Station feed only
 *          while nanoPresence is open. Landauer-scale state writes
 *          sit in the 8–20 U band; mechanical reinforcement more.
 *   SUB    local substrate at the aimed node (monomer pool).
 *   THRM   thermal load 0–1. Actions dump heat. Fail above 0.85
 *          (denaturation / decoherence gate). Cools with τ ≈ 8 s.
 *   GATE   nanoPresence ≥ 0.35. Below that the instrument is dark.
 *
 * Actions (Q cycles, E / LMB executes on the look-ray target):
 *   REINFORCE  local cage struts. Work against a relaxing lattice.
 *   BIND       bias Langmuir occupancy on the host complex. ΔG cost
 *              rises as the state leaves equilibrium.
 *   FIELD      charge the local field capacitor (~½εE²ΔV).
 *
 * Every reject is a named failure. Success is a numbered debit.
 */

export type AssemblerAction = "reinforce" | "bind" | "field";

const ACTIONS: readonly AssemblerAction[] = ["reinforce", "bind", "field"];

const ACTION_LABEL: Record<AssemblerAction, string> = {
  reinforce: "REINFORCE",
  bind: "BIND",
  field: "FIELD",
};

export interface AssemblerSnapshot {
  action: string;
  gate: "OPEN" | "CLOSED";
  energy: number;
  eMax: number;
  sub: number | null;
  thermal: number;
  costE: number;
  costS: number;
  costT: number;
  tgt: string;
  status: string;
}

const E_MAX = 100;
const THRM_FAIL = 0.85;
const GATE = 0.35;

export class Assembler {
  private action: AssemblerAction = "reinforce";
  private energy = 78;
  private thermal = 0.08;
  private status = "IDLE";
  private aim: THREE.Vector3 | null = null;

  constructor(
    private readonly nano: NanoFieldLayer,
    private readonly molecular: MolecularLayer,
    private readonly scale: ScaleManager,
    private readonly cascade: CascadeSystem,
    private readonly log?: EventLog,
  ) {}

  cycleAction(): AssemblerAction {
    const i = ACTIONS.indexOf(this.action);
    this.action = ACTIONS[(i + 1) % ACTIONS.length];
    return this.action;
  }

  /**
   * Attempt the current action at p. Caller supplies a probe-style sample point.
   */
  execute(p: THREE.Vector3, capture: number): boolean {
    const np = nanoPresence(this.scale.getCurrentScale());
    if (np < GATE) {
      return this.fail("REJECT  SCALE GATE");
    }
    if (this.thermal >= THRM_FAIL) {
      return this.fail("REJECT  THERMAL LIMIT");
    }

    const node = this.nano.sampleNearest(p, capture);
    const mol = this.molecular.sampleNearest(p, capture);
    const cost = this.quote(node?.integrity ?? 0.38, node?.fieldAmp ?? 0.4, mol?.occupancy ?? 0.5);

    if (!node) {
      return this.fail("REJECT  NO TARGET");
    }
    if (this.energy < cost.e) {
      return this.fail(`REJECT  E INSUFFICIENT  need ${cost.e.toFixed(1)}U`);
    }
    if (node.substrate < cost.s) {
      return this.fail("REJECT  NO SUBSTRATE");
    }

    let ok = false;
    if (this.action === "reinforce") {
      ok = this.nano.reinforce(p, capture, cost.s);
    } else if (this.action === "field") {
      ok = this.nano.modulateField(p, capture);
      if (ok) this.nano.consumeSubstrate(p, capture, cost.s);
    } else {
      const nudged = this.molecular.nudgeBinding(p, capture, 0.18);
      ok = !!nudged;
      if (ok) this.nano.consumeSubstrate(p, capture, cost.s);
    }

    if (!ok) {
      const why =
        this.action === "reinforce"
          ? "REJECT  INTEGRITY CAP"
          : this.action === "field"
            ? "REJECT  FIELD SATURATED"
            : "REJECT  NO COMPLEX";
      return this.fail(why);
    }

    this.energy -= cost.e;
    this.thermal = Math.min(1, this.thermal + cost.t);
    this.status = `OK  ${ACTION_LABEL[this.action]}  -${cost.e.toFixed(1)}U  -${cost.s.toFixed(2)}S`;
    this.log?.push("ASM", this.status);
    this.emitCascade(p);
    return true;
  }

  private fail(msg: string): false {
    this.status = msg;
    this.log?.push("REJ", msg);
    return false;
  }

  snapshot(): AssemblerSnapshot {
    const np = nanoPresence(this.scale.getCurrentScale());
    const cap = THREE.MathUtils.clamp(0.035 + 0.40 * this.scale.getCurrentScale(), 0.028, 0.55);
    const sample = this.aim ? this.nano.sampleNearest(this.aim, cap) : null;
    const mol = this.aim ? this.molecular.sampleNearest(this.aim, cap) : null;
    const cost = this.quote(sample?.integrity ?? 0.38, sample?.fieldAmp ?? 0.4, mol?.occupancy ?? 0.5);
    return {
      action: ACTION_LABEL[this.action],
      gate: np >= GATE ? "OPEN" : "CLOSED",
      energy: this.energy,
      eMax: E_MAX,
      sub: sample ? sample.substrate : null,
      thermal: this.thermal,
      costE: cost.e,
      costS: cost.s,
      costT: cost.t,
      tgt: sample
        ? `${sample.host.toUpperCase()} I=${sample.integrity.toFixed(2)} Φ=${sample.fieldAmp.toFixed(2)}`
        : "NONE",
      status: this.status,
    };
  }

  get thermalLoad(): number {
    return this.thermal;
  }

  private emitCascade(p: THREE.Vector3): void {
    if (this.action === "reinforce") {
      this.cascade.emit("integrity", p, 0.34, 0.55, 12, "REINFORCE→MOL/CELL");
    } else if (this.action === "field") {
      this.cascade.emit("field", p, 0.30, 0.50, 10, "FIELD→MOL/CELL");
    } else {
      this.cascade.emit("occupancy", p, 0.28, 0.48, 8, "BIND→CELL");
    }
    if (this.thermal >= 0.42) {
      this.cascade.emit(
        "thermal",
        p,
        Math.min(0.40, (this.thermal - 0.28) * 0.85),
        0.70,
        6,
        "THERMAL→CELL",
      );
    }
  }

  preview(p: THREE.Vector3): void {
    this.aim = p.clone();
  }

  update(dt: number): void {
    if (dt <= 0) return;
    const np = nanoPresence(this.scale.getCurrentScale());
    // Station feed only while the nano gate is open.
    if (np >= GATE && this.energy < E_MAX) {
      this.energy = Math.min(E_MAX, this.energy + 3.6 * np * dt);
    }
    this.thermal *= Math.exp(-dt / 8);
  }

  /**
   * Thermodynamic quote. Not a precise calorimeter — an order-of-magnitude
   * instrument model.
   *
   *   REINFORCE  mechanical work vs a relaxing lattice; cost rises with integrity.
   *   BIND       chemical-potential write; cost rises away from θ ≈ 0.5.
   *   FIELD      capacitor charge; cost rises with existing fieldAmp.
   */
  private quote(
    integrity: number,
    fieldAmp: number,
    occupancy: number,
  ): { e: number; s: number; t: number } {
    if (this.action === "reinforce") {
      return {
        e: 16 + 10 * integrity,
        s: 0.14,
        t: 0.18 + 0.10 * this.thermal,
      };
    }
    if (this.action === "bind") {
      return {
        e: 10 + 16 * Math.abs(occupancy - 0.5),
        s: 0.05,
        t: 0.14 + 0.08 * this.thermal,
      };
    }
    return {
      e: 8 + 12 * fieldAmp,
      s: 0.03,
      t: 0.16 + 0.09 * this.thermal,
    };
  }
}
