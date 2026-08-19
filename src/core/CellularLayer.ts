import * as THREE from "three";
import { cellularDepth, cellularPresence, molecularPresence, nanoPresence } from "./ScaleManager";
import type { CellAnchor, CellKind } from "./TissueLayer";
import type { CascadeReader } from "./CascadeSystem";
import { freezeStatic } from "./freezeStatic";

export interface CellSite {
  readonly position: THREE.Vector3;
  readonly axis: THREE.Vector3;
  readonly kind: CellKind;
}

/**
 * Cellular structural field. No tools. No Hodgkin–Huxley. No molecules.
 *
 * Consumes TissueLayer.getCellAnchors(). Subscribes via main.ts.
 * ScaleManager stays geometry-free.
 *
 * Built once. Revealed in place (same LOD stack as tissue):
 *   myocyte membranes + nuclei     ← cellularPresence
 *   perivascular                   ← mid depth
 *   stromal + mito                 ← fine depth
 *   actin cortex + microtubules    ← cytoskeleton depth
 *
 * Science, abstracted:
 *   Membrane     — closed phospholipid bilayer as a wire ellipsoid.
 *                  Myocytes are prolate along the fiber (fascicle packing).
 *   Nucleus      — dominant organelle. Peripheral in myocytes
 *                  (subsarcolemmal), central in stromal / perivascular.
 *   Actin cortex — thin inner shell, hoop bias (cortical tension).
 *   Microtubules — MTOC near the nucleus; myocytes biased along the
 *                  long axis (force-bearing), others more radial.
 *   Mito         — cytoplasmic point clusters. Denser in myocytes (ATP).
 *   Vm           — not an action-potential network. Resting potential
 *                  with slow conductance noise. Vertex grayscale on
 *                  membranes only. Nucleus and cytoskeleton stay structural.
 *
 * Materials: LineBasicMaterial + PointsMaterial. Monochrome.
 */

export interface CellSample {
  kind: CellKind;
  dist: number;
  vm: number;
  position: THREE.Vector3;
  /** Membrane stress from cascade + tissue load. 0 idle. */
  stress: number;
}

interface CellRuntime {
  start: number;
  count: number;
  rest: number;
  amp: number;
  omega: number;
  phase: number;
  position: THREE.Vector3;
  kind: CellKind;
}

interface Batch {
  colors: THREE.BufferAttribute;
  rt: CellRuntime[];
}

export class CellularLayer {
  readonly group = new THREE.Group();

  private readonly myoG = new THREE.Group();
  private readonly periG = new THREE.Group();
  private readonly stromaG = new THREE.Group();
  private readonly cytoG = new THREE.Group();
  private readonly mitoG = new THREE.Group();

  private readonly memMyoMat = lineMat(0xffffff, 0, true);
  private readonly memPeriMat = lineMat(0xffffff, 0, true);
  private readonly memStromaMat = lineMat(0xffffff, 0, true);
  private readonly nucMat = lineMat(0xf4f4f4, 0, false);
  private readonly actinMat = lineMat(0xe8e8e8, 0, false);
  private readonly mtMat = lineMat(0x8a8a8a, 0, false);
  private readonly mitoMat = new THREE.PointsMaterial({
    color: 0x7a7a7a,
    size: 0.018,
    sizeAttenuation: true,
    transparent: true,
    opacity: 0,
    fog: true,
  });

  private readonly batches: Batch[] = [];
  private readonly myoRt: CellRuntime[] = [];
  private readonly allRt: CellRuntime[] = [];
  private readonly sites: CellSite[] = [];
  private t = 0;
  private meanVm = -75;
  private cellCount = 0;
  private lastScale = 1;
  private scanCellular = 1;
  private coupling: CascadeReader | null = null;
  private paintAcc = 0;

  constructor(scene: THREE.Scene, anchors: readonly CellAnchor[]) {
    this.group.name = "CellularLayer";
    this.group.visible = false;
    this.group.add(this.myoG, this.periG, this.stromaG, this.cytoG, this.mitoG);
    scene.add(this.group);
    for (const a of anchors) {
      this.sites.push({
        position: a.position.clone(),
        axis: a.axis.clone(),
        kind: a.kind,
      });
    }
    this.build(anchors);
    freezeStatic(this.group);
  }

  /**
   * Frozen cell-site table for MolecularLayer. Same identity for life.
   * Position + fiber axis + kind. Treat as immutable.
   */
  getSites(): readonly CellSite[] {
    return this.sites;
  }

  /**
   * ScaleManager drive. Safe every frame.
   * Geometry is static. Opacities and group visibility only.
   */
  syncScale(scale: number): void {
    this.lastScale = scale;
    this.applyLook();
  }

  /** Scanner channel gain. 1 = idle. Does not rebuild. */
  setScanGain(cellular: number): void {
    this.scanCellular = cellular;
    this.applyLook();
  }

  bindCascade(c: CascadeReader): void {
    this.coupling = c;
  }

  /**
   * Nearest live cell within maxDist. Vm from the same oscillator the
   * membrane already displays — probe reads, it does not invent.
   */
  sampleNearest(p: THREE.Vector3, maxDist: number): CellSample | null {
    if (cellularPresence(this.lastScale) < 0.08) return null;
    let best: CellRuntime | null = null;
    let bestD = maxDist;
    for (const c of this.allRt) {
      const d = p.distanceTo(c.position);
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
    if (!best) return null;
    return {
      kind: best.kind,
      dist: bestD,
      vm: this.grayToVm(this.liveGray(best)),
      position: best.position,
      stress: this.coupling ? this.coupling.membraneStressAt(best.position) : 0,
    };
  }

  private applyLook(): void {
    const scale = this.lastScale;
    const p = cellularPresence(scale);
    const d = cellularDepth(scale);
    const g = -Math.log10(Math.max(scale, 1e-12));
    const sc = this.scanCellular;
    const mp = molecularPresence(scale);
    const np = nanoPresence(scale);
    const yieldVol = (1 - 0.58 * mp) * (1 - 0.22 * np);
    const yieldFrame = (1 - 0.22 * mp) * (1 - 0.10 * np);

    this.group.visible = p > 0.012;
    if (!this.group.visible) return;

    const peri = THREE.MathUtils.smoothstep(g, 1.55, 2.05);
    const stroma = THREE.MathUtils.smoothstep(g, 1.75, 2.25);
    const cyto = THREE.MathUtils.smoothstep(g, 1.50, 2.10);
    const mito = THREE.MathUtils.smoothstep(g, 1.80, 2.40);

    this.memMyoMat.opacity = 0.82 * p * sc * yieldFrame;
    this.memPeriMat.opacity = 0.70 * p * peri * sc * yieldVol;
    this.memStromaMat.opacity = 0.58 * p * stroma * sc * yieldVol;
    this.nucMat.opacity = 0.92 * p * (0.55 + 0.45 * cyto) * sc * yieldFrame;
    this.actinMat.opacity = 0.55 * p * cyto * sc * yieldVol;
    this.mtMat.opacity = 0.40 * p * cyto * sc * yieldVol;
    this.mitoMat.opacity = 0.55 * p * mito * sc * yieldVol;
    this.mitoMat.size = THREE.MathUtils.clamp(0.012 + 0.010 * (1 - d), 0.012, 0.022);

    this.periG.visible = peri > 0.02;
    this.stromaG.visible = stroma > 0.02;
    this.cytoG.visible = cyto > 0.02;
    this.mitoG.visible = mito > 0.02;
  }

  /**
   * Live response. Call from the frame loop, not from onScaleChanged.
   * Slow Vm noise only. No AP wave.
   */
  update(dt: number): void {
    if (!this.group.visible || dt <= 0) return;
    this.t += dt;
    this.paintAcc += dt;
    if (this.paintAcc < 0.05) return;
    this.paintAcc = 0;

    let sum = 0;
    let n = 0;
    for (const b of this.batches) {
      const arr = b.colors.array as Float32Array;
      for (const c of b.rt) {
        const g = this.liveGray(c);
        for (let i = 0; i < c.count; i++) {
          const o = (c.start + i) * 3;
          arr[o] = g;
          arr[o + 1] = g;
          arr[o + 2] = g;
        }
        if (b === this.batches[0]) {
          sum += g;
          n++;
        }
      }
      b.colors.needsUpdate = true;
    }
    if (n > 0) {
      // Map brightness 0.45–0.70 → roughly −80 to −62 mV. Rest ~−74.
      this.meanVm = this.grayToVm(sum / n);
    }
  }

  private liveGray(c: CellRuntime): number {
    let g = c.rest + c.amp * 0.5 * (1 + Math.sin(c.omega * this.t + c.phase));
    if (this.coupling) {
      g += 0.11 * this.coupling.membraneStressAt(c.position);
      g += 0.07 * this.coupling.occupancyAt(c.position);
      g += 0.04 * this.coupling.loadAt(c.position);
    }
    return THREE.MathUtils.clamp(g, 0.22, 0.95);
  }

  private grayToVm(g: number): number {
    return -95 + 42 * g;
  }

  statusLine(): string {
    const n = String(this.cellCount).padStart(3, "0");
    const vm = Math.round(this.meanVm);
    return `CELL n=${n}  Vm=${vm}mV`;
  }

  dispose(): void {
    this.wipe(this.group);
    for (const m of [
      this.memMyoMat, this.memPeriMat, this.memStromaMat,
      this.nucMat, this.actinMat, this.mtMat, this.mitoMat,
    ]) {
      m.dispose();
    }
    this.group.removeFromParent();
  }

  private build(anchors: readonly CellAnchor[]): void {
    const myoMem = new LineSoup();
    const periMem = new LineSoup();
    const stromaMem = new LineSoup();
    const myoNuc = new LineSoup();
    const periNuc = new LineSoup();
    const stromaNuc = new LineSoup();
    const actin = new LineSoup();
    const mt = new LineSoup();
    const mito = new PointSoup();

    const periRt: CellRuntime[] = [];
    const stromaRt: CellRuntime[] = [];

    for (const a of anchors) {
      if (a.kind === "myocyte") {
        this.stamp(a, myoMem, myoNuc, actin, mt, mito, this.myoRt);
      } else if (a.kind === "perivascular") {
        this.stamp(a, periMem, periNuc, actin, mt, mito, periRt);
      } else {
        this.stamp(a, stromaMem, stromaNuc, actin, mt, mito, stromaRt);
      }
    }

    this.cellCount = anchors.length;

    this.mountMem(this.myoG, myoMem, this.memMyoMat, this.myoRt);
    this.mountMem(this.periG, periMem, this.memPeriMat, periRt);
    this.mountMem(this.stromaG, stromaMem, this.memStromaMat, stromaRt);

    this.addLines(this.myoG, myoNuc, this.nucMat);
    this.addLines(this.periG, periNuc, this.nucMat);
    this.addLines(this.stromaG, stromaNuc, this.nucMat);
    this.addLines(this.cytoG, actin, this.actinMat);
    this.addLines(this.cytoG, mt, this.mtMat);
    this.mitoG.add(new THREE.Points(mito.geometry(), this.mitoMat));
  }

  private addLines(parent: THREE.Group, soup: LineSoup, mat: THREE.LineBasicMaterial): void {
    if (soup.vertexCount() === 0) return;
    parent.add(new THREE.LineSegments(soup.geometry(), mat));
  }

  private mountMem(
    parent: THREE.Group,
    soup: LineSoup,
    mat: THREE.LineBasicMaterial,
    rt: CellRuntime[],
  ): void {
    if (soup.vertexCount() === 0) return;
    const geo = soup.geometry();
    const colors = new Float32Array(soup.vertexCount() * 3);
    for (const c of rt) {
      for (let i = 0; i < c.count; i++) {
        const o = (c.start + i) * 3;
        colors[o] = c.rest;
        colors[o + 1] = c.rest;
        colors[o + 2] = c.rest;
      }
    }
    const attr = new THREE.BufferAttribute(colors, 3);
    geo.setAttribute("color", attr);
    const lines = new THREE.LineSegments(geo, mat);
    parent.add(lines);
    this.batches.push({ colors: attr, rt });
  }

  private stamp(
    a: CellAnchor,
    mem: LineSoup,
    nuc: LineSoup,
    actin: LineSoup,
    mt: LineSoup,
    mito: PointSoup,
    rt: CellRuntime[],
  ): void {
    const dim = dims(a.kind);
    const axis = a.axis.clone().normalize();
    const right = new THREE.Vector3();
    const up = new THREE.Vector3();
    basis(axis, right, up);

    const start = mem.vertexCount();
    ellipsoid(mem, a.position, right, axis, up, dim.rx, dim.ry, dim.rz, 7, 4, 10);
    const rec: CellRuntime = {
      start,
      count: mem.vertexCount() - start,
      rest: dim.rest,
      amp: dim.amp,
      omega: dim.omega,
      phase: hash(start + 17) * Math.PI * 2,
      position: a.position.clone(),
      kind: a.kind,
    };
    rt.push(rec);
    this.allRt.push(rec);

    // Nucleus: peripheral in myocytes (subsarcolemmal), central otherwise.
    const nOff = a.kind === "myocyte" ? dim.rx * 0.52 : 0;
    const nShift = a.kind === "myocyte" ? -dim.ry * 0.12 : 0;
    const nPos = offset(a.position, right, axis, nOff, nShift);
    ellipsoid(nuc, nPos, right, axis, up, dim.rx * 0.36, dim.ry * 0.28, dim.rz * 0.36, 5, 3, 8);

    // Actin cortex: inner shell + two hoop rings (cortical tension).
    ellipsoid(actin, a.position, right, axis, up, dim.rx * 0.90, dim.ry * 0.90, dim.rz * 0.90, 5, 2, 8);
    hoop(actin, a.position, right, up, dim.rx * 0.88, dim.rz * 0.88, 10);
    hoop(actin, offset(a.position, axis, up, dim.ry * 0.25, 0), right, up, dim.rx * 0.78, dim.rz * 0.78, 10);

    // Microtubules from MTOC (centrosome, near nucleus, toward centroid).
    const mtoc = new THREE.Vector3().lerpVectors(nPos, a.position, 0.4);
    const rays = a.kind === "myocyte" ? 6 : 5;
    for (let i = 0; i < rays; i++) {
      const t = a.kind === "myocyte"
        ? (i / (rays - 1) - 0.5) * 1.6
        : (i / rays) * Math.PI * 2;
      let tip: THREE.Vector3;
      if (a.kind === "myocyte") {
        // Long-axis bias: force-bearing along the fiber.
        const ang = (hash(start + i * 3) - 0.5) * 0.8;
        tip = offset(
          a.position,
          axis, right,
          t * dim.ry * 0.92,
          Math.sin(ang) * dim.rx * 0.75,
        );
      } else {
        tip = offset(
          a.position,
          right, up,
          Math.cos(t) * dim.rx * 0.88,
          Math.sin(t) * dim.rz * 0.88,
        );
      }
      mt.segV(mtoc, tip);
    }

    const nMito = a.kind === "myocyte" ? 7 : a.kind === "perivascular" ? 4 : 3;
    for (let i = 0; i < nMito; i++) {
      const u = hash(start + 40 + i) * Math.PI * 2;
      const v = (hash(start + 90 + i) - 0.5) * 1.4;
      const rad = 0.45 + 0.35 * hash(start + 130 + i);
      mito.addV(offset(
        a.position,
        right, axis,
        Math.cos(u) * dim.rx * rad,
        v * dim.ry * 0.55,
      ));
    }
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

function dims(kind: CellKind): {
  rx: number; ry: number; rz: number;
  rest: number; amp: number; omega: number;
} {
  if (kind === "myocyte") {
    return { rx: 0.068, ry: 0.20, rz: 0.060, rest: 0.52, amp: 0.11, omega: 2.2 };
  }
  if (kind === "perivascular") {
    return { rx: 0.048, ry: 0.12, rz: 0.044, rest: 0.40, amp: 0.055, omega: 1.1 };
  }
  return { rx: 0.070, ry: 0.078, rz: 0.066, rest: 0.36, amp: 0.03, omega: 0.7 };
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

function ellipsoid(
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
  const cc = new THREE.Vector3(
    c.x + along.x * yAlong,
    c.y + along.y * yAlong,
    c.z + along.z * yAlong,
  );
  hoop(s, cc, right, up, rx, rz, segs);
}

function hash(i: number): number {
  const s = Math.sin(i * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}
