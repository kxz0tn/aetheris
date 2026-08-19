/**
 * Scale continuum. Logarithmic. Spatial. No biology. No geometry.
 *
 * currentScale is a dimensionless world-scale factor:
 *   1.0   Macro Theater          (body as structural field)
 *   0.1   Tissue approach
 *   0.01  Cellular approach
 *   1e-3  Molecular approach
 *   1e-4  Nano / field
 *
 * Why log: equal densification steps are equal Δlog10, matching how
 * length-scales actually nest (mm → µm → nm). Linear interpolation of
 * `current` would stall for decades on the way to 1e-4. We interpolate
 * in log10-space and store the linear value for callers.
 *
 * Geometry layers must densify in place. They subscribe via
 * onScaleChanged and self-quantize rebuilds. This class never touches
 * a mesh.
 */

export type ScaleBandId =
  | "WIDE_FIELD"
  | "MACRO"
  | "TISSUE_APPROACH"
  | "CELLULAR_APPROACH"
  | "MOLECULAR_APPROACH"
  | "NANO_FIELD"
  | "SUB_NANO";

export interface ScaleSample {
  current: number;
  target: number;
  /** log10(current). The actual coordinate along the continuum. */
  log10: number;
  band: ScaleBandId;
  label: string;
}

export type ScaleListener = (sample: ScaleSample) => void;

/** Decade centers. Band occupies ±0.5 decades around the center. */
const BANDS: ReadonlyArray<{
  id: ScaleBandId;
  label: string;
  logCenter: number;
}> = [
  { id: "WIDE_FIELD", label: "WIDE FIELD", logCenter: 1 },
  { id: "MACRO", label: "MACRO", logCenter: 0 },
  { id: "TISSUE_APPROACH", label: "TISSUE APPROACH", logCenter: -1 },
  { id: "CELLULAR_APPROACH", label: "CELLULAR APPROACH", logCenter: -2 },
  { id: "MOLECULAR_APPROACH", label: "MOLECULAR APPROACH", logCenter: -3 },
  { id: "NANO_FIELD", label: "NANO / FIELD", logCenter: -4 },
  { id: "SUB_NANO", label: "SUB-NANO", logCenter: -5 },
];

/**
 * Spatial blend into the tissue band. 0 above ~0.42, 1 by ~0.076.
 * Used by MacroTwin (fade silhouette) and TissueLayer (reveal). Scale math only.
 */
export function tissuePresence(scale: number): number {
  const g = -Math.log10(Math.max(scale, 1e-12));
  return THREE_SMOOTHSTEP(g, 0.38, 1.12);
}

/**
 * Depth inside the tissue regime. 0 at first reveal, 1 at cellular approach (0.01).
 * Drives in-place densification of ECM / distal vessels / field overlays.
 */
export function tissueDepth(scale: number): number {
  const g = -Math.log10(Math.max(scale, 1e-12));
  return THREE_SMOOTHSTEP(g, 0.38, 2.0);
}

/**
 * Spatial blend into the cellular band. 0 above ~0.045, 1 by ~0.007.
 * Tissue yields; CellularLayer reveals. Scale math only.
 */
export function cellularPresence(scale: number): number {
  const g = -Math.log10(Math.max(scale, 1e-12));
  return THREE_SMOOTHSTEP(g, 1.35, 2.15);
}

/**
 * Depth inside the cellular regime. 0 at first reveal, 1 toward 0.001.
 * Drives cytoskeleton / distal cells / mito fade-in.
 */
export function cellularDepth(scale: number): number {
  const g = -Math.log10(Math.max(scale, 1e-12));
  return THREE_SMOOTHSTEP(g, 1.35, 3.0);
}

/**
 * Spatial blend into the molecular band. 0 above ~0.0045, 1 by ~0.0007.
 * Cells yield; MolecularLayer reveals. Scale math only.
 */
export function molecularPresence(scale: number): number {
  const g = -Math.log10(Math.max(scale, 1e-12));
  return THREE_SMOOTHSTEP(g, 2.35, 3.15);
}

/**
 * Depth inside the molecular regime. 0 at first reveal, 1 toward 1e-4.
 * Drives secondary domains / energy-field fade-in.
 */
export function molecularDepth(scale: number): number {
  const g = -Math.log10(Math.max(scale, 1e-12));
  return THREE_SMOOTHSTEP(g, 2.35, 4.0);
}

/**
 * Spatial blend into the nano / field band. 0 above ~4.5e-4, 1 by ~7e-5.
 * Molecules yield; NanoFieldLayer reveals. Scale math only.
 */
export function nanoPresence(scale: number): number {
  const g = -Math.log10(Math.max(scale, 1e-12));
  return THREE_SMOOTHSTEP(g, 3.35, 4.15);
}

/**
 * Depth inside the nano regime. 0 at first reveal, 1 toward 1e-5.
 */
export function nanoDepth(scale: number): number {
  const g = -Math.log10(Math.max(scale, 1e-12));
  return THREE_SMOOTHSTEP(g, 3.35, 5.0);
}

function THREE_SMOOTHSTEP(x: number, min: number, max: number): number {
  if (x <= min) return 0;
  if (x >= max) return 1;
  const t = (x - min) / (max - min);
  return t * t * (3 - 2 * t);
}

export function bandFromScale(scale: number): {
  id: ScaleBandId;
  label: string;
} {
  const g = Math.log10(Math.max(scale, 1e-12));
  // Nearest decade center.
  let best = BANDS[0];
  let bestD = Infinity;
  for (const b of BANDS) {
    const d = Math.abs(g - b.logCenter);
    if (d < bestD) {
      bestD = d;
      best = b;
    }
  }
  return { id: best.id, label: best.label };
}

export class ScaleManager {
  private current = 1.0;
  private target = 1.0;

  /** Exponential rate in log10-space (1/s). */
  private readonly rate = 4.0;

  private readonly minScale = 1e-6;
  private readonly maxScale = 10;

  private readonly listeners = new Set<ScaleListener>();

  getCurrentScale(): number {
    return this.current;
  }

  getTargetScale(): number {
    return this.target;
  }

  getLogScale(): number {
    return Math.log10(this.current);
  }

  getSample(): ScaleSample {
    return this.capture();
  }

  setTargetScale(value: number): void {
    if (!Number.isFinite(value)) return;
    this.target = this.clamp(value);
  }

  /**
   * Step along the continuum by a number of decades.
   * Negative = descent (densify). Positive = ascent.
   * This is the spatial move: equal wheel ticks = equal scale-space distance.
   */
  nudgeLog(decades: number): void {
    if (!Number.isFinite(decades) || decades === 0) return;
    this.setTargetScale(this.target * 10 ** decades);
  }

  /**
   * Subscribe. Returns unsubscribe.
   * Fires on every interpolated tick where `current` actually moved.
   * Listeners must be cheap or self-quantize — this is a continuum, not a bus.
   */
  onScaleChanged(fn: ScaleListener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  /**
   * Advance the interpolator in log10-space.
   * @param delta seconds, already clamped by the frame loop
   */
  update(delta: number): void {
    if (delta <= 0) return;

    const logC = Math.log10(this.current);
    const logT = Math.log10(this.target);
    if (logC === logT) {
      if (this.current !== this.target) {
        this.current = this.target;
        this.emit();
      }
      return;
    }

    const t = 1 - Math.exp(-this.rate * delta);
    const nextLog = logC + (logT - logC) * t;
    let next = 10 ** nextLog;

    if (Math.abs(logT - nextLog) < 1e-5) next = this.target;

    if (next !== this.current) {
      this.current = next;
      this.emit();
    }
  }

  private clamp(value: number): number {
    return Math.min(this.maxScale, Math.max(this.minScale, value));
  }

  private capture(): ScaleSample {
    const band = bandFromScale(this.current);
    return {
      current: this.current,
      target: this.target,
      log10: Math.log10(this.current),
      band: band.id,
      label: band.label,
    };
  }

  private emit(): void {
    const sample = this.capture();
    for (const fn of this.listeners) fn(sample);
  }
}
