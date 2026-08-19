import * as THREE from "three";
import { nanoDepth, nanoPresence } from "./ScaleManager";
import type { ComplexClass, ComplexSite } from "./MolecularLayer";
import type { CascadeReader } from "./CascadeSystem";
import { freezeStatic } from "./freezeStatic";

/**
 * Nano / field structural overlay. Not a full quantum simulation.
 *
 * Consumes MolecularLayer.getSites(). Subscribes via main.ts.
 * ScaleManager stays geometry-free.
 *
 * Built once. Revealed in place:
 *   cages + potential hoops     ← nanoPresence
 *   coherence meridians         ← mid depth
 *   assembler overlays          ← written, persistent, relaxing
 *
 * Science, abstracted:
 *   Cage        — local scaffolding around a complex (substrate lattice).
 *   Potential   — hoop isolines of a local well.
 *   Coherence   — two meridians; amplitude is a node fieldAmp.
 *   Substrate   — local monomer pool per node. Reinforcement consumes it.
 *   Integrity   — structural completeness. Relaxes toward a thermal floor.
 *
 * Assembler writes (constrained, see Assembler.ts):
 *   reinforce()     extra struts, +integrity, −substrate
 *   modulateField() extra meridians, +fieldAmp
 *
 * Materials: LineBasicMaterial + PointsMaterial. Monochrome.
 */

export interface NanoSample {
  dist: number;
  integrity: number;
  fieldAmp: number;
  substrate: number;
  coherence: number;
  host: ComplexClass;
  position: THREE.Vector3;
}

interface NanoNode {
  position: THREE.Vector3;
  axis: THREE.Vector3;
  host: ComplexClass;
  integrity: number;
  fieldAmp: number;
  substrate: number;
  phase: number;
}

export class NanoFieldLayer {
  readonly group = new THREE.Group();

  private readonly cageG = new THREE.Group();
  private readonly fieldG = new THREE.Group();
  private readonly writeG = new THREE.Group();

  private readonly cageMat = lineMat(0xe8e8e8, 0);
  private readonly wellMat = lineMat(0x9a9a9a, 0);
  private readonly cohMat = lineMat(0xc4c4c4, 0);
  private readonly writeMat = lineMat(0xffffff, 0.0);
  private readonly ptMat = new THREE.PointsMaterial({
    color: 0x888888,
    size: 0.006,
    sizeAttenuation: true,
    transparent: true,
    opacity: 0,
    fog: true,
  });

  private readonly nodes: NanoNode[] = [];
  private readonly writeSoup = new LineSoup();
  private writeLines: THREE.LineSegments | null = null;
  private t = 0;
  private lastScale = 1;
  private scanNano = 1;
  private scanField = 1;
  private coupling: CascadeReader | null = null;

  constructor(scene: THREE.Scene, sites: readonly ComplexSite[]) {
    this.group.name = "NanoFieldLayer";
    this.group.visible = false;
    this.group.add(this.cageG, this.fieldG, this.writeG);
    scene.add(this.group);
    this.build(sites);
    freezeStatic(this.group);
  }

  syncScale(scale: number): void {
    this.lastScale = scale;
    this.applyLook();
  }

  setScanGain(nano: number, fields: number): void {
    this.scanNano = nano;
    this.scanField = fields;
    this.applyLook();
  }

  bindCascade(c: CascadeReader): void {
    this.coupling = c;
  }

  sampleNearest(p: THREE.Vector3, maxDist: number): NanoSample | null {
    if (nanoPresence(this.lastScale) < 0.08) return null;
    const n = this.nearest(p, maxDist);
    if (!n) return null;
    return this.toSample(n.node, n.dist);
  }

  /**
   * Structural reinforcement. Caller has already paid the energy bill.
   * Returns false if no node, no substrate, or integrity cap.
   */
  reinforce(p: THREE.Vector3, maxDist: number, subCost: number): boolean {
    const hit = this.nearest(p, maxDist);
    if (!hit) return false;
    const n = hit.node;
    if (n.substrate < subCost) return false;
    if (n.integrity >= 0.92) return false;
    n.substrate -= subCost;
    n.integrity = Math.min(0.92, n.integrity + 0.12);
    this.stampStruts(n);
    return true;
  }

  /**
   * Field capacitor charge. Extra meridians persist. Relaxes.
   */
  modulateField(p: THREE.Vector3, maxDist: number): boolean {
    const hit = this.nearest(p, maxDist);
    if (!hit) return false;
    const n = hit.node;
    if (n.fieldAmp >= 0.95) return false;
    n.fieldAmp = Math.min(0.95, n.fieldAmp + 0.14);
    this.stampField(n);
    return true;
  }

  consumeSubstrate(p: THREE.Vector3, maxDist: number, amount: number): boolean {
    const hit = this.nearest(p, maxDist);
    if (!hit || hit.node.substrate < amount) return false;
    hit.node.substrate -= amount;
    return true;
  }

  update(dt: number): void {
    if (dt <= 0) return;
    this.t += dt;
    const np = nanoPresence(this.lastScale);
    // Shallow scales: freeze node relaxation. Resume on re-entry.
    if (np < 0.012) {
      this.writeMat.opacity = 0;
      return;
    }
    // Thermal relaxation: structure and field decay toward rest.
    // Substrate slowly re-equilibrates from the molecular bath.
    const kI = Math.exp(-dt / 22);
    const kF = Math.exp(-dt / 14);
    for (const n of this.nodes) {
      const restI = 0.35 + (this.coupling ? this.coupling.integrityRestDelta(n.position) : 0);
      n.integrity = restI + (n.integrity - restI) * kI;
      n.fieldAmp = 0.40 + (n.fieldAmp - 0.40) * kF;
      const rest = 0.55;
      n.substrate += (rest - n.substrate) * (1 - Math.exp(-dt / 18)) * (0.4 + 0.6 * np);
    }
    this.writeMat.opacity = 0.72 * np * this.scanNano;
  }

  statusLine(): string {
    const n = String(this.nodes.length).padStart(3, "0");
    let i = 0;
    let f = 0;
    for (const nd of this.nodes) {
      i += nd.integrity;
      f += nd.fieldAmp;
    }
    const m = this.nodes.length || 1;
    return `NANO n=${n}  I=${(i / m).toFixed(2)}  Φ=${(f / m).toFixed(2)}`;
  }

  dispose(): void {
    this.wipe(this.group);
    for (const m of [this.cageMat, this.wellMat, this.cohMat, this.writeMat, this.ptMat]) {
      m.dispose();
    }
    this.group.removeFromParent();
  }

  private applyLook(): void {
    const scale = this.lastScale;
    const p = nanoPresence(scale);
    const d = nanoDepth(scale);
    const g = -Math.log10(Math.max(scale, 1e-12));
    const sn = this.scanNano;
    const sf = this.scanField;

    this.group.visible = p > 0.012;
    if (!this.group.visible) return;

    const mid = THREE.MathUtils.smoothstep(g, 3.55, 4.10);

    this.cageMat.opacity = 0.70 * p * sn;
    this.wellMat.opacity = 0.34 * p * (0.4 + 0.6 * mid) * sf;
    this.cohMat.opacity = 0.40 * p * mid * sf;
    this.ptMat.opacity = 0.36 * p * mid * sf;
    this.ptMat.size = THREE.MathUtils.clamp(0.004 + 0.005 * (1 - d), 0.0035, 0.009);
    this.writeMat.opacity = 0.72 * p * sn;

    this.fieldG.visible = mid > 0.02;
  }

  private nearest(
    p: THREE.Vector3,
    maxDist: number,
  ): { node: NanoNode; dist: number } | null {
    let best: NanoNode | null = null;
    let bestD = maxDist;
    for (const n of this.nodes) {
      const d = p.distanceTo(n.position);
      if (d < bestD) {
        bestD = d;
        best = n;
      }
    }
    return best ? { node: best, dist: bestD } : null;
  }

  private toSample(n: NanoNode, dist: number): NanoSample {
    let coh = n.fieldAmp * (0.5 + 0.5 * Math.sin(this.t * 1.35 + n.phase));
    if (this.coupling) coh *= 1 + this.coupling.coherenceModAt(n.position);
    return {
      dist,
      integrity: n.integrity,
      fieldAmp: n.fieldAmp,
      substrate: n.substrate,
      coherence: THREE.MathUtils.clamp(coh, 0, 1),
      host: n.host,
      position: n.position,
    };
  }

  private build(sites: readonly ComplexSite[]): void {
    const cage = new LineSoup();
    const well = new LineSoup();
    const coh = new LineSoup();
    const pts = new PointSoup();

    for (const s of sites) {
      const axis = s.axis.clone().normalize();
      const right = new THREE.Vector3();
      const up = new THREE.Vector3();
      basis(axis, right, up);
      this.nodes.push({
        position: s.position.clone(),
        axis,
        host: s.cls,
        integrity: 0.38,
        fieldAmp: 0.42,
        substrate: 0.62,
        phase: hash(this.nodes.length * 13) * Math.PI * 2,
      });
      this.drawCage(s.position, right, axis, up, cage);
      hoop(well, s.position, right, up, 0.014, 0.012, 10);
      hoop(well, s.position, right, up, 0.022, 0.018, 10);
      meridian(coh, s.position, right, axis, 0.020, 8);
      meridian(coh, s.position, up, axis, 0.020, 8);
      pts.addV(s.position);
    }

    this.cageG.add(new THREE.LineSegments(cage.geometry(), this.cageMat));
    this.fieldG.add(new THREE.LineSegments(well.geometry(), this.wellMat));
    this.fieldG.add(new THREE.LineSegments(coh.geometry(), this.cohMat));
    this.fieldG.add(new THREE.Points(pts.geometry(), this.ptMat));

    this.writeLines = new THREE.LineSegments(this.writeSoup.geometry(), this.writeMat);
    this.writeG.add(this.writeLines);
  }

  private drawCage(
    c: THREE.Vector3,
    right: THREE.Vector3,
    axis: THREE.Vector3,
    up: THREE.Vector3,
    s: LineSoup,
  ): void {
    const a = 0.011;
    const p: THREE.Vector3[] = [
      offset(c, right, up, a, a),
      offset(c, right, up, a, -a),
      offset(c, right, up, -a, -a),
      offset(c, right, up, -a, a),
      offset(c, axis, right, a, 0),
      offset(c, axis, right, -a, 0),
    ];
    // Octahedron: 4 equatorial + 2 poles.
    for (let i = 0; i < 4; i++) s.segV(p[i], p[(i + 1) % 4]);
    for (let i = 0; i < 4; i++) {
      s.segV(p[4], p[i]);
      s.segV(p[5], p[i]);
    }
  }

  private stampStruts(n: NanoNode): void {
    const right = new THREE.Vector3();
    const up = new THREE.Vector3();
    basis(n.axis, right, up);
    const a = 0.008 + n.integrity * 0.010;
    const ang = n.integrity * 5.2;
    for (let i = 0; i < 4; i++) {
      const th = ang + (i / 4) * Math.PI * 2;
      const p0 = offset(n.position, right, up, Math.cos(th) * a, Math.sin(th) * a);
      const p1 = offset(n.position, n.axis, right, a * 0.7, 0);
      this.writeSoup.segV(p0, p1);
    }
    this.flushWrite();
  }

  private stampField(n: NanoNode): void {
    const right = new THREE.Vector3();
    const up = new THREE.Vector3();
    basis(n.axis, right, up);
    const r = 0.016 + n.fieldAmp * 0.012;
    hoop(this.writeSoup, n.position, right, up, r, r * 0.85, 10);
    this.flushWrite();
  }

  private flushWrite(): void {
    if (!this.writeLines) return;
    this.writeLines.geometry.dispose();
    this.writeLines.geometry = this.writeSoup.geometry();
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

function meridian(
  s: LineSoup,
  c: THREE.Vector3,
  right: THREE.Vector3,
  along: THREE.Vector3,
  r: number,
  segs: number,
): void {
  let px = 0, py = 0, pz = 0;
  for (let i = 0; i <= segs; i++) {
    const a = (i / segs) * Math.PI;
    const x = c.x + right.x * Math.sin(a) * r + along.x * Math.cos(a) * r;
    const y = c.y + right.y * Math.sin(a) * r + along.y * Math.cos(a) * r;
    const z = c.z + right.z * Math.sin(a) * r + along.z * Math.cos(a) * r;
    if (i > 0) s.seg(px, py, pz, x, y, z);
    px = x;
    py = y;
    pz = z;
  }
}

function hash(i: number): number {
  const s = Math.sin(i * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}
