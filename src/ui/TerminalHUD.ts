import type { LogEntry } from "../core/EventLog";
import type { InstrumentSnapshot, ToolId } from "../core/Tools";

/**
 * Operative console. DOM <pre> only. No framework, no webfont, no icons.
 *
 * Blocks: NAV · SYS · INS · LOG
 * Density drops at Macro / STANDBY so the theater stays quiet.
 * This class reads. It does not write the world.
 */

export type ConsoleDensity = "low" | "mid" | "high";
export type SysState = "QUIET" | "COUPLING" | "STRESSED" | "THERMAL";

export interface KernelView {
  kind: string;
  label: string;
  mag: number;
  tauLeft: number;
}

export interface ConsoleFrame {
  scale: number;
  band: string;
  x: number;
  y: number;
  z: number;
  vel: number;
  layer: string;
  sys: {
    state: SysState;
    load: number;
    stress: number;
    thermal: number;
    kernels: readonly KernelView[];
  };
  ins: InstrumentSnapshot;
  log: readonly LogEntry[];
  density: ConsoleDensity;
}

export class TerminalHUD {
  private readonly root: HTMLPreElement;
  private last = "";

  constructor() {
    this.root = document.createElement("pre");
    this.root.className = "aetheris-hud";
    this.root.setAttribute("aria-live", "off");
    document.body.appendChild(this.root);
    this.root.textContent = "AETHERIS // OPS.CONSOLE\n------------------------\nNAV    --";
  }

  update(f: ConsoleFrame): void {
    const parts: string[] = [
      "AETHERIS // OPS.CONSOLE",
      "------------------------",
      this.nav(f),
    ];
    if (f.density !== "low" || f.sys.state !== "QUIET") {
      parts.push("------------------------", this.sys(f));
    }
    parts.push("------------------------", this.ins(f));
    if (f.density !== "low" || f.log.length > 0) {
      parts.push("------------------------", this.log(f));
    }
    const text = parts.join("\n");
    if (text === this.last) return;
    this.last = text;
    this.root.textContent = text;
  }

  dispose(): void {
    this.root.remove();
  }

  private nav(f: ConsoleFrame): string {
    const lines = [
      "NAV",
      `  SCALE  ${sci(f.scale)}`,
      `  BAND   ${f.band}`,
      `  POS    ${xyz(f.x)} ${xyz(f.y)} ${xyz(f.z)}`,
      `  VEL    ${fixed(f.vel, 3)} u/s`,
    ];
    if (f.density !== "low" || f.layer !== "STANDBY") {
      lines.push(`  FLD    ${f.layer}`);
    }
    return lines.join("\n");
  }

  private sys(f: ConsoleFrame): string {
    const lines = [
      "SYS",
      `  STATE  ${f.sys.state}`,
      `  LOAD   ${f.sys.load.toFixed(2)}   σ=${f.sys.stress.toFixed(2)}`,
    ];
    if (f.density === "high" || f.sys.thermal > 0.12 || f.ins.tool === "assembler") {
      lines.push(`  THRM   ${f.sys.thermal.toFixed(2)}`);
    }
    if (f.sys.kernels.length === 0) {
      if (f.density !== "low") lines.push("  CPL    --");
    } else {
      lines.push(`  CPL    n=${f.sys.kernels.length}`);
      const show = f.density === "high" ? 2 : 1;
      for (const k of f.sys.kernels.slice(0, show)) {
        lines.push(`         ${k.label}  ${k.mag.toFixed(2)}  τ=${k.tauLeft.toFixed(0)}s`);
      }
    }
    return lines.join("\n");
  }

  private ins(f: ConsoleFrame): string {
    const t = f.ins.tool;
    if (t === "none") {
      return "INS\n  TOOL   STANDBY";
    }
    if (t === "scanner") {
      return (
        "INS\n" +
        "  TOOL   SCANNER\n" +
        `  CH     ${f.ins.scannerChannel}\n` +
        `  SIG    ${f.ins.scannerSig}`
      );
    }
    if (t === "assembler") {
      const a = f.ins.assembler;
      const sub = a.sub === null ? "--" : a.sub.toFixed(2);
      return [
        "INS",
        "  TOOL   ASSEMBLER",
        `  ACT    ${a.action}`,
        `  GATE   ${a.gate}`,
        `  E      ${a.energy.toFixed(1).padStart(5, " ")} / ${a.eMax} U`,
        `  SUB    ${sub}`,
        `  THRM   ${a.thermal.toFixed(2)}`,
        `  COST   ${a.costE.toFixed(1)}U  ${a.costS.toFixed(2)}S  +${a.costT.toFixed(2)}T`,
        `  TGT    ${a.tgt}`,
        `  STAT   ${a.status}`,
      ].join("\n");
    }
    const r = f.ins.probe;
    if (!r) return "INS\n  TOOL   PROBE\n  SMP    --";
    const ves = r.vesselClass
      ? `${r.vesselClass.toUpperCase()} d=${r.vesselDist.toFixed(3)}`
      : "NONE";
    const cell =
      r.cellKind && r.vm !== null
        ? `${r.cellKind.toUpperCase()} Vm=${Math.round(r.vm)}mV` +
          (r.stress !== null && r.stress > 0.05 ? ` σ=${r.stress.toFixed(2)}` : "")
        : "NONE";
    const mol =
      r.molClass && r.occupancy !== null && r.energy !== null
        ? `${r.molClass.toUpperCase()} θ=${r.occupancy.toFixed(2)} E=${r.energy.toFixed(2)}`
        : "NONE";
    const nano =
      r.nanoIntegrity !== null && r.coherence !== null
        ? `I=${r.nanoIntegrity.toFixed(2)} Φ=${(r.nanoField ?? 0).toFixed(2)} γ=${r.coherence.toFixed(2)}`
        : "NONE";
    const lines = [
      "INS",
      "  TOOL   PROBE",
      `  SMP    ${xyz(r.point.x)} ${xyz(r.point.y)} ${xyz(r.point.z)}`,
      `  LOAD   ${r.load.toFixed(2)}  ${r.loadKPa.toFixed(0)} kPa`,
    ];
    if (f.density !== "low") {
      lines.push(`  ECM    ${r.ecmIndex.toFixed(2)}`, `  VESL   ${ves}`);
    }
    if (f.density === "high") {
      lines.push(`  CELL   ${cell}`, `  MOL    ${mol}`, `  NANO   ${nano}`);
    } else if (f.density === "mid") {
      if (cell !== "NONE") lines.push(`  CELL   ${cell}`);
      if (mol !== "NONE") lines.push(`  MOL    ${mol}`);
    }
    return lines.join("\n");
  }

  private log(f: ConsoleFrame): string {
    const n = f.density === "high" ? 8 : f.density === "mid" ? 5 : 3;
    const slice = f.log.slice(-n);
    const lines = ["LOG"];
    if (slice.length === 0) {
      lines.push("  --");
      return lines.join("\n");
    }
    for (const e of slice) {
      const seq = String(e.seq).padStart(3, "0");
      const t = String(Math.floor(e.t)).padStart(4, "0");
      lines.push(`  ${seq} T+${t} ${e.kind} ${e.text}`);
    }
    return lines.join("\n");
  }
}

export function densityFor(scale: number, tool: ToolId): ConsoleDensity {
  if (tool !== "none") {
    return scale < 0.03 ? "high" : "mid";
  }
  if (scale >= 0.3) return "low";
  if (scale >= 0.03) return "mid";
  return "high";
}

export function sysState(
  stress: number,
  thermal: number,
  coupling: boolean,
): SysState {
  if (thermal >= 0.5) return "THERMAL";
  if (stress >= 0.22) return "STRESSED";
  if (coupling) return "COUPLING";
  return "QUIET";
}

function sci(n: number): string {
  if (!Number.isFinite(n)) return "NAN";
  return n.toExponential(6).padStart(12, " ");
}

function xyz(n: number): string {
  if (!Number.isFinite(n)) return "   NAN  ";
  const body = Math.abs(n).toFixed(3).padStart(7, "0");
  return (n < 0 ? "-" : "+") + body;
}

function fixed(n: number, digits: number): string {
  if (!Number.isFinite(n)) return "NAN";
  return n.toFixed(digits).padStart(8, " ");
}
