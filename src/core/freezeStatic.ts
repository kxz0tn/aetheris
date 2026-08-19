import type { Object3D } from "three";

/**
 * World geometry never translates after build. Freeze matrices so the
 * frame loop does not recompute them. Call again after any rebuild.
 */
export function freezeStatic(root: Object3D): void {
  root.updateMatrixWorld(true);
  root.traverse((o) => {
    o.matrixAutoUpdate = false;
  });
}
