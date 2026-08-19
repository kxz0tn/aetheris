import * as THREE from "three";
import { molecularDepth, molecularPresence, nanoPresence } from "./ScaleManager";
import type { CellKind } from "./TissueLayer";
import type { CellSite } from "./CellularLayer";
import type { CascadeReader } from "./CascadeSystem";
import { freezeStatic } from "./freezeStatic";

/**
 * Molecular structural field. No MD. No atoms. No fabrication.
 *
 * Consumes CellularLayer.getSites(). Subscribes via main.ts.
 * ScaleManager stays geometry-free.
 *
 * Built once. Revealed in place:
 *   primary chains / domains     ← molecularPresence
 *   secondary interfaces         ← mid depth
 *   energy isolines              ← molecularDepth
 *
 * Science, abstracted:
 *   CHANNEL   — tetrameric transmembrane pore on the membrane
 *               (selectivity-filter hoop + four subunits).
 *   MOTOR     — two heads + coiled-coil stem along the fiber
 *               (myosin / kinesin schematic).
 *   ENZYME    — tetrahedral oligomer (metabolic assembly).
 *   NPC       — octameric nuclear-pore ring.
 *
 * Binding: Langmuir occupancy θ = L/(Kd+L) with a slow ligand drive
 *   L(t) = L0 + A sin(ωt+φ). Not a concentration measurement.
 *   Vertex grayscale on interface hoops only. Backbone stays structural.
 *
 * Energy: funnel E = (1 − exp(−r/λ))² around each complex.
 *   Isolines + sparse radial ticks. Overlay, not an MD trajectory.
 *
 * Materials: LineBasicMaterial + PointsMaterial. Monochrome.
 */

export type ComplexClass = "channel" | "motor" | "enzyme" | "npc";

export interface ComplexSite {
  readonly position: THREE.Vector3;
  readonly axis: THREE.Vector3;
  readonly cls: ComplexClass;
}

export interface MolecularSample {
  cls: ComplexClass;
  dist: number;
  occupancy: number;
  energy: number;
  hostKind: CellKind;
  position: THREE.Vector3;
  /** Cascade extras, 0 if idle. Probe-visible. */
  stress: number;
}

interface ComplexRuntime {
  position: THREE.Vector3;
  axis: THREE.Vector3;
  cls: ComplexClass;
  hostKind: CellKind;
  start: number;
  count: number;
  kd: number;
  omega: number;
  phase: number;
  L0: number;
  amp: number;
  /** Assembler-written occupancy offset. Relaxes. */
  bias: number;
}

export class MolecularLayer {
  readonly group = new THREE.Group();

  private readonly primaryG = new THREE.Group();
  private readonly secondaryG = new THREE.Group();
  private readonly fieldG = new THREE.Group();

  private readonly priMat = lineMat(0xf0f0f0, 0, false);
  private readonly secMat = lineMat(0x8a8a8a, 0, false);
  private readonly bindMat = lineMat(0xffffff, 0, true);
  private readonly fieldMat = lineMat(0x9a9a9a, 0, false);
  private readonly fieldPtMat = new THREE.PointsMaterial({
    color: 0x777777,
    size: 0.010,
    sizeAttenuation: true,
    transparent: true,
    opacity: 0,
    fog: true,
  });

  private readonly rt: ComplexRuntime[] = [];
  private readonly sites: ComplexSite[] = [];
  private bindColors: THREE.BufferAttribute | null = null;
  private t = 0;
  private meanOcc = 0.5;
  private lastScale = 1;
  private scanMol = 1;
  private scanField = 1;
  private coupling: CascadeReader | null = null;
  private paintAcc = 0;

  constructor(scene: THREE.Scene, sites: readonly CellSite[]) {
    this.group.name = "MolecularLayer";
    this.group.visible = false;
    this.group.add(this.primaryG, this.secondaryG, this.fieldG);
    scene.add(this.group);
    this.build(sites);
    freezeStatic(this.group);
  }

  syncScale(scale: number): void {
    this.lastScale = scale;
    this.applyLook();
  }

  setScanGain(molecular: number, fields: number): void {
    this.scanMol = molecular;
    this.scanField = fields;
    this.applyLook();
  }

  getSites(): readonly ComplexSite[] {
    return this.sites;
  }

  bindCascade(c: CascadeReader): void {
    this.coupling = c;
  }

  /**
   * Assembler write: bias Langmuir occupancy. Relaxes with τ ≈ 7 s.
   * Returns the live sample after the nudge, or null if no target.
   */
  nudgeBinding(p: THREE.Vector3, maxDist: number, delta: number): MolecularSample | null {
    if (molecularPresence(this.lastScale) < 0.08) return null;
    let best: ComplexRuntime | null = null;
    let bestD = maxDist;
    for (const c of this.rt) {
      const d = p.distanceTo(c.position);
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
    if (!best) return null;
    best.bias = THREE.MathUtils.clamp(best.bias + delta, -0.45, 0.45);
    return this.packSample(best, bestD);
  }

  /**
   * Nearest complex within maxDist. Occupancy from the live Langmuir
   * oscillator. Energy from the funnel at the sample point.
   */
  sampleNearest(p: THREE.Vector3, maxDist: number): MolecularSample | null {
    if (molecularPresence(this.lastScale) < 0.08) return null;
    let best: ComplexRuntime | null = null;
    let bestD = maxDist;
    for (const c of this.rt) {
      const d = p.distanceTo(c.position);
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
    if (!best) return null;
    return this.packSample(best, bestD);
  }

  update(dt: number): void {
    if (!this.group.visible || dt <= 0 || !this.bindColors) return;
    this.t += dt;
    for (const c of this.rt) c.bias *= Math.exp(-dt / 7);
    this.paintAcc += dt;
    if (this.paintAcc < 0.05) return;
    this.paintAcc = 0;
    const arr = this.bindColors.array as Float32Array;
    let sum = 0;
    for (const c of this.rt) {
      const th = this.occupancy(c);
      sum += th;
      const g = 0.28 + 0.62 * th;
      for (let i = 0; i < c.count; i++) {
        const o = (c.start + i) * 3;
        arr[o] = g;
        arr[o + 1] = g;
        arr[o + 2] = g;
      }
    }
    this.meanOcc = this.rt.length > 0 ? sum / this.rt.length : 0;
    this.bindColors.needsUpdate = true;
  }

  statusLine(): string {
    const n = String(this.rt.length).padStart(3, "0");
    return `MOL n=${n}  θ=${this.meanOcc.toFixed(2)}`;
  }

  dispose(): void {
    this.wipe(this.group);
    for (const m of [this.priMat, this.secMat, this.bindMat, this.fieldMat, this.fieldPtMat]) {
      m.dispose();
    }
    this.group.removeFromParent();
  }

  private applyLook(): void {
    const scale = this.lastScale;
    const p = molecularPresence(scale);
    const d = molecularDepth(scale);
    const g = -Math.log10(Math.max(scale, 1e-12));
    const sm = this.scanMol;
    const sf = this.scanField;
    const np = nanoPresence(scale);
    const yieldVol = 1 - 0.48 * np;
    const yieldFrame = 1 - 0.20 * np;

    this.group.visible = p > 0.012;
    if (!this.group.visible) return;

    const mid = THREE.MathUtils.smoothstep(g, 2.55, 3.10);
    const field = THREE.MathUtils.smoothstep(g, 2.60, 3.25);

    this.priMat.opacity = 0.88 * p * sm * yieldFrame;
    this.secMat.opacity = 0.42 * p * (0.35 + 0.65 * mid) * sm * yieldVol;
    this.bindMat.opacity = 0.80 * p * sm * yieldVol;
    this.fieldMat.opacity = 0.32 * p * field * sf * yieldVol;
    this.fieldPtMat.opacity = 0.38 * p * field * sf * yieldVol;
    this.fieldPtMat.size = THREE.MathUtils.clamp(0.007 + 0.008 * (1 - d), 0.006, 0.014);

    this.secondaryG.visible = mid > 0.02;
    this.fieldG.visible = field > 0.02;
  }

  private occupancy(c: ComplexRuntime): number {
    const L = c.L0 + c.amp * 0.5 * (1 + Math.sin(c.omega * this.t + c.phase));
    let extra = c.bias;
    if (this.coupling) {
      extra += 0.12 * this.coupling.loadAt(c.position);
      extra += 0.10 * this.coupling.perfusionAt(c.position);
      extra -= 0.10 * this.coupling.thermalAt(c.position);
      extra += 0.08 * this.coupling.integrityAt(c.position);
    }
    return THREE.MathUtils.clamp(L / (c.kd + L) + extra, 0.02, 0.98);
  }

  private packSample(c: ComplexRuntime, dist: number): MolecularSample {
    let energy = funnel(dist, 0.055);
    let stress = 0;
    if (this.coupling) {
      energy *= 1 - 0.28 * this.coupling.integrityAt(c.position) - 0.18 * this.coupling.fieldAt(c.position);
      energy += 0.14 * this.coupling.thermalAt(c.position);
      energy = THREE.MathUtils.clamp(energy, 0, 1);
      stress = this.coupling.membraneStressAt(c.position);
    }
    return {
      cls: c.cls,
      dist,
      occupancy: this.occupancy(c),
      energy,
      hostKind: c.hostKind,
      position: c.position,
      stress,
    };
  }

  private build(sites: readonly CellSite[]): void {
    const pri = new LineSoup();
    const sec = new LineSoup();
    const bind = new LineSoup();
    const field = new LineSoup();
    const pts = new PointSoup();

    let idx = 0;
    for (const s of sites) {
      if (s.kind === "myocyte") {
        this.place(s, "channel", pri, sec, bind, field, pts, 0);
        if (idx % 2 === 0) this.place(s, "motor", pri, sec, bind, field, pts, 1);
        if (idx % 3 === 0) this.place(s, "enzyme", pri, sec, bind, field, pts, 2);
      } else if (s.kind === "perivascular") {
        this.place(s, "channel", pri, sec, bind, field, pts, 0);
        if (idx % 2 === 0) this.place(s, "enzyme", pri, sec, bind, field, pts, 1);
      } else {
        this.place(s, "npc", pri, sec, bind, field, pts, 0);
      }
      idx++;
    }

    this.primaryG.add(new THREE.LineSegments(pri.geometry(), this.priMat));
    this.secondaryG.add(new THREE.LineSegments(sec.geometry(), this.secMat));

    const bgeo = bind.geometry();
    const colors = new Float32Array(bind.vertexCount() * 3);
    colors.fill(0.5);
    this.bindColors = new THREE.BufferAttribute(colors, 3);
    bgeo.setAttribute("color", this.bindColors);
    this.primaryG.add(new THREE.LineSegments(bgeo, this.bindMat));

    this.fieldG.add(new THREE.LineSegments(field.geometry(), this.fieldMat));
    this.fieldG.add(new THREE.Points(pts.geometry(), this.fieldPtMat));
  }

  private place(
    site: CellSite,
    cls: ComplexClass,
    pri: LineSoup,
    sec: LineSoup,
    bind: LineSoup,
    field: LineSoup,
    pts: PointSoup,
    slot: number,
  ): void {
    const axis = site.axis.clone().normalize();
    const right = new THREE.Vector3();
    const up = new THREE.Vector3();
    basis(axis, right, up);

    const pos = offsetOnCell(site.position, axis, right, up, cls, slot);
    const start = bind.vertexCount();

    if (cls === "channel") this.drawChannel(pos, axis, right, up, pri, sec, bind);
    else if (cls === "motor") this.drawMotor(pos, axis, right, up, pri, sec, bind);
    else if (cls === "enzyme") this.drawEnzyme(pos, axis, right, up, pri, sec, bind);
    else this.drawNpc(pos, axis, right, up, pri, sec, bind);

    const kin = kinetics(cls);
    this.rt.push({
      position: pos,
      axis,
      cls,
      hostKind: site.kind,
      start,
      count: bind.vertexCount() - start,
      kd: kin.kd,
      omega: kin.omega,
      phase: hash(start + 11) * Math.PI * 2,
      L0: kin.L0,
      amp: kin.amp,
      bias: 0,
    });
    this.sites.push({ position: pos, axis, cls });

    this.drawFunnel(pos, axis, right, up, field, pts, cls);
  }

  /**
   * Tetrameric pore. Four subunits around a hoop — ion-channel schematic.
   */
  private drawChannel(
    c: THREE.Vector3,
    axis: THREE.Vector3,
    right: THREE.Vector3,
    up: THREE.Vector3,
    pri: LineSoup,
    sec: LineSoup,
    bind: LineSoup,
  ): void {
    const r = 0.018;
    const h = 0.022;
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      const p = offset(c, right, up, Math.cos(a) * r, Math.sin(a) * r);
      domain(sec, p, right, axis, up, 0.009, 0.016, 0.009, 4, 2, 6);
      pri.segV(c, p);
    }
    hoop(pri, c, right, up, r * 0.55, r * 0.55, 10);
    hoop(bind, offset(c, axis, up, h * 0.15, 0), right, up, r * 0.42, r * 0.42, 10);
    hoop(sec, offset(c, axis, up, -h * 0.35, 0), right, up, r * 0.70, r * 0.70, 8);
  }

  /**
   * Two heads + coiled-coil. Force-bearing along the fiber.
   */
  private drawMotor(
    c: THREE.Vector3,
    axis: THREE.Vector3,
    right: THREE.Vector3,
    up: THREE.Vector3,
    pri: LineSoup,
    sec: LineSoup,
    bind: LineSoup,
  ): void {
    const stem = 0.038;
    const head = offset(c, axis, right, stem, 0);
    const hL = offset(head, right, up, 0.012, 0.006);
    const hR = offset(head, right, up, -0.012, 0.006);
    pri.segV(c, head);
    // Coiled-coil twist ticks.
    for (let i = 1; i <= 3; i++) {
      const t = i / 4;
      const p = new THREE.Vector3().lerpVectors(c, head, t);
      const a = t * Math.PI * 2;
      pri.segV(
        offset(p, right, up, Math.cos(a) * 0.004, Math.sin(a) * 0.004),
        offset(p, right, up, -Math.cos(a) * 0.004, -Math.sin(a) * 0.004),
      );
    }
    domain(sec, hL, right, axis, up, 0.010, 0.011, 0.009, 4, 2, 6);
    domain(sec, hR, right, axis, up, 0.010, 0.011, 0.009, 4, 2, 6);
    pri.segV(head, hL);
    pri.segV(head, hR);
    hoop(bind, hL, right, up, 0.006, 0.006, 8);
    hoop(bind, hR, right, up, 0.006, 0.006, 8);
  }

  /**
   * Tetrahedral oligomer. Four domains, interface bonds.
   */
  private drawEnzyme(
    c: THREE.Vector3,
    axis: THREE.Vector3,
    right: THREE.Vector3,
    up: THREE.Vector3,
    pri: LineSoup,
    sec: LineSoup,
    bind: LineSoup,
  ): void {
    const s = 0.016;
    const verts = [
      offset(c, axis, up, s, s),
      offset(c, axis, up, s, -s),
      offset(c, right, up, s, 0).addScaledVector(axis, -s * 0.3),
      offset(c, right, up, -s, 0).addScaledVector(axis, -s * 0.3),
    ];
    for (const p of verts) {
      domain(sec, p, right, axis, up, 0.009, 0.009, 0.009, 4, 2, 6);
      pri.segV(c, p);
    }
    pri.segV(verts[0], verts[1]);
    pri.segV(verts[2], verts[3]);
    hoop(bind, c, right, up, 0.007, 0.007, 8);
  }

  /**
   * Octameric nuclear-pore ring + inner spokes.
   */
  private drawNpc(
    c: THREE.Vector3,
    axis: THREE.Vector3,
    right: THREE.Vector3,
    up: THREE.Vector3,
    pri: LineSoup,
    sec: LineSoup,
    bind: LineSoup,
  ): void {
    const r = 0.026;
    hoop(pri, c, right, up, r, r, 16);
    hoop(sec, c, right, up, r * 0.62, r * 0.62, 12);
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const p = offset(c, right, up, Math.cos(a) * r, Math.sin(a) * r);
      domain(sec, p, right, axis, up, 0.007, 0.007, 0.007, 3, 2, 5);
      pri.segV(c, p);
    }
    hoop(bind, c, right, up, r * 0.38, r * 0.38, 10);
  }

  /**
   * Funnel isolines + sparse radial ticks. E = (1 − e^{−r/λ})².
   */
  private drawFunnel(
    c: THREE.Vector3,
    axis: THREE.Vector3,
    right: THREE.Vector3,
    up: THREE.Vector3,
    field: LineSoup,
    pts: PointSoup,
    cls: ComplexClass,
  ): void {
    const lam = cls === "npc" ? 0.048 : 0.036;
    for (const k of [0.35, 0.65]) {
      const r = -lam * Math.log(1 - Math.sqrt(k));
      hoop(field, c, right, up, r, r * 0.85, 12);
    }
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      const r1 = lam * 0.4;
      const r2 = lam * 1.6;
      field.segV(
        offset(c, right, up, Math.cos(a) * r1, Math.sin(a) * r1),
        offset(c, right, up, Math.cos(a) * r2, Math.sin(a) * r2),
      );
    }
    for (let i = 0; i < 5; i++) {
      const a = hash(i * 17 + cls.length * 3) * Math.PI * 2;
      const rr = 0.3 * lam + hash(i * 31) * 1.2 * lam;
      pts.addV(offset(c, right, up, Math.cos(a) * rr, Math.sin(a) * rr));
    }
    void axis;
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

function kinetics(cls: ComplexClass): { kd: number; omega: number; L0: number; amp: number } {
  if (cls === "channel") return { kd: 0.40, omega: 0.55, L0: 0.45, amp: 0.40 };
  if (cls === "motor") return { kd: 0.70, omega: 0.38, L0: 0.40, amp: 0.35 };
  if (cls === "enzyme") return { kd: 0.32, omega: 0.70, L0: 0.50, amp: 0.38 };
  return { kd: 0.85, omega: 0.22, L0: 0.55, amp: 0.25 };
}

function offsetOnCell(
  c: THREE.Vector3,
  axis: THREE.Vector3,
  right: THREE.Vector3,
  up: THREE.Vector3,
  cls: ComplexClass,
  slot: number,
): THREE.Vector3 {
  // Sit on the membrane / cortex, not in the nuclear volume.
  if (cls === "channel") {
    const a = slot * 2.1 + 0.4;
    return offset(c, right, up, Math.cos(a) * 0.072, Math.sin(a) * 0.062);
  }
  if (cls === "motor") {
    return offset(c, axis, right, 0.04, 0.055);
  }
  if (cls === "enzyme") {
    return offset(c, axis, right, -0.03, -0.045);
  }
  return offset(c, axis, up, 0.02, 0.05);
}

function funnel(r: number, lam: number): number {
  const x = 1 - Math.exp(-r / lam);
  return THREE.MathUtils.clamp(x * x, 0, 1);
}

function lineMat(color: number, opacity: number, vertexColors: boolean): THREE.LineBasicMaterial {
  return new THREE.LineBasicMaterial({
    color,
    transparent: true,
    opacity,
    fog: true,
    vertexColors,
  });
}

class LineSoup {
  private readonly v: number[] = [];

  vertexCount(): number {
    return this.v.length / 3;
  }

  seg(ax: number, ay: number, az: number, bx: number, by: number, bz: number): void {
    this.v.push(ax, ay, az, bx, by, bz);
  }

  segV(a: THREE.Vector3, b: THREE.Vector3): void {
    this.seg(a.x, a.y, a.z, b.x, b.y, b.z);
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

function basis(normal: THREE.Vector3, right: THREE.Vector3, up: THREE.Vector3): void {
  const n = normal.clone().normalize();
  const tmp = Math.abs(n.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
  right.copy(tmp).cross(n).normalize();
  up.copy(n).cross(right).normalize();
}

function offset(
  c: THREE.Vector3,
  a: THREE.Vector3,
  b: THREE.Vector3,
  ua: number,
  ub: number,
): THREE.Vector3 {
  return new THREE.Vector3(
    c.x + a.x * ua + b.x * ub,
    c.y + a.y * ua + b.y * ub,
    c.z + a.z * ua + b.z * ub,
  );
}

function domain(
  s: LineSoup,
  c: THREE.Vector3,
  right: THREE.Vector3,
  along: THREE.Vector3,
  up: THREE.Vector3,
  rx: number,
  ry: number,
  rz: number,
  meridians: number,
  parallels: number,
  segs: number,
): void {
  for (let j = 1; j < parallels; j++) {
    const phi = (j / parallels) * Math.PI;
    const y = Math.cos(phi) * ry;
    const sp = Math.sin(phi);
    hoopAt(s, c, right, along, up, rx * sp, rz * sp, y, segs);
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
      const lx = rx * sp * ct;
      const ly = ry * cp;
      const lz = rz * sp * st;
      const x = c.x + right.x * lx + along.x * ly + up.x * lz;
      const y = c.y + right.y * lx + along.y * ly + up.y * lz;
      const z = c.z + right.z * lx + along.z * ly + up.z * lz;
      if (j > 0) s.seg(px, py, pz, x, y, z);
      px = x;
      py = y;
      pz = z;
    }
  }
}

function hoop(
  s: LineSoup,
  c: THREE.Vector3,
  right: THREE.Vector3,
  up: THREE.Vector3,
  rx: number,
  rz: number,
  segs: number,
): void {
  let px = 0, py = 0, pz = 0;
  for (let i = 0; i <= segs; i++) {
    const a = (i / segs) * Math.PI * 2;
    const x = c.x + right.x * Math.cos(a) * rx + up.x * Math.sin(a) * rz;
    const y = c.y + right.y * Math.cos(a) * rx + up.y * Math.sin(a) * rz;
    const z = c.z + right.z * Math.cos(a) * rx + up.z * Math.sin(a) * rz;
    if (i > 0) s.seg(px, py, pz, x, y, z);
    px = x;
    py = y;
    pz = z;
  }
}

function hoopAt(
  s: LineSoup,
  c: THREE.Vector3,
  right: THREE.Vector3,
  along: THREE.Vector3,
  up: THREE.Vector3,
  rx: number,
  rz: number,
  yAlong: number,
  segs: number,
): void {
  hoop(
    s,
    new THREE.Vector3(
      c.x + along.x * yAlong,
      c.y + along.y * yAlong,
      c.z + along.z * yAlong,
    ),
    right,
    up,
    rx,
    rz,
    segs,
  );
}

function hash(i: number): number {
  const s = Math.sin(i * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}
