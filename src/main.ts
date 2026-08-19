import "./style.css";
import { RenderPipeline } from "./core/RenderPipeline";
import { CameraController } from "./core/CameraController";
import {
  ScaleManager,
  cellularPresence,
  molecularPresence,
  nanoPresence,
  tissuePresence,
} from "./core/ScaleManager";
import { ReferenceLattice } from "./core/ReferenceLattice";
import { MacroTwin } from "./core/MacroTwin";
import { TissueLayer } from "./core/TissueLayer";
import { CellularLayer } from "./core/CellularLayer";
import { MolecularLayer } from "./core/MolecularLayer";
import { NanoFieldLayer } from "./core/NanoFieldLayer";
import { CascadeSystem } from "./core/CascadeSystem";
import { EventLog } from "./core/EventLog";
import { InstrumentRig } from "./core/Tools";
import { TerminalHUD, densityFor, sysState } from "./ui/TerminalHUD";

/**
 * Phase 8 boot — operative console.
 *
 *   T           cycle tools  NONE → SCANNER → PROBE → ASSEMBLER
 *   Q           scanner channel / assembler action
 *   E / LMB*    probe sample / assembler execute  (*pointer-lock)
 *   F           tissue field overlay mask
 *   wheel [ ]   scale
 *   1–5 0       decade stations
 */

const root = document.getElementById("app");
if (!root) {
  throw new Error("AETHERIS: #app missing");
}

const pipeline = new RenderPipeline(root);
const scale = new ScaleManager();
const lattice = new ReferenceLattice(pipeline.scene);
const twin = new MacroTwin(pipeline.scene);
const tissue = new TissueLayer(pipeline.scene, twin.getLandmarks());
const cellular = new CellularLayer(pipeline.scene, tissue.getCellAnchors());
const molecular = new MolecularLayer(pipeline.scene, cellular.getSites());
const nano = new NanoFieldLayer(pipeline.scene, molecular.getSites());
const log = new EventLog();
const cascade = new CascadeSystem(tissue, cellular, log);
cellular.bindCascade(cascade);
molecular.bindCascade(cascade);
nano.bindCascade(cascade);
const camera = new CameraController(pipeline.camera, pipeline.canvas);
const instruments = new InstrumentRig(
  pipeline.scene,
  pipeline.camera,
  twin,
  tissue,
  cellular,
  molecular,
  nano,
  scale,
  cascade,
  log,
);
const hud = new TerminalHUD();

camera.setOrbitTarget(0, 8.1, 0);

scale.onScaleChanged((sample) => {
  lattice.syncScale(sample.current);
  twin.syncScale(sample.current);
  tissue.syncScale(sample.current);
  cellular.syncScale(sample.current);
  molecular.syncScale(sample.current);
  nano.syncScale(sample.current);
  camera.setSpeedScale(sample.current);
});

const DECADES: Readonly<Record<string, number>> = {
  Digit1: 1,
  Digit2: 0.1,
  Digit3: 0.01,
  Digit4: 0.001,
  Digit5: 0.0001,
  Digit0: 1,
};

const onKeyDown = (e: KeyboardEvent): void => {
  if (e.code === "KeyT") {
    instruments.cycleTool();
    e.preventDefault();
    return;
  }
  if (e.code === "KeyQ") {
    instruments.cycleChannel();
    e.preventDefault();
    return;
  }
  if (e.code === "KeyE") {
    instruments.fire();
    e.preventDefault();
    return;
  }
  if (e.code === "KeyF") {
    tissue.cycleFields();
    e.preventDefault();
    return;
  }
  if (e.code in DECADES) {
    scale.setTargetScale(DECADES[e.code]);
    e.preventDefault();
    return;
  }
  if (e.code === "Minus" || e.code === "BracketLeft" || e.code === "PageDown") {
    scale.nudgeLog(-0.12);
    e.preventDefault();
    return;
  }
  if (
    e.code === "Equal" ||
    e.code === "BracketRight" ||
    e.code === "PageUp"
  ) {
    scale.nudgeLog(+0.12);
    e.preventDefault();
  }
};

const onWheel = (e: WheelEvent): void => {
  e.preventDefault();
  const step = Math.sign(e.deltaY) * Math.min(Math.abs(e.deltaY) / 400, 0.18);
  scale.nudgeLog(-step);
};

const onPointerDown = (e: PointerEvent): void => {
  if (
    e.button === 0 &&
    document.pointerLockElement === pipeline.canvas &&
    (instruments.activeTool === "probe" || instruments.activeTool === "assembler")
  ) {
    instruments.fire();
  }
};

window.addEventListener("keydown", onKeyDown);
pipeline.canvas.addEventListener("wheel", onWheel, { passive: false });
pipeline.canvas.addEventListener("pointerdown", onPointerDown);

let last = performance.now();
let hudAcc = 0;

const frame = (now: number): void => {
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;

  scale.update(dt);
  camera.update(dt);
  cascade.update(dt);
  cellular.update(dt);
  molecular.update(dt);
  nano.update(dt);
  instruments.update(dt);

  hudAcc += dt;
  if (hudAcc >= 0.08) {
    hudAcc = 0;
    const p = pipeline.camera.position;
    const sample = scale.getSample();
    const np = nanoPresence(sample.current);
    const mp = molecularPresence(sample.current);
    const cp = cellularPresence(sample.current);
    const tp = tissuePresence(sample.current);
    const layer =
      np > 0.15
        ? nano.statusLine()
        : mp > 0.15
          ? molecular.statusLine()
          : cp > 0.15
            ? cellular.statusLine()
            : tp > 0.05
              ? tissue.fieldLabel()
              : "STANDBY";

    const density = densityFor(sample.current, instruments.activeTool);
    const kernels = cascade.liveKernels();
    const thermal = instruments.thermalLoad;
    const needSys = density !== "low" || kernels.length > 0 || thermal > 0.12;
    const stress = needSys ? cascade.membraneStressAt(p) : 0;
    const load = needSys ? cascade.loadAt(p) : 0;

    hud.update({
      scale: sample.current,
      band: sample.label,
      x: p.x,
      y: p.y,
      z: p.z,
      vel: camera.getVelocityMagnitude(),
      layer,
      sys: {
        state: sysState(stress, thermal, kernels.length > 0),
        load,
        stress,
        thermal,
        kernels,
      },
      ins: instruments.snapshot(),
      log: log.entries(),
      density,
    });
  }

  pipeline.render();
  requestAnimationFrame(frame);
};

requestAnimationFrame(frame);
