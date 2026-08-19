import * as THREE from "three";
import { cellularPresence, molecularPresence, nanoPresence, tissueDepth, tissuePresence } from "./ScaleManager";
import { freezeStatic } from "./freezeStatic";
import type { TwinLandmarks } from "./MacroTwin";

export type CellKind = "myocyte" | "perivascular" | "stromal";

/**
 * Placement token for CellularLayer. Position is already in tissue,
 * axis is the local long axis (fiber / vessel / trabecular).
 * Treat as immutable.
 */
export interface CellAnchor {
  readonly position: THREE.Vector3;
  readonly axis: THREE.Vector3;
  readonly kind: CellKind;
}

export type VesselClass =
  | "aorta"
  | "cava"
  | "iliac"
  | "femoral"
  | "carotid"
  | "brachial";

export interface TissueSample {
  vesselDist: number;
  vesselClass: VesselClass | null;
  /** 0–1 load index from spine / femoral corridors. */
  load: number;
  loadKPa: number;
  ecmIndex: number;
}

interface VesselSite {
  p: THREE.Vector3;
  axis: THREE.Vector3;
  cls: VesselClass;
}

/**
 * Tissue structural field. No flow. No FEM.
 * Cell sites are emitted via getCellAnchors(); CellularLayer owns the cells.
 *
 * Attaches to MacroTwin.getLandmarks(). Subscribes to ScaleManager via
 * the integrator (main.ts). This file must never be imported by ScaleManager.
 *
 * Built once. Revealed in place:
 *   ECM-0 / arterial trunks / IVC–SVC     fade with tissuePresence
 *   ECM-1 / limb + neck branches          fade with mid depth
 *   ECM-2 / fine cross-links + distal     fade toward 0.01
 *
 * Science, abstracted to the landmark set:
 *   ECM     — myofascial / collagen orientation (longitudinal, ±oblique, hoop)
 *   Vessels — adult routing: left-sided descending aorta, right-sided IVC,
 *             L4 bifurcation, femoral → popliteal, carotids, brachial
 *             Radii follow Murray’s law (r³ parent ≈ Σ r³ children) at
 *             the iliac split. Tubes are holographic, not lumens.
 *   Diff    — Fick-like exp(−r/λ) from vessel samples. Not a PDE.
 *   Mech    — Wolff / axial-load ticks on spine + femora + tibiae.
 *
 * Materials: LineBasicMaterial + PointsMaterial only. Monochrome.
 */

const H = 16;

type FieldMask = 0 | 1 | 2 | 3;

export class TissueLayer {
  readonly group = new THREE.Group();

  private readonly ecm0 = new THREE.Group();
  private readonly ecm1 = new THREE.Group();
  private readonly ecm2 = new THREE.Group();
  private readonly artTrunk = new THREE.Group();
  private readonly artBranch = new THREE.Group();
  private readonly veinTrunk = new THREE.Group();
  private readonly veinBranch = new THREE.Group();
  private readonly diffGroup = new THREE.Group();
  private readonly mechGroup = new THREE.Group();

  private readonly ecmPriMat = lineMat(0xf2f2f2, 0);
  private readonly ecmSecMat = lineMat(0x8a8a8a, 0);
  private readonly ecmFineMat = lineMat(0x6a6a6a, 0);
  private readonly artMat = lineMat(0xffffff, 0);
  private readonly artDimMat = lineMat(0xc4c4c4, 0);
  private readonly veinMat = lineMat(0x9a9a9a, 0);
  private readonly veinDimMat = lineMat(0x6e6e6e, 0);
  private readonly diffLineMat = lineMat(0xb0b0b0, 0);
  private readonly diffPtMat = new THREE.PointsMaterial({
    color: 0x888888,
    size: 0.045,
    sizeAttenuation: true,
    transparent: true,
    opacity: 0,
    fog: true,
  });
  private readonly mechMat = lineMat(0xd8d8d8, 0);

  /** bit1 = diffusion, bit0 = mechanical. 3 = both on. */
  private fieldMask: FieldMask = 3;

  private readonly anchors: CellAnchor[] = [];
  private readonly vesselSites: VesselSite[] = [];
  private readonly lm: TwinLandmarks;
  private lastScale = 1;
  private scanStructure = 1;
  private scanVascular = 1;
  private scanFields = 1;

  constructor(scene: THREE.Scene, lm: TwinLandmarks) {
    this.lm = lm;
    this.group.name = "TissueLayer";
    this.group.visible = false;
    for (const g of [
      this.ecm0, this.ecm1, this.ecm2,
      this.artTrunk, this.artBranch,
      this.veinTrunk, this.veinBranch,
      this.diffGroup, this.mechGroup,
    ]) {
      this.group.add(g);
    }
    scene.add(this.group);
    this.build(lm);
    freezeStatic(this.group);
  }

  /**
   * ScaleManager drive. Safe every frame.
   * Geometry is static. Only opacities and visibility change.
   */
  syncScale(scale: number): void {
    this.lastScale = scale;
    this.applyLook();
  }

  setScanGains(structure: number, vascular: number, fields: number): void {
    this.scanStructure = structure;
    this.scanVascular = vascular;
    this.scanFields = fields;
    this.applyLook();
  }

  /**
   * Local tissue readout at p. Vessel class is the nearest tagged trunk.
   * Load is an influence field from spine + femoral corridors (not a FEM).
   */
  sampleAt(p: THREE.Vector3): TissueSample {
    let vDist = Infinity;
    let vCls: VesselClass | null = null;
    for (const s of this.vesselSites) {
      const d = p.distanceTo(s.p);
      if (d < vDist) {
        vDist = d;
        vCls = s.cls;
      }
    }
    if (vDist > 2.4) vCls = null;

    const load = this.sampleLoad(p);
    let aDist = Infinity;
    for (const a of this.anchors) {
      const d = p.distanceTo(a.position);
      if (d < aDist) aDist = d;
    }

    return {
      vesselDist: vDist,
      vesselClass: vCls,
      load,
      loadKPa: 18 + load * 165,
      ecmIndex: THREE.MathUtils.clamp(1 - aDist / 0.85, 0, 1),
    };
  }

  nearestVesselAxis(p: THREE.Vector3): THREE.Vector3 | null {
    let best: VesselSite | null = null;
    let bestD = Infinity;
    for (const s of this.vesselSites) {
      const d = p.distanceTo(s.p);
      if (d < bestD) {
        bestD = d;
        best = s;
      }
    }
    return best && bestD < 2.4 ? best.axis : null;
  }

  private applyLook(): void {
    const scale = this.lastScale;
    const p = tissuePresence(scale);
    const d = tissueDepth(scale);
    const g = -Math.log10(Math.max(scale, 1e-12));

    this.group.visible = p > 0.012;
    if (!this.group.visible) return;

    const mid = THREE.MathUtils.smoothstep(g, 0.55, 1.15);
    const fine = THREE.MathUtils.smoothstep(g, 0.95, 1.70);
    const field = THREE.MathUtils.smoothstep(g, 0.50, 1.05);
    const cp = cellularPresence(scale);
    const mp = molecularPresence(scale);
    const np = nanoPresence(scale);
    const yieldVol = (1 - 0.62 * cp) * (1 - 0.35 * mp) * (1 - 0.18 * np);
    const yieldFrame = (1 - 0.28 * cp) * (1 - 0.15 * mp) * (1 - 0.10 * np);
    const gs = this.scanStructure;
    const gv = this.scanVascular;
    const gf = this.scanFields;

    this.ecmPriMat.opacity = 0.78 * p * yieldFrame * gs;
    this.ecmSecMat.opacity = 0.42 * p * (0.35 + 0.65 * mid) * yieldVol * gs;
    this.ecmFineMat.opacity = 0.32 * p * fine * (1 - 0.88 * cp) * gs;

    this.artMat.opacity = 0.94 * p * yieldFrame * gv;
    this.artDimMat.opacity = 0.62 * p * (0.25 + 0.75 * mid) * yieldVol * gv;
    this.veinMat.opacity = 0.70 * p * yieldFrame * gv;
    this.veinDimMat.opacity = 0.48 * p * (0.25 + 0.75 * mid) * yieldVol * gv;

    const reveal = gf > 1.01;
    const diffOn = reveal || (this.fieldMask & 2) !== 0;
    const mechOn = reveal || (this.fieldMask & 1) !== 0;
    this.diffLineMat.opacity = 0.28 * p * field * (diffOn ? 1 : 0) * (1 - 0.80 * cp) * gf;
    this.diffPtMat.opacity = 0.40 * p * field * (diffOn ? 1 : 0) * (1 - 0.85 * cp) * gf;
    this.diffPtMat.size = THREE.MathUtils.clamp(0.028 + 0.022 * (1 - d), 0.026, 0.05);
    this.mechMat.opacity = 0.55 * p * field * (mechOn ? 1 : 0) * (1 - 0.55 * cp) * gf;

    this.diffGroup.visible = diffOn && field > 0.02;
    this.mechGroup.visible = mechOn && field > 0.02;
  }

  /** Caudal spine carries more axial load. Femoral mid-shaft peaks (bending). */
  private sampleLoad(p: THREE.Vector3): number {
    let acc = 0;
    const verts = this.lm.vertebrae;
    const n = verts.length;
    for (let i = 0; i < n; i++) {
      const load = 0.35 + 0.65 * (1 - i / Math.max(n - 1, 1));
      const d = p.distanceTo(verts[i]);
      acc = Math.max(acc, load * Math.exp(-d / 0.38));
    }
    acc = Math.max(acc, this.segLoad(p, this.lm.hipR, this.lm.kneeR));
    acc = Math.max(acc, this.segLoad(p, this.lm.hipL, this.lm.kneeL));
    acc = Math.max(acc, this.segLoad(p, this.lm.kneeR, this.lm.ankleR) * 0.75);
    acc = Math.max(acc, this.segLoad(p, this.lm.kneeL, this.lm.ankleL) * 0.75);
    return THREE.MathUtils.clamp(acc, 0, 1);
  }

  private segLoad(p: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3): number {
    const ab = new THREE.Vector3().subVectors(b, a);
    const len = ab.length();
    if (len < 1e-6) return 0;
    const t = THREE.MathUtils.clamp(
      new THREE.Vector3().subVectors(p, a).dot(ab) / (len * len),
      0,
      1,
    );
    const closest = new THREE.Vector3().lerpVectors(a, b, t);
    const load = 0.55 + 0.40 * Math.sin(t * Math.PI);
    return load * Math.exp(-p.distanceTo(closest) / 0.32);
  }

  /** F-key cycle: BOTH → DIFF → MECH → OFF → BOTH. Not a tool. */
  cycleFields(): FieldMask {
    this.fieldMask = ((this.fieldMask + 3) % 4) as FieldMask;
    return this.fieldMask;
  }

  fieldLabel(): string {
    switch (this.fieldMask) {
      case 3: return "DIFF:ON   MECH:ON";
      case 2: return "DIFF:ON   MECH:OFF";
      case 1: return "DIFF:OFF  MECH:ON";
      default: return "DIFF:OFF  MECH:OFF";
    }
  }

  /**
   * Frozen cell-site table. Same identity for the life of the layer.
   * CellularLayer consumes this; it does not invent a second body.
   */
  getCellAnchors(): readonly CellAnchor[] {
    return this.anchors;
  }

  dispose(): void {
    this.wipe(this.group);
    for (const m of [
      this.ecmPriMat, this.ecmSecMat, this.ecmFineMat,
      this.artMat, this.artDimMat, this.veinMat, this.veinDimMat,
      this.diffLineMat, this.diffPtMat, this.mechMat,
    ]) {
      m.dispose();
    }
    this.group.removeFromParent();
  }

  private build(lm: TwinLandmarks): void {
    this.collectAnchors(lm);
    const stations = torsoStations(lm);
    const vessels = this.buildVessels(lm);

    this.addLines(this.ecm0, this.buildEcmPrimary(lm, stations), this.ecmPriMat);
    this.addLines(this.ecm1, this.buildEcmSecondary(lm, stations), this.ecmSecMat);
    this.addLines(this.ecm2, this.buildEcmFine(lm, stations), this.ecmFineMat);

    this.addLines(this.artTrunk, vessels.artTrunk, this.artMat);
    this.addLines(this.artBranch, vessels.artBranch, this.artDimMat);
    this.addLines(this.veinTrunk, vessels.veinTrunk, this.veinMat);
    this.addLines(this.veinBranch, vessels.veinBranch, this.veinDimMat);

    const { lines, points } = this.buildDiffusion(lm, vessels.sources);
    this.addLines(this.diffGroup, lines, this.diffLineMat);
    this.diffGroup.add(new THREE.Points(points.geometry(), this.diffPtMat));

    this.addLines(this.mechGroup, this.buildMechanical(lm), this.mechMat);
  }

  private notePath(
    path: THREE.Vector3[],
    n: number,
    cls: VesselClass,
    sources: THREE.Vector3[],
  ): void {
    samplePath(path, n, sources);
    if (path.length < 2) return;
    for (let i = 0; i < n; i++) {
      const t = i / Math.max(n - 1, 1);
      const idx = t * (path.length - 1);
      const i0 = Math.floor(idx);
      const i1 = Math.min(path.length - 1, i0 + 1);
      const f = idx - i0;
      const p = new THREE.Vector3().lerpVectors(path[i0], path[i1], f);
      const axis = new THREE.Vector3().subVectors(path[i1], path[i0]);
      if (axis.lengthSq() < 1e-10) axis.set(0, 1, 0);
      else axis.normalize();
      this.vesselSites.push({ p, axis, cls });
    }
  }

  /**
   * Inspectable clusters, not a packed organ.
   * Myocytes sit in fascicles along load axes.
   * Perivascular cells line the aortic / femoral corridors (outside the lumen).
   * Stromal cells mark vertebrae and pelvic brim.
   */
  private collectAnchors(lm: TwinLandmarks): void {
    this.anchors.length = 0;

    const femurR = new THREE.Vector3().subVectors(lm.kneeR, lm.hipR).normalize();
    const femurL = new THREE.Vector3().subVectors(lm.kneeL, lm.hipL).normalize();
    const tibiaR = new THREE.Vector3().subVectors(lm.ankleR, lm.kneeR).normalize();
    const tibiaL = new THREE.Vector3().subVectors(lm.ankleL, lm.kneeL).normalize();
    const humR = new THREE.Vector3().subVectors(lm.elbowR, lm.shoulderR).normalize();
    const humL = new THREE.Vector3().subVectors(lm.elbowL, lm.shoulderL).normalize();
    const foreR = new THREE.Vector3().subVectors(lm.wristR, lm.elbowR).normalize();
    const foreL = new THREE.Vector3().subVectors(lm.wristL, lm.elbowL).normalize();

    // Quadriceps / hamstring fascicles — two inspectable sites per thigh.
    this.hexFascicle(lerp(lm.hipR, lm.kneeR, 0.42).setZ(lm.hipR.z + 0.24), femurR, 0.13, "myocyte", 7);
    this.hexFascicle(lerp(lm.hipL, lm.kneeL, 0.42).setZ(lm.hipL.z + 0.24), femurL, 0.13, "myocyte", 7);
    this.hexFascicle(lerp(lm.hipR, lm.kneeR, 0.62).setZ(lm.hipR.z - 0.20), femurR, 0.11, "myocyte", 5);
    this.hexFascicle(lerp(lm.hipL, lm.kneeL, 0.62).setZ(lm.hipL.z - 0.20), femurL, 0.11, "myocyte", 5);

    this.hexFascicle(lerp(lm.kneeR, lm.ankleR, 0.45).setZ(lm.kneeR.z + 0.14), tibiaR, 0.10, "myocyte", 5);
    this.hexFascicle(lerp(lm.kneeL, lm.ankleL, 0.45).setZ(lm.kneeL.z + 0.14), tibiaL, 0.10, "myocyte", 5);

    this.hexFascicle(lerp(lm.shoulderR, lm.elbowR, 0.50), humR, 0.10, "myocyte", 5);
    this.hexFascicle(lerp(lm.shoulderL, lm.elbowL, 0.50), humL, 0.10, "myocyte", 5);
    this.hexFascicle(lerp(lm.elbowR, lm.wristR, 0.48), foreR, 0.08, "myocyte", 5);
    this.hexFascicle(lerp(lm.elbowL, lm.wristL, 0.48), foreL, 0.08, "myocyte", 5);

    // Rectus / erector corridors.
    const cran = new THREE.Vector3(0, 1, 0);
    this.hexFascicle(new THREE.Vector3(0.22, (lm.sternalNotch.y + lm.xiphoid.y) * 0.5, 0.38), cran, 0.10, "myocyte", 5);
    this.hexFascicle(new THREE.Vector3(-0.22, (lm.sternalNotch.y + lm.xiphoid.y) * 0.5, 0.38), cran, 0.10, "myocyte", 5);
    this.hexFascicle(new THREE.Vector3(0.18, (lm.xiphoid.y + lm.asisL.y) * 0.5, -0.28), cran, 0.10, "myocyte", 5);
    this.hexFascicle(new THREE.Vector3(-0.18, (lm.xiphoid.y + lm.asisL.y) * 0.5, -0.28), cran, 0.10, "myocyte", 5);

    // Perivascular: outside the aortic / femoral lumen.
    const t4 = Math.min(13, lm.vertebrae.length - 1);
    for (let i = t4; i >= 2; i -= 2) {
      const v = lm.vertebrae[i];
      this.anchors.push({
        position: new THREE.Vector3(0.11 + 0.22, v.y, v.z + 0.18),
        axis: new THREE.Vector3(0, -1, 0),
        kind: "perivascular",
      });
    }
    this.stringAlong(lm.hipR, lm.kneeR, 5, new THREE.Vector3(0.16, 0, 0.12), "perivascular");
    this.stringAlong(lm.hipL, lm.kneeL, 5, new THREE.Vector3(-0.16, 0, 0.12), "perivascular");
    this.stringAlong(lm.shoulderR, lm.elbowR, 3, new THREE.Vector3(0.10, 0, 0.06), "perivascular");
    this.stringAlong(lm.shoulderL, lm.elbowL, 3, new THREE.Vector3(-0.10, 0, 0.06), "perivascular");

    // Stromal: vertebral periosteum + pelvic brim.
    for (let i = 0; i < lm.vertebrae.length; i += 3) {
      const v = lm.vertebrae[i];
      this.anchors.push({
        position: new THREE.Vector3(v.x + 0.18, v.y, v.z + 0.06),
        axis: new THREE.Vector3(0, 1, 0),
        kind: "stromal",
      });
    }
    this.anchors.push({
      position: lm.asisR.clone().add(new THREE.Vector3(-0.08, 0.06, 0.06)),
      axis: new THREE.Vector3(1, 0, 0),
      kind: "stromal",
    });
    this.anchors.push({
      position: lm.asisL.clone().add(new THREE.Vector3(0.08, 0.06, 0.06)),
      axis: new THREE.Vector3(1, 0, 0),
      kind: "stromal",
    });
    this.anchors.push({
      position: mid(lm.hipL, lm.hipR).add(new THREE.Vector3(0, 0.05, 0.16)),
      axis: new THREE.Vector3(1, 0, 0),
      kind: "stromal",
    });
  }

  private hexFascicle(
    center: THREE.Vector3,
    axis: THREE.Vector3,
    radius: number,
    kind: CellKind,
    count: 5 | 7,
  ): void {
    const a = axis.clone().normalize();
    const right = new THREE.Vector3();
    const up = new THREE.Vector3();
    basis(a, right, up);
    this.anchors.push({ position: center.clone(), axis: a.clone(), kind });
    const ring = count - 1;
    for (let i = 0; i < ring; i++) {
      const th = (i / ring) * Math.PI * 2;
      this.anchors.push({
        position: offset(center, right, up, Math.cos(th) * radius, Math.sin(th) * radius),
        axis: a.clone(),
        kind,
      });
    }
  }

  private stringAlong(
    a: THREE.Vector3,
    b: THREE.Vector3,
    n: number,
    off: THREE.Vector3,
    kind: CellKind,
  ): void {
    const axis = new THREE.Vector3().subVectors(b, a).normalize();
    for (let i = 1; i <= n; i++) {
      const t = i / (n + 1);
      this.anchors.push({
        position: new THREE.Vector3().lerpVectors(a, b, t).add(off),
        axis: axis.clone(),
        kind,
      });
    }
  }

  // ── ECM ──────────────────────────────────────────────────────────

  /**
   * Primary collagen / myofascial meridians.
   * Superficial front + back lines, limb axes, nuchal strap.
   */
  private buildEcmPrimary(lm: TwinLandmarks, stations: Station[]): LineSoup {
    const s = new LineSoup();
    const meridians = 10;

    // Torso longitudinal (erector / rectus corridors).
    for (let m = 0; m < meridians; m++) {
      const th = (m / meridians) * Math.PI * 2;
      const pts: THREE.Vector3[] = [];
      const y0 = stations[0].y;
      const y1 = stations[stations.length - 1].y;
      const steps = 14;
      for (let i = 0; i <= steps; i++) {
        const y = y0 + ((y1 - y0) * i) / steps;
        pts.push(torsoOn(stations, y, th, 0.97));
      }
      s.polyline(pts);
    }

    // Superficial back line: vertex → nuchal → spine → hamstring → plantar.
    const sbl: THREE.Vector3[] = [
      lm.vertex.clone(),
      lm.skull.clone().setZ(lm.skull.z - 0.35),
      lm.c7.clone(),
      ...lm.vertebrae.slice().reverse(),
      mid(lm.hipL, lm.hipR).add(new THREE.Vector3(0, -0.1, -0.15)),
    ];
    s.polyline(sbl);
    s.polyline([lm.hipR.clone().setZ(lm.hipR.z - 0.12), lm.kneeR.clone().setZ(lm.kneeR.z - 0.18), lm.heelR]);
    s.polyline([lm.hipL.clone().setZ(lm.hipL.z - 0.12), lm.kneeL.clone().setZ(lm.kneeL.z - 0.18), lm.heelL]);
    s.segV(lm.heelR, lm.toeR);
    s.segV(lm.heelL, lm.toeL);

    // Superficial front line: sternal → rectus → quads.
    s.polyline([
      lm.sternalNotch,
      lm.xiphoid,
      mid(lm.asisL, lm.asisR).setZ(0.28),
      mid(lm.hipL, lm.hipR).setZ(0.18),
    ]);
    s.polyline([lm.hipR.clone().setZ(lm.hipR.z + 0.16), lm.kneeR.clone().setZ(lm.kneeR.z + 0.14), lm.ankleR]);
    s.polyline([lm.hipL.clone().setZ(lm.hipL.z + 0.16), lm.kneeL.clone().setZ(lm.kneeL.z + 0.14), lm.ankleL]);

    // Limb axes (deep fascia along bone).
    s.polyline([lm.shoulderR, lm.elbowR, lm.wristR]);
    s.polyline([lm.shoulderL, lm.elbowL, lm.wristL]);
    s.polyline([lm.hipR, lm.kneeR, lm.ankleR]);
    s.polyline([lm.hipL, lm.kneeL, lm.ankleL]);

    return s;
  }

  /**
   * Secondary hoop + ±oblique. External/internal oblique cross at ~30°.
   * Circumferential wraps are the hoop-stress family (thoracolumbar fascia).
   */
  private buildEcmSecondary(lm: TwinLandmarks, stations: Station[]): LineSoup {
    const s = new LineSoup();
    const y0 = stations[0].y;
    const y1 = stations[stations.length - 1].y;

    // Hoop fibers.
    const hoops = 9;
    for (let i = 0; i < hoops; i++) {
      const y = y0 + ((y1 - y0) * (i + 0.5)) / hoops;
      const st = sampleStation(stations, y);
      const segs = 20;
      const ring: THREE.Vector3[] = [];
      for (let k = 0; k <= segs; k++) {
        const th = (k / segs) * Math.PI * 2;
        ring.push(new THREE.Vector3(
          Math.cos(th) * st.rx * 0.98,
          y,
          st.cz + Math.sin(th) * st.rz * 0.98,
        ));
      }
      s.polyline(ring);
    }

    // Oblique sheets: +θ and −θ, left/right opposite (actual EO/IO).
    const oblMer = 8;
    const ySteps = 10;
    for (const sign of [1, -1]) {
      for (let m = 0; m < oblMer; m++) {
        const th0 = (m / oblMer) * Math.PI * 2;
        const pts: THREE.Vector3[] = [];
        for (let i = 0; i <= ySteps; i++) {
          const t = i / ySteps;
          const y = y0 + (y1 - y0) * t;
          const th = th0 + sign * t * 1.15;
          pts.push(torsoOn(stations, y, th, 0.99));
        }
        s.polyline(pts);
      }
    }

    // Limb helical fascia (collagen in epimysium is helical).
    this.wrapLimb(s, lm.shoulderR, lm.elbowR, 0.30, 5, 7, 1);
    this.wrapLimb(s, lm.elbowR, lm.wristR, 0.18, 4, 6, -1);
    this.wrapLimb(s, lm.shoulderL, lm.elbowL, 0.30, 5, 7, -1);
    this.wrapLimb(s, lm.elbowL, lm.wristL, 0.18, 4, 6, 1);
    this.wrapLimb(s, lm.hipR, lm.kneeR, 0.40, 6, 8, 1);
    this.wrapLimb(s, lm.kneeR, lm.ankleR, 0.22, 5, 7, -1);
    this.wrapLimb(s, lm.hipL, lm.kneeL, 0.40, 6, 8, -1);
    this.wrapLimb(s, lm.kneeL, lm.ankleL, 0.22, 5, 7, 1);

    // Thigh intermuscular septa (anterior / medial / posterior compartments).
    this.septum(s, lm.hipR, lm.kneeR, 3);
    this.septum(s, lm.hipL, lm.kneeL, 3);

    return s;
  }

  /** Fine cross-links. Visible only near cellular approach. Not cells. */
  private buildEcmFine(lm: TwinLandmarks, stations: Station[]): LineSoup {
    const s = new LineSoup();
    const mer = 16;
    const y0 = stations[0].y;
    const y1 = stations[stations.length - 1].y;
    const steps = 16;

    for (let m = 0; m < mer; m++) {
      const th = (m / mer) * Math.PI * 2;
      const th2 = ((m + 1) / mer) * Math.PI * 2;
      for (let i = 0; i < steps; i++) {
        if (((i + m) & 1) === 1) continue;
        const yA = y0 + ((y1 - y0) * i) / steps;
        const yB = y0 + ((y1 - y0) * (i + 1)) / steps;
        s.segV(torsoOn(stations, yA, th, 0.96), torsoOn(stations, yB, th2, 0.96));
      }
    }

    // Cranial galea: sagittal + coronal straps.
    const galea = lm.skull;
    s.seg(galea.x, galea.y + 0.55, galea.z - 0.4, galea.x, galea.y + 0.55, galea.z + 0.55);
    s.seg(galea.x - 0.7, galea.y + 0.35, galea.z, galea.x + 0.7, galea.y + 0.35, galea.z);
    s.segV(lm.vertex, lm.c7);

    // Distal limb cross-links.
    this.wrapLimb(s, lm.wristR, lm.wristR.clone().add(new THREE.Vector3(-0.05, -0.15, 0.2)), 0.12, 3, 5, 1);
    this.wrapLimb(s, lm.wristL, lm.wristL.clone().add(new THREE.Vector3(+0.05, -0.15, 0.2)), 0.12, 3, 5, -1);

    return s;
  }

  private wrapLimb(
    s: LineSoup,
    a: THREE.Vector3,
    b: THREE.Vector3,
    radius: number,
    strands: number,
    turns: number,
    sign: number,
  ): void {
    const axis = new THREE.Vector3().subVectors(b, a);
    const len = axis.length();
    if (len < 1e-4) return;
    axis.multiplyScalar(1 / len);
    const right = new THREE.Vector3();
    const up = new THREE.Vector3();
    basis(axis, right, up);
    const segs = 10;
    for (let k = 0; k < strands; k++) {
      const pts: THREE.Vector3[] = [];
      const phase = (k / strands) * Math.PI * 2;
      for (let i = 0; i <= segs; i++) {
        const t = i / segs;
        const ang = phase + sign * t * turns;
        const c = new THREE.Vector3().lerpVectors(a, b, t);
        pts.push(offset(c, right, up, Math.cos(ang) * radius, Math.sin(ang) * radius));
      }
      s.polyline(pts);
    }
  }

  private septum(s: LineSoup, a: THREE.Vector3, b: THREE.Vector3, planes: number): void {
    const axis = new THREE.Vector3().subVectors(b, a);
    const len = axis.length();
    if (len < 1e-4) return;
    axis.multiplyScalar(1 / len);
    const right = new THREE.Vector3();
    const up = new THREE.Vector3();
    basis(axis, right, up);
    const r = 0.38;
    for (let p = 0; p < planes; p++) {
      const ang = (p / planes) * Math.PI;
      const dir = offset(new THREE.Vector3(), right, up, Math.cos(ang), Math.sin(ang));
      const steps = 5;
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const c = new THREE.Vector3().lerpVectors(a, b, t);
        s.seg(
          c.x - dir.x * r, c.y - dir.y * r, c.z - dir.z * r,
          c.x + dir.x * r, c.y + dir.y * r, c.z + dir.z * r,
        );
      }
    }
  }

  // ── Vessels ──────────────────────────────────────────────────────

  private buildVessels(lm: TwinLandmarks): {
    artTrunk: LineSoup;
    artBranch: LineSoup;
    veinTrunk: LineSoup;
    veinBranch: LineSoup;
    sources: THREE.Vector3[];
  } {
    const artTrunk = new LineSoup();
    const artBranch = new LineSoup();
    const veinTrunk = new LineSoup();
    const veinBranch = new LineSoup();
    const sources: THREE.Vector3[] = [];

    const heart = new THREE.Vector3(
      0.22,
      lm.xiphoid.y + (lm.sternalNotch.y - lm.xiphoid.y) * 0.42,
      0.30,
    );
    const l4 = lm.vertebrae[Math.min(1, lm.vertebrae.length - 1)];
    const bifurc = new THREE.Vector3(0.02, l4.y, l4.z + 0.20);

    const rAorta = 0.16;
    const rIliac = rAorta * 0.79; // Murray, equal split
    const rFem = rIliac * 0.85;
    const rCava = 0.19;

    // Ascending aorta + arch (left-sided descent).
    const arch: THREE.Vector3[] = [
      heart.clone(),
      new THREE.Vector3(0.10, lm.sternalNotch.y - 0.05, 0.22),
      new THREE.Vector3(0.02, lm.sternalNotch.y + 0.28, 0.04),
      new THREE.Vector3(0.18, lm.sternalNotch.y + 0.42, -0.10),
    ];

    // Descending aorta: left of midline, anterior to vertebral bodies.
    const desc: THREE.Vector3[] = [];
    const t4 = Math.min(13, lm.vertebrae.length - 1);
    for (let i = t4; i >= 1; i--) {
      const v = lm.vertebrae[i];
      desc.push(new THREE.Vector3(0.11, v.y, v.z + 0.18));
    }
    desc.push(bifurc.clone());

    const aorta = catmull([...arch, ...desc], 4);
    tube(artTrunk, aorta, rAorta, 6);
    this.notePath(aorta, 18, "aorta", sources);

    // Common iliacs → femoral → popliteal → tibial.
    const iliacR = catmull([
      bifurc,
      new THREE.Vector3(lm.hipR.x * 0.45, bifurc.y - 0.15, 0.16),
      new THREE.Vector3(lm.hipR.x * 0.85, lm.hipR.y + 0.05, 0.12),
    ], 4);
    const iliacL = catmull([
      bifurc,
      new THREE.Vector3(lm.hipL.x * 0.45, bifurc.y - 0.15, 0.16),
      new THREE.Vector3(lm.hipL.x * 0.85, lm.hipL.y + 0.05, 0.12),
    ], 4);
    tube(artTrunk, iliacR, rIliac, 5);
    tube(artTrunk, iliacL, rIliac, 5);
    this.notePath(iliacR, 4, "iliac", sources);
    this.notePath(iliacL, 4, "iliac", sources);

    const femR = catmull([
      iliacR[iliacR.length - 1],
      new THREE.Vector3(lm.hipR.x * 0.9, (lm.hipR.y + lm.kneeR.y) * 0.5, 0.14),
      new THREE.Vector3(lm.kneeR.x, lm.kneeR.y + 0.15, 0.10),
      new THREE.Vector3(lm.kneeR.x, lm.kneeR.y - 0.05, -0.08),
      new THREE.Vector3(lm.ankleR.x, (lm.kneeR.y + lm.ankleR.y) * 0.5, -0.04),
      lm.ankleR.clone(),
    ], 4);
    const femL = catmull([
      iliacL[iliacL.length - 1],
      new THREE.Vector3(lm.hipL.x * 0.9, (lm.hipL.y + lm.kneeL.y) * 0.5, 0.14),
      new THREE.Vector3(lm.kneeL.x, lm.kneeL.y + 0.15, 0.10),
      new THREE.Vector3(lm.kneeL.x, lm.kneeL.y - 0.05, -0.08),
      new THREE.Vector3(lm.ankleL.x, (lm.kneeL.y + lm.ankleL.y) * 0.5, -0.04),
      lm.ankleL.clone(),
    ], 4);
    tube(artTrunk, femR.slice(0, Math.floor(femR.length * 0.45)), rFem, 5);
    tube(artTrunk, femL.slice(0, Math.floor(femL.length * 0.45)), rFem, 5);
    artBranch.polyline(femR);
    artBranch.polyline(femL);
    this.notePath(femR, 8, "femoral", sources);
    this.notePath(femL, 8, "femoral", sources);

    // Carotids + subclavian / brachial.
    const archApex = arch[arch.length - 1];
    const carR = catmull([
      new THREE.Vector3(0.00, archApex.y - 0.05, 0.00),
      new THREE.Vector3(-0.22, lm.c7.y + 0.15, 0.06),
      new THREE.Vector3(-0.28, lm.chin.y, 0.08),
      new THREE.Vector3(-0.32, lm.skull.y - 0.15, 0.10),
    ], 4);
    const carL = catmull([
      archApex,
      new THREE.Vector3(0.22, lm.c7.y + 0.15, 0.06),
      new THREE.Vector3(0.28, lm.chin.y, 0.08),
      new THREE.Vector3(0.32, lm.skull.y - 0.15, 0.10),
    ], 4);
    tube(artBranch, carR, 0.055, 4);
    tube(artBranch, carL, 0.055, 4);

    const armR = catmull([
      new THREE.Vector3(-0.15, archApex.y - 0.08, -0.02),
      lm.shoulderR.clone(),
      lm.elbowR.clone(),
      lm.wristR.clone(),
    ], 4);
    const armL = catmull([
      archApex,
      lm.shoulderL.clone(),
      lm.elbowL.clone(),
      lm.wristL.clone(),
    ], 4);
    artBranch.polyline(armR);
    artBranch.polyline(armL);
    tube(artBranch, armR.slice(0, 8), 0.06, 4);
    tube(artBranch, armL.slice(0, 8), 0.06, 4);
    this.notePath(armR, 6, "brachial", sources);
    this.notePath(armL, 6, "brachial", sources);
    this.notePath(carR, 4, "carotid", sources);
    this.notePath(carL, 4, "carotid", sources);

    // IVC (right of midline) + iliac / femoral veins.
    const ivcPts: THREE.Vector3[] = [
      new THREE.Vector3(-0.12, bifurc.y, 0.18),
    ];
    for (let i = 1; i <= t4; i++) {
      const v = lm.vertebrae[i];
      ivcPts.push(new THREE.Vector3(-0.13, v.y, v.z + 0.20));
    }
    ivcPts.push(new THREE.Vector3(-0.06, heart.y - 0.05, 0.24));
    ivcPts.push(heart.clone().setX(0.06));
    const ivc = catmull(ivcPts, 3);
    tube(veinTrunk, ivc, rCava, 6);
    this.notePath(ivc, 14, "cava", sources);

    // SVC: jugulars + brachiocephalic confluence.
    const svc = catmull([
      new THREE.Vector3(-0.18, lm.chin.y, 0.10),
      new THREE.Vector3(-0.12, lm.sternalNotch.y + 0.2, 0.14),
      new THREE.Vector3(0.04, lm.sternalNotch.y - 0.15, 0.22),
      heart.clone().setX(0.08),
    ], 4);
    const svcL = catmull([
      new THREE.Vector3(0.18, lm.chin.y, 0.10),
      new THREE.Vector3(0.12, lm.sternalNotch.y + 0.2, 0.14),
      new THREE.Vector3(0.04, lm.sternalNotch.y - 0.15, 0.22),
    ], 3);
    tube(veinTrunk, svc, 0.12, 5);
    veinBranch.polyline(svcL);
    this.notePath(svc, 6, "cava", sources);

    const vFemR = offsetPath(femR, new THREE.Vector3(0.05, 0, 0.04));
    const vFemL = offsetPath(femL, new THREE.Vector3(-0.05, 0, 0.04));
    veinBranch.polyline(vFemR);
    veinBranch.polyline(vFemL);
    tube(veinTrunk, vFemR.slice(0, Math.floor(vFemR.length * 0.4)), 0.10, 4);
    tube(veinTrunk, vFemL.slice(0, Math.floor(vFemL.length * 0.4)), 0.10, 4);

    const vArmR = offsetPath(armR, new THREE.Vector3(0.04, 0, 0.03));
    const vArmL = offsetPath(armL, new THREE.Vector3(-0.04, 0, 0.03));
    veinBranch.polyline(vArmR);
    veinBranch.polyline(vArmL);

    return { artTrunk, artBranch, veinTrunk, veinBranch, sources };
  }

  // ── Fields ───────────────────────────────────────────────────────

  /**
   * Diffusion overlay. Isolines in three axial cuts + sparse volume
   * samples weighted by exp(−r/λ) from vessel sources. λ ≈ 0.4 wu (~4.5 cm).
   */
  private buildDiffusion(
    lm: TwinLandmarks,
    sources: THREE.Vector3[],
  ): { lines: LineSoup; points: PointSoup } {
    const lines = new LineSoup();
    const points = new PointSoup();
    const lambda = 0.42;

    const cuts = [
      heartY(lm),
      (lm.xiphoid.y + lm.asisL.y) * 0.5,
      lm.hipL.y + 0.15,
    ];
    for (const y of cuts) {
      for (const iso of [0.55, 0.35, 0.20]) {
        const r = 0.35 + (1 - iso) * 1.15;
        const segs = 28;
        const ring: THREE.Vector3[] = [];
        for (let k = 0; k <= segs; k++) {
          const th = (k / segs) * Math.PI * 2;
          ring.push(new THREE.Vector3(
            Math.cos(th) * r * 0.85,
            y,
            0.08 + Math.sin(th) * r * 0.70,
          ));
        }
        lines.polyline(ring);
      }
    }

    const n = 1600;
    let kept = 0;
    for (let i = 0; i < n * 3 && kept < 1400; i++) {
      const p = new THREE.Vector3(
        (hash(i * 3) - 0.5) * 3.6,
        hash(i * 3 + 1) * (lm.vertex.y - 0.2) + 0.15,
        (hash(i * 3 + 2) - 0.5) * 2.4,
      );
      let field = 0;
      for (let s = 0; s < sources.length; s++) {
        const d = p.distanceTo(sources[s]);
        field += Math.exp(-d / lambda);
      }
      field = Math.min(field, 3) / 3;
      if (field < 0.16) continue;
      points.addV(p);
      kept++;
    }

    return { lines, points };
  }

  /**
   * Mechanical overlay. Not a solve.
   * Caudal vertebrae carry more axial load. Femoral neck + mid-shaft
   * ticks follow Wolff’s compression/tension corridors.
   */
  private buildMechanical(lm: TwinLandmarks): LineSoup {
    const s = new LineSoup();
    const n = lm.vertebrae.length;

    for (let i = 0; i < n; i++) {
      const load = 0.35 + 0.65 * (1 - i / (n - 1));
      const p = lm.vertebrae[i];
      const w = 0.16 + 0.22 * load;
      s.seg(p.x - w, p.y, p.z + 0.04, p.x + w, p.y, p.z + 0.04);
      s.seg(p.x, p.y, p.z + 0.04, p.x, p.y, p.z + 0.04 + 0.18 * load);
    }

    this.boneTicks(s, lm.hipR, lm.kneeR, 0.12, 9);
    this.boneTicks(s, lm.hipL, lm.kneeL, 0.12, 9);
    this.boneTicks(s, lm.kneeR, lm.ankleR, 0.09, 7);
    this.boneTicks(s, lm.kneeL, lm.ankleL, 0.09, 7);

    // Femoral neck abstraction: hip → superior shaft.
    const neckR = new THREE.Vector3().lerpVectors(lm.hipR, lm.kneeR, 0.18);
    neckR.y -= 0.08;
    s.segV(lm.hipR, neckR);
    const neckL = new THREE.Vector3().lerpVectors(lm.hipL, lm.kneeL, 0.18);
    neckL.y -= 0.08;
    s.segV(lm.hipL, neckL);

    // Pelvic hoop (load transfer).
    const inlet = mid(lm.asisL, lm.asisR);
    inlet.y = (lm.asisL.y + lm.hipL.y) * 0.5;
    const xAxis = new THREE.Vector3(1, 0, 0);
    const zAxis = new THREE.Vector3(0, 0, 1);
    ellipse(s, inlet, xAxis, zAxis, 0.095 * H * 0.78, 0.072 * H * 0.62, 20);

    return s;
  }

  private boneTicks(
    s: LineSoup,
    a: THREE.Vector3,
    b: THREE.Vector3,
    half: number,
    count: number,
  ): void {
    const axis = new THREE.Vector3().subVectors(b, a);
    const len = axis.length();
    if (len < 1e-4) return;
    axis.multiplyScalar(1 / len);
    const right = new THREE.Vector3();
    const up = new THREE.Vector3();
    basis(axis, right, up);
    // Compression corridor slightly medial-posterior.
    const dir = offset(new THREE.Vector3(), right, up, 0.65, -0.35);
    dir.normalize();
    for (let i = 1; i < count; i++) {
      const t = i / count;
      const c = new THREE.Vector3().lerpVectors(a, b, t);
      const h = half * (0.7 + 0.5 * Math.sin(t * Math.PI));
      s.seg(
        c.x - dir.x * h, c.y - dir.y * h, c.z - dir.z * h,
        c.x + dir.x * h, c.y + dir.y * h, c.z + dir.z * h,
      );
    }
    s.segV(a, b);
  }

  private addLines(parent: THREE.Group, soup: LineSoup, mat: THREE.LineBasicMaterial): void {
    parent.add(new THREE.LineSegments(soup.geometry(), mat));
  }

  private wipe(g: THREE.Group): void {
    for (const child of [...g.children]) {
      if (child instanceof THREE.Group) {
        this.wipe(child);
        g.remove(child);
        continue;
      }
      g.remove(child);
      if (child instanceof THREE.LineSegments || child instanceof THREE.Points) {
        child.geometry.dispose();
      }
    }
  }
}

// ── local geometry ─────────────────────────────────────────────────

function lineMat(color: number, opacity: number): THREE.LineBasicMaterial {
  return new THREE.LineBasicMaterial({
    color,
    transparent: true,
    opacity,
    fog: true,
  });
}

class LineSoup {
  private readonly v: number[] = [];

  seg(ax: number, ay: number, az: number, bx: number, by: number, bz: number): void {
    this.v.push(ax, ay, az, bx, by, bz);
  }

  segV(a: THREE.Vector3, b: THREE.Vector3): void {
    this.seg(a.x, a.y, a.z, b.x, b.y, b.z);
  }

  polyline(pts: THREE.Vector3[]): void {
    for (let i = 0; i < pts.length - 1; i++) this.segV(pts[i], pts[i + 1]);
  }

  geometry(): THREE.BufferGeometry {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(this.v, 3));
    return geo;
  }
}

class PointSoup {
  private readonly v: number[] = [];

  addV(p: THREE.Vector3): void {
    this.v.push(p.x, p.y, p.z);
  }

  geometry(): THREE.BufferGeometry {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(this.v, 3));
    return geo;
  }
}

interface Station {
  y: number;
  rx: number;
  rz: number;
  cz: number;
}

function torsoStations(lm: TwinLandmarks): Station[] {
  return [
    { y: lm.hipL.y - 0.08, rx: 0.090 * H, rz: 0.064 * H, cz: 0.03 },
    { y: lm.asisL.y, rx: 0.098 * H, rz: 0.074 * H, cz: 0.05 },
    { y: (lm.xiphoid.y + lm.asisL.y) * 0.5, rx: 0.086 * H, rz: 0.072 * H, cz: 0.05 },
    { y: lm.xiphoid.y, rx: 0.100 * H, rz: 0.088 * H, cz: 0.06 },
    { y: lm.sternalNotch.y - 0.2, rx: 0.112 * H, rz: 0.095 * H, cz: 0.08 },
    { y: lm.shoulderL.y, rx: 0.116 * H, rz: 0.086 * H, cz: 0.06 },
    { y: lm.c7.y, rx: 0.072 * H, rz: 0.058 * H, cz: 0.02 },
  ];
}

function sampleStation(stations: Station[], y: number): Station {
  if (y <= stations[0].y) return { ...stations[0], y };
  const last = stations[stations.length - 1];
  if (y >= last.y) return { ...last, y };
  for (let i = 0; i < stations.length - 1; i++) {
    const a = stations[i];
    const b = stations[i + 1];
    if (y <= b.y) {
      const t = (y - a.y) / (b.y - a.y);
      return {
        y,
        rx: a.rx + (b.rx - a.rx) * t,
        rz: a.rz + (b.rz - a.rz) * t,
        cz: a.cz + (b.cz - a.cz) * t,
      };
    }
  }
  return { ...last, y };
}

function torsoOn(stations: Station[], y: number, th: number, fit: number): THREE.Vector3 {
  const st = sampleStation(stations, y);
  return new THREE.Vector3(
    Math.cos(th) * st.rx * fit,
    y,
    st.cz + Math.sin(th) * st.rz * fit,
  );
}

function heartY(lm: TwinLandmarks): number {
  return lm.xiphoid.y + (lm.sternalNotch.y - lm.xiphoid.y) * 0.42;
}

function mid(a: THREE.Vector3, b: THREE.Vector3): THREE.Vector3 {
  return new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5);
}

function lerp(a: THREE.Vector3, b: THREE.Vector3, t: number): THREE.Vector3 {
  return new THREE.Vector3().lerpVectors(a, b, t);
}

function basis(normal: THREE.Vector3, right: THREE.Vector3, up: THREE.Vector3): void {
  const n = normal.clone().normalize();
  const tmp = Math.abs(n.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
  right.copy(tmp).cross(n).normalize();
  up.copy(n).cross(right).normalize();
}

function offset(
  c: THREE.Vector3,
  right: THREE.Vector3,
  up: THREE.Vector3,
  a: number,
  b: number,
): THREE.Vector3 {
  return new THREE.Vector3(
    c.x + right.x * a + up.x * b,
    c.y + right.y * a + up.y * b,
    c.z + right.z * a + up.z * b,
  );
}

function ellipse(
  s: LineSoup,
  c: THREE.Vector3,
  right: THREE.Vector3,
  up: THREE.Vector3,
  rx: number,
  ry: number,
  segs: number,
): void {
  let px = 0, py = 0, pz = 0;
  for (let i = 0; i <= segs; i++) {
    const a = (i / segs) * Math.PI * 2;
    const x = c.x + right.x * Math.cos(a) * rx + up.x * Math.sin(a) * ry;
    const y = c.y + right.y * Math.cos(a) * rx + up.y * Math.sin(a) * ry;
    const z = c.z + right.z * Math.cos(a) * rx + up.z * Math.sin(a) * ry;
    if (i > 0) s.seg(px, py, pz, x, y, z);
    px = x;
    py = y;
    pz = z;
  }
}

function catmull(pts: THREE.Vector3[], divs: number): THREE.Vector3[] {
  if (pts.length < 2) return pts.map((p) => p.clone());
  const padded = [pts[0], ...pts, pts[pts.length - 1]];
  const out: THREE.Vector3[] = [];
  for (let i = 1; i < padded.length - 2; i++) {
    const p0 = padded[i - 1];
    const p1 = padded[i];
    const p2 = padded[i + 1];
    const p3 = padded[i + 2];
    for (let d = 0; d < divs; d++) {
      const t = d / divs;
      out.push(cr(p0, p1, p2, p3, t));
    }
  }
  out.push(pts[pts.length - 1].clone());
  return out;
}

function cr(
  p0: THREE.Vector3, p1: THREE.Vector3, p2: THREE.Vector3, p3: THREE.Vector3, t: number,
): THREE.Vector3 {
  const t2 = t * t;
  const t3 = t2 * t;
  return new THREE.Vector3(
    0.5 * ((2 * p1.x) + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
    0.5 * ((2 * p1.y) + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
    0.5 * ((2 * p1.z) + (-p0.z + p2.z) * t + (2 * p0.z - 5 * p1.z + 4 * p2.z - p3.z) * t2 + (-p0.z + 3 * p1.z - 3 * p2.z + p3.z) * t3),
  );
}

function tube(s: LineSoup, path: THREE.Vector3[], radius: number, meridians: number): void {
  if (path.length < 2) return;
  const stride = Math.max(1, Math.floor(path.length / 28));
  const rings: THREE.Vector3[][] = [];
  for (let i = 0; i < path.length; i += stride) {
    const prev = path[Math.max(0, i - 1)];
    const next = path[Math.min(path.length - 1, i + 1)];
    const tang = new THREE.Vector3().subVectors(next, prev);
    if (tang.lengthSq() < 1e-10) continue;
    tang.normalize();
    const right = new THREE.Vector3();
    const up = new THREE.Vector3();
    basis(tang, right, up);
    const ring: THREE.Vector3[] = [];
    for (let m = 0; m < meridians; m++) {
      const a = (m / meridians) * Math.PI * 2;
      ring.push(offset(path[i], right, up, Math.cos(a) * radius, Math.sin(a) * radius));
    }
    rings.push(ring);
  }
  for (const ring of rings) {
    for (let m = 0; m < meridians; m++) s.segV(ring[m], ring[(m + 1) % meridians]);
  }
  for (let i = 0; i < rings.length - 1; i++) {
    for (let m = 0; m < meridians; m++) s.segV(rings[i][m], rings[i + 1][m]);
  }
}

function samplePath(path: THREE.Vector3[], n: number, out: THREE.Vector3[]): void {
  if (path.length === 0) return;
  for (let i = 0; i < n; i++) {
    const t = i / Math.max(n - 1, 1);
    const idx = t * (path.length - 1);
    const i0 = Math.floor(idx);
    const i1 = Math.min(path.length - 1, i0 + 1);
    const f = idx - i0;
    out.push(new THREE.Vector3().lerpVectors(path[i0], path[i1], f));
  }
}

function offsetPath(path: THREE.Vector3[], d: THREE.Vector3): THREE.Vector3[] {
  return path.map((p) => p.clone().add(d));
}

function hash(i: number): number {
  const s = Math.sin(i * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}
