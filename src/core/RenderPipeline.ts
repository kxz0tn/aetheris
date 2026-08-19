import * as THREE from "three";

/**
 * Permanent render surface for Aetheris.
 *
 * Contract (Phase 0, locked):
 *   - Clear color is pure black. Fog is pure black. No other pipeline color exists.
 *   - Admitted materials this phase: LineBasicMaterial, PointsMaterial.
 *   - Antialias on. Pixel ratio capped — fragment cost above 2× is wasted on HUD-scale lines.
 *
 * Extension points (do not invent them here):
 *   - camera.near / camera.far will be driven by ScaleManager once descent exists.
 *   - Additional material classes only after a later phase explicitly admits them.
 */
export class RenderPipeline {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;

  private readonly container: HTMLElement;

  constructor(container: HTMLElement) {
    this.container = container;

    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: false,
      powerPreference: "high-performance",
    });
    this.renderer.setClearColor(0x000000, 1);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(container.clientWidth, container.clientHeight, false);
    this.renderer.autoClear = true;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x000000);

    // Linear distance fog: room lattice falls into the void without a color shift.
    // Near/far are Macro Theater defaults. Later phases retune with descent.
    this.scene.fog = new THREE.Fog(0x000000, 22, 100);

    this.camera = new THREE.PerspectiveCamera(
      60,
      this.aspect(),
      0.08,
      500,
    );

    // Macro Theater boot: three-quarter on the twin, mid-thorax height.
    this.camera.position.set(5.4, 9.6, 16.8);
    this.camera.lookAt(0, 8.1, 0);

    window.addEventListener("resize", this.onResize);
  }

  render(): void {
    this.renderer.render(this.scene, this.camera);
  }

  get canvas(): HTMLCanvasElement {
    return this.renderer.domElement;
  }

  dispose(): void {
    window.removeEventListener("resize", this.onResize);
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  private aspect(): number {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    return w / h;
  }

  private readonly onResize = (): void => {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(w, h, false);
  };
}
