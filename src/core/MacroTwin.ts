import * as THREE from "three";
import { cellularPresence, molecularPresence, nanoPresence, tissuePresence } from "./ScaleManager";
import { freezeStatic } from "./freezeStatic";

/**
 * Macro digital twin — holographic structural field.
 *
 * Not a character. Not a mesh for animation. A classified full-body
 * reconstruction: named anthropometric landmarks, a 24-vertebra column
 * with physiological curves, a 12-pair ribcage, pelvic inlet, limb
 * segments, and a sparse surface loft that only hints at volume.
 *
 * Units: 16 world-units ≡ 1.80 m standing height (1 wu = 0.1125 m).
 * Segment fractions follow Drillis–Contini / NASA anthropometry.
 * Pose: anatomical position, facing +Z, anatomical right = −X, +Y cranial.
 *
 * Densification:
 *   LOD is half-decade from −log10(scale).
 *   Phase 2 TissueLayer attaches to getLandmarks() and takes over volume
 *   as tissuePresence rises. This class keeps the silhouette readable.
 *
 * Materials: LineBasicMaterial + PointsMaterial only.
 * lineWidth is not a channel (Windows/ANGLE ignores it). Hierarchy is
 * color value + opacity + density.
 */

const H = 16;

interface Lod {
  meridians: number;
  parallels: number;
  ringSegs: number;
  ribSegs: number;
  loftRings: number;
  limbRings: number;
  points: number;
}

const LOD: readonly Lod[] = [
  { meridians: 8,  parallels: 5,  ringSegs: 16, ribSegs: 10, loftRings: 6,  limbRings: 3, points: 420  },
  { meridians: 12, parallels: 7,  ringSegs: 20, ribSegs: 14, loftRings: 8,  limbRings: 5, points: 1100 },
  { meridians: 16, parallels: 10, ringSegs: 24, ribSegs: 18, loftRings: 10, limbRings: 7, points: 2200 },
  { meridians: 22, parallels: 13, ringSegs: 28, ribSegs: 22, loftRings: 13, limbRings: 9, points: 3800 },
];

function lodIndex(scale: number): number {
  const g = -Math.log10(Math.max(scale, 1e-12));
  // Half-decade steps: densification starts inside MACRO (~0.32), not only at 0.1.
  return Math.min(LOD.length - 1, Math.max(0, Math.floor(g * 2 + 1e-9)));
}

export interface TwinLandmarks {
  vertex: THREE.Vector3;
  skull: THREE.Vector3;
  chin: THREE.Vector3;
  c7: THREE.Vector3;
  sternalNotch: THREE.Vector3;
  xiphoid: THREE.Vector3;
  shoulderL: THREE.Vector3;
  shoulderR: THREE.Vector3;
  elbowL: THREE.Vector3;
  elbowR: THREE.Vector3;
  wristL: THREE.Vector3;
  wristR: THREE.Vector3;
  hipL: THREE.Vector3;
  hipR: THREE.Vector3;
  asisL: THREE.Vector3;
  asisR: THREE.Vector3;
  kneeL: THREE.Vector3;
  kneeR: THREE.Vector3;
  ankleL: THREE.Vector3;
  ankleR: THREE.Vector3;
  heelL: THREE.Vector3;
  heelR: THREE.Vector3;
  toeL: THREE.Vector3;
  toeR: THREE.Vector3;
  /** 24 vertebral body centers, caudal → cranial (L5 … C1). */
  vertebrae: THREE.Vector3[];
}

function landmarks(): TwinLandmarks {
  // Drillis–Contini fractions of stature, Y-up, feet on the deck.
  const sole = 0.06;
  const ankleY = sole + 0.039 * H;
  const kneeY = ankleY + 0.246 * H;
  const hipY = kneeY + 0.245 * H;
  const vertexY = sole + H;
  const chinY = vertexY - H / 8;
  const c7Y = 0.845 * H + sole;
  const shoulderY = 0.818 * H + sole;
  const notchY = 0.80 * H + sole;
  const xiphoidY = 0.70 * H + sole;

  const biacromial = 0.229 * H;
  const bitroch = 0.187 * H;
  const upperArm = 0.186 * H;
  const forearm = 0.146 * H;
  const footLen = 0.152 * H;

  // 12° abduction, 6° elbow flex — readable limb corridors, not a T-pose.
  const abd = (12 * Math.PI) / 180;
  const flex = (6 * Math.PI) / 180;

  const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

  const shoulderR = v(-biacromial * 0.5, shoulderY, 0.05);
  const shoulderL = v(+biacromial * 0.5, shoulderY, 0.05);

  const armDirR = new THREE.Vector3(
    -Math.sin(abd),
    -Math.cos(abd),
    Math.sin(flex) * 0.15,
  ).normalize();
  const armDirL = new THREE.Vector3(
    +Math.sin(abd),
    -Math.cos(abd),
    Math.sin(flex) * 0.15,
  ).normalize();

  const elbowR = shoulderR.clone().addScaledVector(armDirR, upperArm);
  const elbowL = shoulderL.clone().addScaledVector(armDirL, upperArm);

  const foreR = new THREE.Vector3(
    -Math.sin(abd) * 0.4,
    -Math.cos(flex),
    0.18,
  ).normalize();
  const foreL = new THREE.Vector3(
    +Math.sin(abd) * 0.4,
    -Math.cos(flex),
    0.18,
  ).normalize();

  const wristR = elbowR.clone().addScaledVector(foreR, forearm);
  const wristL = elbowL.clone().addScaledVector(foreL, forearm);

  const hipR = v(-bitroch * 0.5, hipY, 0.02);
  const hipL = v(+bitroch * 0.5, hipY, 0.02);
  const kneeR = v(-bitroch * 0.42, kneeY, 0.06);
  const kneeL = v(+bitroch * 0.42, kneeY, 0.06);
  const ankleR = v(-bitroch * 0.38, ankleY, -0.02);
  const ankleL = v(+bitroch * 0.38, ankleY, -0.02);

  const heelR = v(ankleR.x, sole, ankleR.z - footLen * 0.22);
  const heelL = v(ankleL.x, sole, ankleL.z - footLen * 0.22);
  const toeR = v(ankleR.x, sole + 0.04, ankleR.z + footLen * 0.62);
  const toeL = v(ankleL.x, sole + 0.04, ankleL.z + footLen * 0.62);

  const iliacY = hipY + 0.045 * H;
  const asisR = v(-bitroch * 0.52, iliacY, 0.22);
  const asisL = v(+bitroch * 0.52, iliacY, 0.22);

  const skull = v(0, (vertexY + chinY) * 0.5, 0.08);
  const c7 = v(0, c7Y, -0.18);
  const vertebrae = buildVertebrae(hipY + 0.08 * H, c7Y, 24);

  return {
    vertex: v(0, vertexY, 0.04),
    skull,
    chin: v(0, chinY, 0.10),
    c7,
    sternalNotch: v(0, notchY, 0.42),
    xiphoid: v(0, xiphoidY, 0.38),
    shoulderL,
    shoulderR,
    elbowL,
    elbowR,
    wristL,
    wristR,
    hipL,
    hipR,
    asisL,
    asisR,
    kneeL,
    kneeR,
    ankleL,
    ankleR,
    heelL,
    heelR,
    toeL,
    toeR,
    vertebrae,
  };
}

/**
 * 24 vertebral centers. t = 0 caudal (L5) → 1 cranial (C1).
 * z: lumbar lordosis (+Z anterior), thoracic kyphosis (−Z), cervical lordosis.
 */
function buildVertebrae(yCaudal: number, yCranial: number, n: number): THREE.Vector3[] {
  const out: THREE.Vector3[] = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const y = yCaudal + (yCranial - yCaudal) * t;
    // Piecewise physiological curves, amplitudes in wu (~cm-scale at this map).
    let z = -0.12;
    if (t < 0.32) {
      z += 0.22 * Math.sin((t / 0.32) * Math.PI); // lumbar lordosis
    } else if (t < 0.78) {
      const u = (t - 0.32) / 0.46;
      z -= 0.32 * Math.sin(u * Math.PI); // thoracic kyphosis
    } else {
      const u = (t - 0.78) / 0.22;
      z += 0.16 * Math.sin(u * Math.PI); // cervical lordosis
    }
    out.push(new THREE.Vector3(0, y, z));
  }
  return out;
}

class LineSoup {
  private readonly v: number[] = [];

  seg(
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
  ): void {
    this.v.push(ax, ay, az, bx, by, bz);
  }

  segV(a: THREE.Vector3, b: THREE.Vector3): void {
    this.seg(a.x, a.y, a.z, b.x, b.y, b.z);
  }

  polyline(pts: THREE.Vector3[], closed = false): void {
    for (let i = 0; i < pts.length - 1; i++) this.segV(pts[i], pts[i + 1]);
    if (closed && pts.length > 2) this.segV(pts[pts.length - 1], pts[0]);
  }

  /**
   * Ellipse in a plane spanned by `right` and `up`, center `c`.
   * a0..a1 in radians. Full ring = 0 .. 2π.
   */
  ellipse(
    c: THREE.Vector3,
    right: THREE.Vector3,
    up: THREE.Vector3,
    rx: number,
    ry: number,
    segs: number,
    a0 = 0,
    a1 = Math.PI * 2,
  ): void {
    let px = 0, py = 0, pz = 0;
    for (let i = 0; i <= segs; i++) {
      const a = a0 + ((a1 - a0) * i) / segs;
      const x = c.x + right.x * Math.cos(a) * rx + up.x * Math.sin(a) * ry;
      const y = c.y + right.y * Math.cos(a) * rx + up.y * Math.sin(a) * ry;
      const z = c.z + right.z * Math.cos(a) * rx + up.z * Math.sin(a) * ry;
      if (i > 0) this.seg(px, py, pz, x, y, z);
      px = x;
      py = y;
      pz = z;
    }
  }

  circle(c: THREE.Vector3, normal: THREE.Vector3, r: number, segs: number): void {
    const right = new THREE.Vector3();
    const up = new THREE.Vector3();
    basis(normal, right, up);
    this.ellipse(c, right, up, r, r, segs);
  }

  ellipsoid(
    c: THREE.Vector3,
    rx: number,
    ry: number,
    rz: number,
    meridians: number,
    parallels: number,
    segs: number,
  ): void {
    const ex = new THREE.Vector3(1, 0, 0);
    const ez = new THREE.Vector3(0, 0, 1);
    for (let j = 1; j < parallels; j++) {
      const phi = (j / parallels) * Math.PI;
      const y = c.y + ry * Math.cos(phi);
      const s = Math.sin(phi);
      this.ellipse(
        new THREE.Vector3(c.x, y, c.z),
        ex,
        ez,
        rx * s,
        rz * s,
        segs,
      );
    }
    for (let i = 0; i < meridians; i++) {
      const th = (i / meridians) * Math.PI * 2;
      const ct = Math.cos(th);
      const st = Math.sin(th);
      let px = 0, py = 0, pz = 0;
      for (let j = 0; j <= segs; j++) {
        const phi = (j / segs) * Math.PI;
        const sp = Math.sin(phi);
        const cp = Math.cos(phi);
        const x = c.x + rx * sp * ct;
        const y = c.y + ry * cp;
        const z = c.z + rz * sp * st;
        if (j > 0) this.seg(px, py, pz, x, y, z);
        px = x;
        py = y;
        pz = z;
      }
    }
  }

  /** Tapered capsule: rings + meridians along A→B. */
  capsule(
    a: THREE.Vector3,
    b: THREE.Vector3,
    r0: number,
    r1: number,
    rings: number,
    meridians: number,
    segs: number,
  ): void {
    const axis = new THREE.Vector3().subVectors(b, a);
    const len = axis.length();
    if (len < 1e-6) return;
    axis.multiplyScalar(1 / len);
    const right = new THREE.Vector3();
    const up = new THREE.Vector3();
    basis(axis, right, up);

    const centers: THREE.Vector3[] = [];
    const radii: number[] = [];
    for (let i = 0; i <= rings + 1; i++) {
      const t = i / (rings + 1);
      centers.push(new THREE.Vector3().lerpVectors(a, b, t));
      radii.push(r0 + (r1 - r0) * t);
    }
    for (let i = 0; i < centers.length; i++) {
      this.ellipse(centers[i], right, up, radii[i], radii[i], segs);
    }
    for (let m = 0; m < meridians; m++) {
      const ang = (m / meridians) * Math.PI * 2;
      const ca = Math.cos(ang);
      const sa = Math.sin(ang);
      for (let i = 0; i < centers.length - 1; i++) {
        const p0 = offset(centers[i], right, up, radii[i] * ca, radii[i] * sa);
        const p1 = offset(centers[i + 1], right, up, radii[i + 1] * ca, radii[i + 1] * sa);
        this.segV(p0, p1);
      }
    }
  }

  geometry(): THREE.BufferGeometry {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(this.v, 3));
    return geo;
  }
}

class PointSoup {
  private readonly v: number[] = [];

  add(x: number, y: number, z: number): void {
    this.v.push(x, y, z);
  }

  addV(p: THREE.Vector3): void {
    this.v.push(p.x, p.y, p.z);
  }

  /** Deterministic fill of an axis-aligned ellipsoid. */
  fillEllipsoid(
    c: THREE.Vector3,
    rx: number,
    ry: number,
    rz: number,
    count: number,
    seed: number,
  ): void {
    let n = 0;
    let i = seed;
    const max = count * 8;
    while (n < count && i < max) {
      const u = hash(i) * 2 - 1;
      const v = hash(i + 1) * 2 - 1;
      const w = hash(i + 2) * 2 - 1;
      i += 3;
      if (u * u + v * v + w * w > 1) continue;
      this.add(c.x + u * rx, c.y + v * ry, c.z + w * rz);
      n++;
    }
  }

  geometry(): THREE.BufferGeometry {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(this.v, 3));
    return geo;
  }
}

function basis(
  normal: THREE.Vector3,
  right: THREE.Vector3,
  up: THREE.Vector3,
): void {
  const n = normal.clone().normalize();
  const tmp =
    Math.abs(n.y) < 0.9
      ? new THREE.Vector3(0, 1, 0)
      : new THREE.Vector3(1, 0, 0);
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

function hash(i: number): number {
  const s = Math.sin(i * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}

export class MacroTwin {
  readonly group = new THREE.Group();

  private readonly body = new THREE.Group();
  private readonly theater = new THREE.Group();
  private readonly lm: TwinLandmarks;

  private builtLod = -1;
  private lastScale = 1;
  private scanStructure = 1;

  private readonly structureMat = new THREE.LineBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.92,
    fog: true,
  });
  private readonly surfaceMat = new THREE.LineBasicMaterial({
    color: 0xa8a8a8,
    transparent: true,
    opacity: 0.34,
    fog: true,
  });
  private readonly fieldMat = new THREE.PointsMaterial({
    color: 0x7a7a7a,
    size: 0.055,
    sizeAttenuation: true,
    transparent: true,
    opacity: 0.7,
    fog: true,
  });
  private readonly frameMat = new THREE.LineBasicMaterial({
    color: 0x8d8d8d,
    transparent: true,
    opacity: 0.28,
    fog: true,
  });

  constructor(scene: THREE.Scene) {
    this.group.name = "MacroTwin";
    this.body.name = "TwinBody";
    this.theater.name = "TheaterFrame";
    this.lm = landmarks();
    this.group.add(this.theater);
    this.group.add(this.body);
    scene.add(this.group);

    this.buildTheater();
    this.syncScale(1.0);
    freezeStatic(this.group);
  }

  /**
   * Frozen attachment table for TissueLayer. Treat as immutable.
   * Same object identity for the life of the twin.
   */
  getLandmarks(): TwinLandmarks {
    return this.lm;
  }

  /**
   * ScaleManager drive. Safe every frame.
   * Continuous: material hierarchy.
   * Discrete: LOD rebuild when the decade key changes.
   */
  syncScale(scale: number): void {
    this.lastScale = scale;
    this.applyLook();
    const lod = lodIndex(Math.max(scale, 1e-12));
    if (lod === this.builtLod) return;
    this.builtLod = lod;
    this.rebuild(LOD[lod]);
  }

  setScanGain(structure: number): void {
    this.scanStructure = structure;
    this.applyLook();
  }

  private applyLook(): void {
    const s = Math.max(this.lastScale, 1e-12);
    const tp = tissuePresence(s);
    const cp = cellularPresence(s);
    const mp = molecularPresence(s);
    const np = nanoPresence(s);
    const gs = this.scanStructure;
    this.surfaceMat.opacity =
      THREE.MathUtils.clamp(0.30 + 0.28 * (1 - s), 0.30, 0.62) *
      (1 - 0.78 * tp) * (1 - 0.45 * cp) * (1 - 0.25 * mp) * (1 - 0.10 * np) * gs;
    this.structureMat.opacity =
      THREE.MathUtils.clamp(0.86 + 0.10 * (1 - s), 0.86, 0.96) *
      (1 - 0.22 * tp) * (1 - 0.18 * cp) * (1 - 0.12 * mp) * (1 - 0.08 * np) * gs;
    this.fieldMat.opacity =
      THREE.MathUtils.clamp(0.55 + 0.30 * (1 - s), 0.55, 0.88) *
      (1 - 0.88 * tp) * (1 - 0.5 * cp) * (1 - 0.35 * mp) * (1 - 0.15 * np) * gs;
    this.fieldMat.size = THREE.MathUtils.clamp(0.035 + 0.028 * Math.sqrt(s), 0.028, 0.07);
    this.frameMat.opacity = THREE.MathUtils.clamp(0.16 + 0.14 * s, 0.16, 0.30);
  }

  dispose(): void {
    this.wipe(this.body);
    this.wipe(this.theater);
    this.structureMat.dispose();
    this.surfaceMat.dispose();
    this.fieldMat.dispose();
    this.frameMat.dispose();
    this.group.removeFromParent();
  }

  private rebuild(lod: Lod): void {
    this.wipe(this.body);
    const lm = this.lm;
    const structure = new LineSoup();
    const surface = new LineSoup();
    const field = new PointSoup();

    this.drawSkull(structure, surface, lm, lod);
    this.drawSpine(structure, lm);
    this.drawRibcage(structure, lm, lod);
    this.drawPelvis(structure, lm, lod);
    this.drawTorsoLoft(surface, lm, lod);
    this.drawLimbs(structure, surface, lm, lod);
    this.drawField(field, lm, lod);

    this.body.add(new THREE.LineSegments(structure.geometry(), this.structureMat));
    this.body.add(new THREE.LineSegments(surface.geometry(), this.surfaceMat));
    this.body.add(new THREE.Points(field.geometry(), this.fieldMat));
    freezeStatic(this.body);
  }

  /** Cranium + mandible arc + orbital rims. No face. */
  private drawSkull(
    structure: LineSoup,
    surface: LineSoup,
    lm: TwinLandmarks,
    lod: Lod,
  ): void {
    const rx = 0.072 * H;
    const ry = 0.078 * H;
    const rz = 0.086 * H;
    surface.ellipsoid(lm.skull, rx, ry, rz, lod.meridians, lod.parallels, lod.ringSegs);

    // Cranial vault meridians — structural, sparser than the hull.
    structure.ellipsoid(
      lm.skull,
      rx * 0.98,
      ry * 0.98,
      rz * 0.98,
      Math.max(4, Math.floor(lod.meridians * 0.5)),
      3,
      lod.ringSegs,
    );

    const jaw = new THREE.Vector3(lm.chin.x, lm.chin.y - 0.04, lm.chin.z + 0.04);
    const xAxis = new THREE.Vector3(1, 0, 0);
    const zAxis = new THREE.Vector3(0, 0, 1);
    structure.ellipse(jaw, xAxis, zAxis, rx * 0.62, rz * 0.38, lod.ringSegs, Math.PI * 0.15, Math.PI * 0.85);

    const orbitR = 0.22;
    const orbitOffX = rx * 0.38;
    const orbitY = lm.skull.y - ry * 0.08;
    const orbitZ = lm.skull.z + rz * 0.72;
    const fwd = new THREE.Vector3(0, 0, 1);
    structure.circle(new THREE.Vector3(-orbitOffX, orbitY, orbitZ), fwd, orbitR, 12);
    structure.circle(new THREE.Vector3(+orbitOffX, orbitY, orbitZ), fwd, orbitR, 12);
    structure.segV(lm.skull, lm.chin);
  }

  private drawSpine(structure: LineSoup, lm: TwinLandmarks): void {
    structure.polyline(lm.vertebrae, false);
    structure.segV(lm.vertebrae[lm.vertebrae.length - 1], new THREE.Vector3(0, lm.chin.y - 0.15, lm.chin.z - 0.18));

    for (let i = 0; i < lm.vertebrae.length; i++) {
      const p = lm.vertebrae[i];
      const w = 0.10 + 0.06 * Math.sin((i / (lm.vertebrae.length - 1)) * Math.PI);
      structure.seg(p.x - w, p.y, p.z, p.x + w, p.y, p.z);
      // Spinous process, posterior.
      structure.seg(p.x, p.y, p.z, p.x, p.y - 0.02, p.z - w * 1.1);
    }

    // Clavicles: sternal notch → acromion, slight superior bow.
    const midR = new THREE.Vector3().lerpVectors(lm.sternalNotch, lm.shoulderR, 0.5);
    midR.y += 0.12;
    midR.z -= 0.04;
    const midL = new THREE.Vector3().lerpVectors(lm.sternalNotch, lm.shoulderL, 0.5);
    midL.y += 0.12;
    midL.z -= 0.04;
    structure.segV(lm.sternalNotch, midR);
    structure.segV(midR, lm.shoulderR);
    structure.segV(lm.sternalNotch, midL);
    structure.segV(midL, lm.shoulderL);

    // Sternum + sternebrae.
    structure.segV(lm.sternalNotch, lm.xiphoid);
    for (let i = 1; i <= 3; i++) {
      const t = i / 4;
      const p = new THREE.Vector3().lerpVectors(lm.sternalNotch, lm.xiphoid, t);
      structure.seg(p.x - 0.10, p.y, p.z, p.x + 0.10, p.y, p.z);
    }
  }

  /**
   * Twelve rib pairs. True ribs 1–7 reach the sternum; 8–10 shorter
   * costal-arch; 11–12 floating. Ellipse in a near-horizontal plane,
   * posterior origin on the thoracic column.
   */
  private drawRibcage(structure: LineSoup, lm: TwinLandmarks, lod: Lod): void {
    const scales = [0.42, 0.58, 0.74, 0.88, 0.97, 1.0, 0.97, 0.88, 0.76, 0.62, 0.46, 0.34];
    const tStart = 8;  // index into 24 verts ≈ T1
    const tEnd = 19;   // ≈ T12
    const chestRx = 0.115 * H;
    const chestRz = 0.095 * H;
    const xAxis = new THREE.Vector3(1, 0, 0);
    const zAxis = new THREE.Vector3(0, 0, 1);

    for (let r = 0; r < 12; r++) {
      const vt = tStart + ((tEnd - tStart) * r) / 11;
      const i0 = Math.floor(vt);
      const f = vt - i0;
      const a = lm.vertebrae[Math.min(i0, lm.vertebrae.length - 1)];
      const b = lm.vertebrae[Math.min(i0 + 1, lm.vertebrae.length - 1)];
      const y = a.y + (b.y - a.y) * f;
      const zSpine = a.z + (b.z - a.z) * f;

      const sc = scales[r];
      const rx = chestRx * sc;
      const rz = chestRz * sc * 0.95;
      const c = new THREE.Vector3(0, y, zSpine * 0.25 + rz * 0.15);

      // Anterior reach: true ribs close to the sternum line.
      const anterior = r < 7 ? 0.08 : r < 10 ? 0.22 : 0.55;
      const a0 = anterior * Math.PI;

      // Right (−X) and left (+X) as two half-ellipses, skip the posterior overlap.
      structure.ellipse(c, xAxis, zAxis, rx, rz, lod.ribSegs, Math.PI + a0, Math.PI * 2 - a0 * 0.15);
      structure.ellipse(c, xAxis, zAxis, rx, rz, lod.ribSegs, a0 * 0.15, Math.PI - a0);

      if (r < 7) {
        const sternum = new THREE.Vector3().lerpVectors(
          lm.sternalNotch,
          lm.xiphoid,
          r / 6,
        );
        const rightTip = new THREE.Vector3(
          c.x + rx * Math.cos(a0) * 0.15,
          y,
          c.z + rz * Math.sin(Math.PI * 0.5) * 0.92,
        );
        const leftTip = new THREE.Vector3(-rightTip.x, y, rightTip.z);
        // Costal cartilage: last segment into the sternum.
        structure.seg(rx * 0.15, y, rightTip.z, sternum.x, sternum.y, sternum.z);
        structure.seg(-rx * 0.15, y, leftTip.z, sternum.x, sternum.y, sternum.z);
      }
    }
  }

  private drawPelvis(structure: LineSoup, lm: TwinLandmarks, lod: Lod): void {
    const inletC = new THREE.Vector3(
      0,
      (lm.hipL.y + lm.asisL.y) * 0.5,
      0.06,
    );
    const xAxis = new THREE.Vector3(1, 0, 0);
    const zAxis = new THREE.Vector3(0, 0, 1);
    const iliacRx = 0.095 * H;
    const iliacRz = 0.072 * H;

    // Pelvic inlet — the surgical landmark.
    structure.ellipse(inletC, xAxis, zAxis, iliacRx * 0.72, iliacRz * 0.58, lod.ringSegs);

    // Iliac crests (tilted ovals).
    const tilt = new THREE.Vector3(0.15, 0.85, 0.15).normalize();
    const right = new THREE.Vector3();
    const up = new THREE.Vector3();
    basis(tilt, right, up);
    structure.ellipse(lm.asisR, right, up, 0.55, 0.38, lod.ringSegs);
    const tiltL = new THREE.Vector3(-0.15, 0.85, 0.15).normalize();
    basis(tiltL, right, up);
    structure.ellipse(lm.asisL, right, up, 0.55, 0.38, lod.ringSegs);

    structure.segV(lm.asisR, lm.asisL);
    structure.segV(lm.asisR, lm.hipR);
    structure.segV(lm.asisL, lm.hipL);
    structure.segV(lm.hipR, lm.hipL);

    // Sacrum: fused triangle on the caudal vertebrae.
    const s1 = lm.vertebrae[0];
    const s2 = lm.vertebrae[Math.min(2, lm.vertebrae.length - 1)];
    structure.seg(s1.x - 0.28, s1.y, s1.z, s1.x + 0.28, s1.y, s1.z);
    structure.seg(s1.x - 0.28, s1.y, s1.z, s2.x, s2.y - 0.15, s2.z + 0.05);
    structure.seg(s1.x + 0.28, s1.y, s1.z, s2.x, s2.y - 0.15, s2.z + 0.05);
  }

  /** Surface loft: stacked thoracic ellipses + meridians. Volume hint only. */
  private drawTorsoLoft(surface: LineSoup, lm: TwinLandmarks, lod: Lod): void {
    const xAxis = new THREE.Vector3(1, 0, 0);
    const zAxis = new THREE.Vector3(0, 0, 1);

    const rings: Array<{ y: number; rx: number; rz: number; z: number }> = [
      { y: lm.shoulderL.y + 0.12, rx: 0.108 * H, rz: 0.070 * H, z: 0.04 },
      { y: lm.shoulderL.y - 0.15, rx: 0.118 * H, rz: 0.088 * H, z: 0.06 },
      { y: lm.sternalNotch.y - 0.25, rx: 0.112 * H, rz: 0.095 * H, z: 0.08 },
      { y: lm.xiphoid.y, rx: 0.100 * H, rz: 0.088 * H, z: 0.06 },
      { y: (lm.xiphoid.y + lm.asisL.y) * 0.5, rx: 0.082 * H, rz: 0.072 * H, z: 0.04 },
      { y: lm.asisL.y, rx: 0.098 * H, rz: 0.074 * H, z: 0.05 },
      { y: lm.hipL.y, rx: 0.092 * H, rz: 0.068 * H, z: 0.03 },
    ];

    const use = rings.filter((_, i) => {
      if (lod.loftRings >= rings.length) return true;
      const step = (rings.length - 1) / (lod.loftRings - 1);
      return i === 0 || i === rings.length - 1 || Math.abs(i / step - Math.round(i / step)) < 0.01;
    });

    const active = use.length >= 3 ? use : rings;

    for (const r of active) {
      surface.ellipse(
        new THREE.Vector3(0, r.y, r.z),
        xAxis,
        zAxis,
        r.rx,
        r.rz,
        lod.ringSegs,
      );
    }

    const mer = Math.max(6, lod.meridians);
    for (let m = 0; m < mer; m++) {
      const a = (m / mer) * Math.PI * 2;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      for (let i = 0; i < active.length - 1; i++) {
        const A = active[i];
        const B = active[i + 1];
        surface.seg(
          ca * A.rx, A.y, A.z + sa * A.rz,
          ca * B.rx, B.y, B.z + sa * B.rz,
        );
      }
    }

    // Neck frustum.
    const neck0 = new THREE.Vector3(0, lm.c7.y + 0.05, 0.02);
    const neck1 = new THREE.Vector3(0, lm.chin.y - 0.08, 0.06);
    surface.ellipse(neck0, xAxis, zAxis, 0.28, 0.26, lod.ringSegs);
    surface.ellipse(neck1, xAxis, zAxis, 0.24, 0.22, lod.ringSegs);
    for (let m = 0; m < 6; m++) {
      const a = (m / 6) * Math.PI * 2;
      surface.seg(
        Math.cos(a) * 0.28, neck0.y, neck0.z + Math.sin(a) * 0.26,
        Math.cos(a) * 0.24, neck1.y, neck1.z + Math.sin(a) * 0.22,
      );
    }
  }

  private drawLimbs(
    structure: LineSoup,
    surface: LineSoup,
    lm: TwinLandmarks,
    lod: Lod,
  ): void {
    const mer = Math.max(6, Math.floor(lod.meridians * 0.6));

    // Structural bones.
    structure.segV(lm.shoulderR, lm.elbowR);
    structure.segV(lm.elbowR, lm.wristR);
    structure.segV(lm.shoulderL, lm.elbowL);
    structure.segV(lm.elbowL, lm.wristL);
    structure.segV(lm.hipR, lm.kneeR);
    structure.segV(lm.kneeR, lm.ankleR);
    structure.segV(lm.hipL, lm.kneeL);
    structure.segV(lm.kneeL, lm.ankleL);

    // Joint rings — GH, elbow, wrist, hip, knee, ankle.
    const joints: Array<[THREE.Vector3, number]> = [
      [lm.shoulderR, 0.28], [lm.shoulderL, 0.28],
      [lm.elbowR, 0.16], [lm.elbowL, 0.16],
      [lm.wristR, 0.12], [lm.wristL, 0.12],
      [lm.hipR, 0.30], [lm.hipL, 0.30],
      [lm.kneeR, 0.20], [lm.kneeL, 0.20],
      [lm.ankleR, 0.13], [lm.ankleL, 0.13],
    ];
    for (const [p, r] of joints) {
      structure.circle(p, new THREE.Vector3(1, 0, 0), r, 10);
      structure.circle(p, new THREE.Vector3(0, 0, 1), r, 10);
    }

    // Surface capsules.
    surface.capsule(lm.shoulderR, lm.elbowR, 0.32, 0.22, lod.limbRings, mer, lod.ringSegs);
    surface.capsule(lm.elbowR, lm.wristR, 0.20, 0.14, lod.limbRings, mer, lod.ringSegs);
    surface.capsule(lm.shoulderL, lm.elbowL, 0.32, 0.22, lod.limbRings, mer, lod.ringSegs);
    surface.capsule(lm.elbowL, lm.wristL, 0.20, 0.14, lod.limbRings, mer, lod.ringSegs);
    surface.capsule(lm.hipR, lm.kneeR, 0.42, 0.28, lod.limbRings, mer, lod.ringSegs);
    surface.capsule(lm.kneeR, lm.ankleR, 0.24, 0.16, lod.limbRings, mer, lod.ringSegs);
    surface.capsule(lm.hipL, lm.kneeL, 0.42, 0.28, lod.limbRings, mer, lod.ringSegs);
    surface.capsule(lm.kneeL, lm.ankleL, 0.24, 0.16, lod.limbRings, mer, lod.ringSegs);

    this.drawHand(structure, lm.wristR, lm.elbowR, -1, lod);
    this.drawHand(structure, lm.wristL, lm.elbowL, +1, lod);
    this.drawFoot(structure, lm.ankleR, lm.heelR, lm.toeR, lod);
    this.drawFoot(structure, lm.ankleL, lm.heelL, lm.toeL, lod);
  }

  private drawHand(
    structure: LineSoup,
    wrist: THREE.Vector3,
    elbow: THREE.Vector3,
    side: number,
    lod: Lod,
  ): void {
    const axis = new THREE.Vector3().subVectors(wrist, elbow).normalize();
    const palm = wrist.clone().addScaledVector(axis, 0.28);
    const right = new THREE.Vector3();
    const up = new THREE.Vector3();
    basis(axis, right, up);
    structure.ellipse(palm, right, up, 0.18, 0.11, 10);

    const fingers = lod.meridians >= 12 ? 5 : 4;
    for (let f = 0; f < fingers; f++) {
      const u = (f / (fingers - 1) - 0.5) * 0.36;
      const tip = offset(palm, right, up, u, 0).addScaledVector(axis, 0.38);
      const base = offset(wrist, right, up, u * 0.5, 0);
      structure.segV(base, tip);
    }
    void side;
  }

  private drawFoot(
    structure: LineSoup,
    ankle: THREE.Vector3,
    heel: THREE.Vector3,
    toe: THREE.Vector3,
    lod: Lod,
  ): void {
    structure.segV(ankle, heel);
    structure.segV(ankle, toe);
    structure.segV(heel, toe);
    const mid = new THREE.Vector3().lerpVectors(heel, toe, 0.55);
    mid.y = heel.y;
    const xAxis = new THREE.Vector3(1, 0, 0);
    const zAxis = new THREE.Vector3(0, 0, 1);
    structure.ellipse(mid, xAxis, zAxis, 0.16, 0.34, 10);

    const digits = lod.meridians >= 12 ? 5 : 3;
    const lat = new THREE.Vector3().subVectors(toe, heel);
    const len = lat.length() || 1;
    lat.multiplyScalar(1 / len);
    const side = new THREE.Vector3(-lat.z, 0, lat.x);
    for (let i = 0; i < digits; i++) {
      const u = (i / Math.max(digits - 1, 1) - 0.5) * 0.22;
      const t0 = toe.clone().addScaledVector(side, u);
      const t1 = t0.clone().addScaledVector(lat, 0.18);
      t1.y = toe.y;
      structure.segV(t0, t1);
    }
  }

  private drawField(field: PointSoup, lm: TwinLandmarks, lod: Lod): void {
    // Interior samples — the holographic volume, not a surface scatter.
    field.fillEllipsoid(lm.skull, 0.065 * H, 0.070 * H, 0.075 * H, Math.floor(lod.points * 0.12), 11);
    field.fillEllipsoid(
      new THREE.Vector3(0, (lm.sternalNotch.y + lm.hipL.y) * 0.5, 0.06),
      0.10 * H,
      0.22 * H,
      0.08 * H,
      Math.floor(lod.points * 0.42),
      29,
    );
    field.fillEllipsoid(
      new THREE.Vector3().lerpVectors(lm.hipR, lm.kneeR, 0.5),
      0.28, 0.55, 0.28,
      Math.floor(lod.points * 0.1),
      47,
    );
    field.fillEllipsoid(
      new THREE.Vector3().lerpVectors(lm.hipL, lm.kneeL, 0.5),
      0.28, 0.55, 0.28,
      Math.floor(lod.points * 0.1),
      53,
    );
    field.fillEllipsoid(
      new THREE.Vector3().lerpVectors(lm.shoulderR, lm.elbowR, 0.5),
      0.22, 0.40, 0.22,
      Math.floor(lod.points * 0.07),
      71,
    );
    field.fillEllipsoid(
      new THREE.Vector3().lerpVectors(lm.shoulderL, lm.elbowL, 0.5),
      0.22, 0.40, 0.22,
      Math.floor(lod.points * 0.07),
      83,
    );

    for (const p of lm.vertebrae) field.addV(p);
    field.addV(lm.sternalNotch);
    field.addV(lm.xiphoid);
    field.addV(lm.vertex);
  }

  /**
   * Research theater. Two floor rings + a pair of gantry meridians.
   * Static. Must not compete with the twin. Opacity is the only voice.
   */
  private buildTheater(): void {
    const soup = new LineSoup();
    const y = 0.02;
    const segs = 64;
    const xAxis = new THREE.Vector3(1, 0, 0);
    const zAxis = new THREE.Vector3(0, 0, 1);
    const origin = new THREE.Vector3(0, y, 0);

    soup.ellipse(origin, xAxis, zAxis, 10, 10, segs);
    soup.ellipse(origin, xAxis, zAxis, 15.5, 15.5, segs);

    // Cardinal + intercardinal ticks on the outer ring.
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      soup.seg(ca * 15.1, y, sa * 15.1, ca * 16.2, y, sa * 16.2);
    }

    // Gantry meridians: sagittal (x=0) and coronal (z=0), center at mid-thorax.
    const c = new THREE.Vector3(0, 8.1, 0);
    const r = 10.6;
    const yAxis = new THREE.Vector3(0, 1, 0);
    soup.ellipse(c, zAxis, yAxis, r, r, segs); // sagittal
    soup.ellipse(c, xAxis, yAxis, r, r, segs); // coronal

    this.theater.add(new THREE.LineSegments(soup.geometry(), this.frameMat));
    freezeStatic(this.theater);
  }

  private wipe(g: THREE.Group): void {
    for (const child of [...g.children]) {
      g.remove(child);
      if (child instanceof THREE.LineSegments || child instanceof THREE.Points) {
        child.geometry.dispose();
      }
    }
  }
}
