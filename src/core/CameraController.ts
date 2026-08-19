import * as THREE from "three";

/**
 * 6DOF fly / orbit hybrid. No collision. No tools.
 *
 * Fly (pointer-lock):
 *   WASD  — local XZ (camera right / camera -Z)
 *   Space — local +Y
 *   Ctrl  — local -Y
 *   Mouse — yaw / pitch (YXZ, pitch clamped to avoid pole flip)
 *   Shift — speed multiplier
 *
 * Orbit (RMB held):
 *   Spherical track around orbitTarget (mid-thorax of the twin).
 *   Releasing RMB reseeds fly euler from the current quaternion
 *   so the view does not snap.
 *
 * Velocity reported to the HUD is world displacement / dt (actual motion),
 * not the internal wish vector. Orbit and fly therefore share one readout.
 */
export class CameraController {
  private readonly camera: THREE.PerspectiveCamera;
  private readonly canvas: HTMLCanvasElement;

  private readonly keys = new Set<string>();
  private pointerLocked = false;
  private orbiting = false;

  private yaw = 0;
  private pitch = 0;

  private readonly lookSens = 0.0022;
  private readonly orbitSens = 0.005;
  private readonly flySpeed = 10;
  private readonly boostMul = 3.25;
  private readonly damp = 7; // 1/s, kinematic lerp toward wish velocity
  /** Multiplier from ScaleManager. Descent slows translation so the field feels larger. */
  private speedScale = 1;

  private readonly wish = new THREE.Vector3();
  private readonly velocity = new THREE.Vector3();
  private readonly localX = new THREE.Vector3();
  private readonly localY = new THREE.Vector3();
  private readonly localZ = new THREE.Vector3();
  private readonly euler = new THREE.Euler();
  private readonly prevPos = new THREE.Vector3();

  private readonly orbitTarget = new THREE.Vector3(0, 8.1, 0);
  private readonly spherical = new THREE.Spherical();
  private readonly offset = new THREE.Vector3();
  private lastMouseX = 0;
  private lastMouseY = 0;

  private speedSmoothed = 0;

  constructor(camera: THREE.PerspectiveCamera, canvas: HTMLCanvasElement) {
    this.camera = camera;
    this.canvas = canvas;

    this.seedEulerFromCamera();
    this.prevPos.copy(camera.position);

    canvas.addEventListener("click", this.onClick);
    canvas.addEventListener("pointerdown", this.onPointerDown);
    canvas.addEventListener("contextmenu", this.onContextMenu);
    window.addEventListener("pointermove", this.onPointerMove);
    window.addEventListener("pointerup", this.onPointerUp);
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    document.addEventListener("pointerlockchange", this.onLockChange);
  }

  update(delta: number): void {
    if (delta <= 0) return;

    if (!this.orbiting) {
      this.applyFly(delta);
    }

    // HUD velocity = actual world motion, lightly damped to kill 1-frame spikes.
    const inst = this.prevPos.distanceTo(this.camera.position) / delta;
    this.prevPos.copy(this.camera.position);
    const k = 1 - Math.exp(-18 * delta);
    this.speedSmoothed += (inst - this.speedSmoothed) * k;
  }

  getVelocityMagnitude(): number {
    return this.speedSmoothed;
  }

  setOrbitTarget(x: number, y: number, z: number): void {
    this.orbitTarget.set(x, y, z);
  }

  /**
   * Scale continuum hook. Speed scales with currentScale, floored so
   * cellular approach is still navigable. Not a zoom — translation only.
   */
  setSpeedScale(scale: number): void {
    this.speedScale = THREE.MathUtils.clamp(scale, 0.004, 1.6);
  }

  dispose(): void {
    this.canvas.removeEventListener("click", this.onClick);
    this.canvas.removeEventListener("pointerdown", this.onPointerDown);
    this.canvas.removeEventListener("contextmenu", this.onContextMenu);
    window.removeEventListener("pointermove", this.onPointerMove);
    window.removeEventListener("pointerup", this.onPointerUp);
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    document.removeEventListener("pointerlockchange", this.onLockChange);
    if (document.pointerLockElement === this.canvas) {
      document.exitPointerLock();
    }
  }

  private applyFly(delta: number): void {
    this.wish.set(0, 0, 0);
    if (this.keys.has("KeyW")) this.wish.z -= 1;
    if (this.keys.has("KeyS")) this.wish.z += 1;
    if (this.keys.has("KeyA")) this.wish.x -= 1;
    if (this.keys.has("KeyD")) this.wish.x += 1;
    if (this.keys.has("Space")) this.wish.y += 1;
    if (this.keys.has("ControlLeft") || this.keys.has("ControlRight")) this.wish.y -= 1;

    if (this.wish.lengthSq() > 0) this.wish.normalize();

    const boost =
      this.keys.has("ShiftLeft") || this.keys.has("ShiftRight")
        ? this.boostMul
        : 1;
    const speed = this.flySpeed * boost * this.speedScale;

    // Camera local axes. Three.js cameras look down -Z.
    this.camera.updateMatrixWorld();
    this.localX.setFromMatrixColumn(this.camera.matrixWorld, 0);
    this.localY.setFromMatrixColumn(this.camera.matrixWorld, 1);
    this.localZ.setFromMatrixColumn(this.camera.matrixWorld, 2);

    const tx =
      this.localX.x * this.wish.x +
      this.localY.x * this.wish.y +
      this.localZ.x * this.wish.z;
    const ty =
      this.localX.y * this.wish.x +
      this.localY.y * this.wish.y +
      this.localZ.y * this.wish.z;
    const tz =
      this.localX.z * this.wish.x +
      this.localY.z * this.wish.y +
      this.localZ.z * this.wish.z;

    this.wish.set(tx, ty, tz).multiplyScalar(speed);

    const a = 1 - Math.exp(-this.damp * delta);
    this.velocity.lerp(this.wish, a);
    this.camera.position.addScaledVector(this.velocity, delta);
  }

  private seedEulerFromCamera(): void {
    this.euler.setFromQuaternion(this.camera.quaternion, "YXZ");
    this.pitch = this.euler.x;
    this.yaw = this.euler.y;
  }

  private applyLookEuler(): void {
    const limit = Math.PI * 0.5 - 0.01;
    this.pitch = THREE.MathUtils.clamp(this.pitch, -limit, limit);
    this.euler.set(this.pitch, this.yaw, 0, "YXZ");
    this.camera.quaternion.setFromEuler(this.euler);
  }

  private beginOrbit(x: number, y: number): void {
    this.orbiting = true;
    this.lastMouseX = x;
    this.lastMouseY = y;
    this.offset.copy(this.camera.position).sub(this.orbitTarget);
    this.spherical.setFromVector3(this.offset);
    this.velocity.set(0, 0, 0);
  }

  private stepOrbit(x: number, y: number): void {
    const dx = x - this.lastMouseX;
    const dy = y - this.lastMouseY;
    this.lastMouseX = x;
    this.lastMouseY = y;

    this.spherical.theta -= dx * this.orbitSens;
    this.spherical.phi -= dy * this.orbitSens;
    this.spherical.phi = THREE.MathUtils.clamp(
      this.spherical.phi,
      0.04,
      Math.PI - 0.04,
    );
    this.spherical.radius = Math.max(this.spherical.radius, 0.5);

    this.offset.setFromSpherical(this.spherical);
    this.camera.position.copy(this.orbitTarget).add(this.offset);
    this.camera.lookAt(this.orbitTarget);
    this.seedEulerFromCamera();
  }

  private endOrbit(): void {
    if (!this.orbiting) return;
    this.orbiting = false;
    this.seedEulerFromCamera();
  }

  private readonly onClick = (): void => {
    if (!this.orbiting && document.pointerLockElement !== this.canvas) {
      void this.canvas.requestPointerLock();
    }
  };

  private readonly onPointerDown = (e: PointerEvent): void => {
    if (e.button === 2) {
      e.preventDefault();
      this.beginOrbit(e.clientX, e.clientY);
    }
  };

  private readonly onPointerMove = (e: PointerEvent): void => {
    if (this.orbiting) {
      this.stepOrbit(e.clientX, e.clientY);
      return;
    }
    if (!this.pointerLocked) return;
    this.yaw -= e.movementX * this.lookSens;
    this.pitch -= e.movementY * this.lookSens;
    this.applyLookEuler();
  };

  private readonly onPointerUp = (e: PointerEvent): void => {
    if (e.button === 2) this.endOrbit();
  };

  private readonly onContextMenu = (e: Event): void => {
    e.preventDefault();
  };

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    this.keys.add(e.code);
    // Keep the browser from scrolling / activating chrome while we fly.
    if (
      e.code === "Space" ||
      e.code === "ControlLeft" ||
      e.code === "ControlRight" ||
      e.code.startsWith("Arrow")
    ) {
      e.preventDefault();
    }
  };

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    this.keys.delete(e.code);
  };

  private readonly onLockChange = (): void => {
    this.pointerLocked = document.pointerLockElement === this.canvas;
  };
}
