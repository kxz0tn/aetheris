import * as THREE from "three";
import { freezeStatic } from "./freezeStatic";

/**
 * Calibration field. Two layers so densification is spatial, not a shrink.
 *
 *   Room     — coarse cardinal planes, fixed spacing. The theater walls.
 *              Built once. Fades slightly on descent so it does not fight
 *              the fine field.
 *   Theater  — scale-driven. Plane grids + volumetric ticks around the twin.
 *              spacing = baseSpacing * scale. Extent stays put; when the
 *              point budget would explode, planes keep densifying and the
 *              3D ticks cap. That is in-place subdivision under a GPU budget.
 *
 * syncScale() is the ScaleManager hook. Safe every frame.
 *
 * Materials: LineBasicMaterial + PointsMaterial only.
 */
export class ReferenceLattice {
  readonly group = new THREE.Group();

  private readonly theater = new THREE.Group();

  private readonly baseSpacing = 4;
  private readonly theaterExtent = 20;
  private readonly maxPlaneHalf = 36;
  private readonly maxPointHalf = 12;

  private builtKey = "";

  private readonly originMat = new THREE.LineBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.55,
    fog: true,
  });
  private readonly roomMat = new THREE.LineBasicMaterial({
    color: 0x5c5c5c,
    transparent: true,
    opacity: 0.22,
    fog: true,
  });
  private readonly gridMat = new THREE.LineBasicMaterial({
    color: 0x9a9a9a,
    transparent: true,
    opacity: 0.42,
    fog: true,
  });
  private readonly tickMat = new THREE.PointsMaterial({
    color: 0x6e6e6e,
    size: 0.10,
    sizeAttenuation: true,
    fog: true,
  });

  constructor(scene: THREE.Scene) {
    this.group.name = "ReferenceLattice";
    this.theater.name = "LatticeTheater";
    this.group.add(this.theater);
    scene.add(this.group);

    this.group.add(new THREE.LineSegments(this.buildRoom(), this.roomMat));
    this.syncScale(1.0);
    freezeStatic(this.group);
  }

  /**
   * ScaleManager drive point. Safe to call every frame.
   * Rebuilds the theater layer only when quantized spacing changes.
   */
  syncScale(scale: number): void {
    const safe = Math.max(scale, 1e-12);
    const spacing = this.baseSpacing * safe;
    const key = spacing.toPrecision(3);
    if (key === this.builtKey) return;
    this.builtKey = key;
    this.rebuildTheater(spacing, safe);
  }

  dispose(): void {
    this.wipe(this.theater);
    for (const child of [...this.group.children]) {
      if (child === this.theater) continue;
      this.group.remove(child);
      if (child instanceof THREE.LineSegments) child.geometry.dispose();
    }
    this.originMat.dispose();
    this.roomMat.dispose();
    this.gridMat.dispose();
    this.tickMat.dispose();
    this.group.removeFromParent();
  }

  private rebuildTheater(spacing: number, scale: number): void {
    this.wipe(this.theater);

    const planeHalf = Math.min(
      Math.max(1, Math.floor(this.theaterExtent / spacing)),
      this.maxPlaneHalf,
    );
    const pointHalf = Math.min(
      Math.max(1, Math.floor(this.theaterExtent / spacing)),
      this.maxPointHalf,
    );
    const span = planeHalf * spacing;

    this.tickMat.size = THREE.MathUtils.clamp(0.045 + 0.07 * Math.sqrt(scale), 0.04, 0.12);
    this.gridMat.opacity = THREE.MathUtils.clamp(0.28 + 0.20 * scale, 0.28, 0.50);
    this.originMat.opacity = THREE.MathUtils.clamp(0.35 + 0.25 * scale, 0.35, 0.60);
    this.roomMat.opacity = THREE.MathUtils.clamp(0.10 + 0.14 * scale, 0.10, 0.24);

    this.theater.add(new THREE.LineSegments(this.buildOrigin(span), this.originMat));
    this.theater.add(new THREE.LineSegments(this.buildPlanes(planeHalf, spacing), this.gridMat));
    this.theater.add(new THREE.Points(this.buildTicks(pointHalf, spacing), this.tickMat));
    freezeStatic(this.theater);
  }

  /** Sparse room cage. Fixed. Not a skybox. */
  private buildRoom(): THREE.BufferGeometry {
    const verts: number[] = [];
    const spacing = 8;
    const n = 6; // extent 48
    const push = (
      ax: number, ay: number, az: number,
      bx: number, by: number, bz: number,
    ): void => {
      verts.push(ax, ay, az, bx, by, bz);
    };
    for (let i = -n; i <= n; i++) {
      const a = i * spacing;
      const e = n * spacing;
      push(-e, a, 0, e, a, 0);
      push(a, -e, 0, a, e, 0);
      push(-e, 0, a, e, 0, a);
      push(a, 0, -e, a, 0, e);
      push(0, -e, a, 0, e, a);
      push(0, a, -e, 0, a, e);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
    return geo;
  }

  private buildOrigin(span: number): THREE.BufferGeometry {
    const s = span;
    const positions = new Float32Array([
      -s, 0, 0,  s, 0, 0,
      0, -s, 0,  0, s, 0,
      0, 0, -s,  0, 0, s,
    ]);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    return geo;
  }

  private buildPlanes(half: number, spacing: number): THREE.BufferGeometry {
    const verts: number[] = [];
    const n = half;
    const push = (
      ax: number, ay: number, az: number,
      bx: number, by: number, bz: number,
    ): void => {
      verts.push(ax, ay, az, bx, by, bz);
    };
    for (let i = -n; i <= n; i++) {
      const a = i * spacing;
      const e = n * spacing;
      push(-e, a, 0, e, a, 0);
      push(a, -e, 0, a, e, 0);
      push(-e, 0, a, e, 0, a);
      push(a, 0, -e, a, 0, e);
      push(0, -e, a, 0, e, a);
      push(0, a, -e, 0, a, e);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
    return geo;
  }

  private buildTicks(half: number, spacing: number): THREE.BufferGeometry {
    const n = half;
    const count = (2 * n + 1) ** 3 - 1;
    const positions = new Float32Array(Math.max(count, 0) * 3);
    let w = 0;
    for (let ix = -n; ix <= n; ix++) {
      for (let iy = -n; iy <= n; iy++) {
        for (let iz = -n; iz <= n; iz++) {
          if (ix === 0 && iy === 0 && iz === 0) continue;
          positions[w++] = ix * spacing;
          positions[w++] = iy * spacing;
          positions[w++] = iz * spacing;
        }
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    return geo;
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
