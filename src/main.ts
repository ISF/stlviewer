import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { open as openDialog } from "@tauri-apps/plugin-dialog";

import { parseStl } from "./loaders/stl";
import { parseStep } from "./loaders/step";
import { parseThreeMf } from "./loaders/3mf";
import { dbg, setDebugEnabled } from "./debug";

type UpAxis = "z" | "y";

interface InitialArgs {
  file: string | null;
  watch: boolean;
  up_axis: UpAxis;
  background_color: [number, number, number];
  grid_visible: boolean;
  axes_visible: boolean;
  debug: boolean;
}

const FALLBACK_ARGS: InitialArgs = {
  file: null,
  watch: false,
  up_axis: "z",
  background_color: [0x18 / 255, 0x1c / 255, 0x22 / 255],
  grid_visible: true,
  axes_visible: true,
  debug: false,
};

const canvas = document.getElementById("app") as HTMLCanvasElement;
const hintEl = document.getElementById("hint") as HTMLDivElement;
const statusEl = document.getElementById("status") as HTMLDivElement;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x181c22);

const camera = new THREE.PerspectiveCamera(50, 1, 0.01, 10_000);
camera.up.set(0, 0, 1); // Z-up: CAD convention.

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

const grid = new THREE.GridHelper(200, 20, 0x444444, 0x303030);
grid.rotation.x = Math.PI / 2;
scene.add(grid);

const axes = new THREE.AxesHelper(40);
scene.add(axes);

scene.add(new THREE.AmbientLight(0xffffff, 0.45));
const sun = new THREE.DirectionalLight(0xffffff, 0.85);
sun.position.set(80, 60, 120);
scene.add(sun);
const fill = new THREE.DirectionalLight(0xb0c4de, 0.25);
fill.position.set(-60, -80, 40);
scene.add(fill);

// Shared default material — used for STL meshes and for STEP parts that
// don't carry their own color. STEP parts WITH a color get their own
// material in step.ts; those are disposed when the group is replaced.
const defaultMaterial = new THREE.MeshStandardMaterial({
  color: 0xb6bdc6,
  metalness: 0.1,
  roughness: 0.55,
  side: THREE.DoubleSide,
  flatShading: false,
});

let currentObject: THREE.Object3D | null = null;
let currentPath: string | null = null;
let watchEnabled = false;
let watchActive = false;
let currentUpAxis: UpAxis = "z";

function cameraDirection(): THREE.Vector3 {
  // Three-quarter view biased toward the configured up axis. For Z-up
  // (CAD) we look from +X, −Y, slightly above; for Y-up (graphics
  // convention) we look from +X, slightly above, slightly toward +Z.
  return currentUpAxis === "z"
    ? new THREE.Vector3(1, -1, 0.6).normalize()
    : new THREE.Vector3(1, 0.6, 1).normalize();
}

function defaultCameraPosition(): THREE.Vector3 {
  return currentUpAxis === "z"
    ? new THREE.Vector3(80, -80, 60)
    : new THREE.Vector3(80, 60, 80);
}

camera.position.copy(defaultCameraPosition());
camera.lookAt(0, 0, 0);

function fitCameraTo(obj: THREE.Object3D, padding = 1.4) {
  const box = new THREE.Box3().setFromObject(obj);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z, 1e-3);
  const fovRad = (camera.fov * Math.PI) / 180;
  const dist = (maxDim / 2 / Math.tan(fovRad / 2)) * padding;

  const dir = cameraDirection();
  camera.position.copy(center).addScaledVector(dir, dist);
  controls.target.copy(center);
  camera.near = Math.max(maxDim * 0.001, 0.01);
  camera.far = Math.max(dist * 100, 1000);
  camera.updateProjectionMatrix();
  controls.update();
}

function applyInitialSettings(args: InitialArgs) {
  // Background.
  scene.background = new THREE.Color(
    args.background_color[0],
    args.background_color[1],
    args.background_color[2],
  );

  // Up axis affects camera, the grid's plane, and which default position
  // makes for a clean "three-quarter view." OrbitControls reads camera.up
  // each tick, so we don't need to re-construct it.
  currentUpAxis = args.up_axis;
  if (args.up_axis === "z") {
    camera.up.set(0, 0, 1);
    grid.rotation.x = Math.PI / 2;      // XZ-plane mesh → XY-plane (ground)
  } else {
    camera.up.set(0, 1, 0);
    grid.rotation.x = 0;                // default GridHelper sits in XZ
  }
  camera.position.copy(defaultCameraPosition());
  camera.lookAt(0, 0, 0);

  grid.visible = args.grid_visible;
  axes.visible = args.axes_visible;
  controls.update();
}

function setStatus(msg: string, opts: { error?: boolean; watching?: boolean } = {}) {
  statusEl.textContent = msg;
  statusEl.classList.toggle("error", !!opts.error);
  statusEl.classList.toggle("watching", !!opts.watching);
}

function basename(path: string) {
  return path.split(/[\\/]/).pop() ?? path;
}

function ext(path: string) {
  return path.toLowerCase().split(".").pop() ?? "";
}

function disposeCurrent() {
  if (!currentObject) return;
  scene.remove(currentObject);
  currentObject.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      child.geometry.dispose();
      const mats = Array.isArray(child.material) ? child.material : [child.material];
      for (const m of mats) {
        if (m !== defaultMaterial) m.dispose();
      }
    }
  });
  currentObject = null;
}

async function loadFile(path: string) {
  const e = ext(path);
  const isStep = e === "step" || e === "stp";
  const isStl = e === "stl";
  const is3mf = e === "3mf";
  if (!isStep && !isStl && !is3mf) {
    setStatus(`unsupported format: .${e}`, { error: true });
    return;
  }

  try {
    dbg("loadFile", "start", { path, ext: e });
    setStatus(`loading ${basename(path)}…`);

    const raw = await invoke<number[] | Uint8Array | ArrayBuffer>("read_file_bytes", { path });
    const u8 =
      raw instanceof Uint8Array
        ? raw
        : raw instanceof ArrayBuffer
          ? new Uint8Array(raw)
          : new Uint8Array(raw);
    dbg("loadFile", "bytes read", { bytes: u8.byteLength });

    let object: THREE.Object3D;
    let triangleCount: number;
    let partInfo = "";

    if (isStl) {
      const mesh = parseStl(u8, defaultMaterial);
      object = new THREE.Group();
      object.add(mesh);
      triangleCount = (mesh.geometry as THREE.BufferGeometry).attributes.position.count / 3;
    } else if (is3mf) {
      // 3MF: yield once so the loading status paints before we unzip and
      // chew through what can be megabytes of XML on the main thread.
      await new Promise((r) => requestAnimationFrame(() => r(null)));
      dbg("loadFile", "calling parseThreeMf");
      const parsed = await parseThreeMf(u8, defaultMaterial);
      dbg("loadFile", "parseThreeMf resolved", {
        partCount: parsed.partCount,
        triangleCount: parsed.triangleCount,
      });
      object = parsed.group;
      triangleCount = parsed.triangleCount;
      if (parsed.partCount > 1) {
        partInfo = `  ·  ${parsed.partCount} parts`;
      }
    } else {
      // STEP: yield to the event loop so the "loading…" status paints
      // before occt-import-js blocks the main thread.
      await new Promise((r) => requestAnimationFrame(() => r(null)));
      dbg("loadFile", "calling parseStep");
      const parsed = await parseStep(u8, defaultMaterial);
      dbg("loadFile", "parseStep resolved", {
        partCount: parsed.partCount,
        triangleCount: parsed.triangleCount,
      });
      object = parsed.group;
      triangleCount = parsed.triangleCount;
      partInfo = `  ·  ${parsed.partCount} part${parsed.partCount === 1 ? "" : "s"}`;
    }

    disposeCurrent();
    scene.add(object);
    currentObject = object;
    currentPath = path;

    fitCameraTo(object);
    dbg("loadFile", "added to scene + camera fit");
    hintEl.style.display = "none";

    setStatus(
      `${basename(path)}  ·  ${triangleCount.toLocaleString()} tris${partInfo}`,
      { watching: watchActive },
    );

    if (watchEnabled) {
      await armWatcher(path);
    }
  } catch (err) {
    setStatus(`error: ${err}`, { error: true });
    console.error(err);
  }
}

function currentTriCount(): number {
  if (!currentObject) return 0;
  let count = 0;
  currentObject.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      count += (child.geometry as THREE.BufferGeometry).attributes.position.count / 3;
    }
  });
  return count;
}

async function armWatcher(path: string) {
  try {
    await invoke("start_watch", { path });
    watchActive = true;
    if (currentPath) {
      setStatus(
        `${basename(currentPath)}  ·  ${currentTriCount().toLocaleString()} tris`,
        { watching: true },
      );
    }
  } catch (err) {
    console.error(err);
    setStatus(`watch error: ${err}`, { error: true });
  }
}

async function disarmWatcher() {
  await invoke("stop_watch");
  watchActive = false;
  if (currentPath) {
    setStatus(`${basename(currentPath)}  ·  ${currentTriCount().toLocaleString()} tris`);
  }
}

async function setWatchEnabled(enabled: boolean) {
  watchEnabled = enabled;
  if (enabled && currentPath) {
    await armWatcher(currentPath);
  } else if (!enabled && watchActive) {
    await disarmWatcher();
  }
}

async function pickAndLoad() {
  const picked = await openDialog({
    multiple: false,
    directory: false,
    filters: [
      {
        name: "CAD models",
        extensions: ["stl", "STL", "step", "STEP", "stp", "STP", "3mf", "3MF"],
      },
      { name: "STL Mesh", extensions: ["stl", "STL"] },
      { name: "STEP", extensions: ["step", "STEP", "stp", "STP"] },
      { name: "3MF", extensions: ["3mf", "3MF"] },
    ],
  });
  if (typeof picked === "string") {
    await loadFile(picked);
  }
}

let reloadTimer: number | undefined;
function scheduleReload(path: string) {
  if (reloadTimer !== undefined) window.clearTimeout(reloadTimer);
  reloadTimer = window.setTimeout(() => {
    reloadTimer = undefined;
    loadFile(path);
  }, 120);
}

function resetView() {
  if (currentObject) {
    fitCameraTo(currentObject);
  } else {
    camera.position.copy(defaultCameraPosition());
    controls.target.set(0, 0, 0);
    camera.updateProjectionMatrix();
    controls.update();
  }
}

function onResize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h, false);
}
window.addEventListener("resize", onResize);
onResize();

async function bootstrap() {
  let args: InitialArgs;
  try {
    args = await invoke<InitialArgs>("get_initial_args");
  } catch (err) {
    console.error("get_initial_args failed:", err);
    args = FALLBACK_ARGS;
  }

  setDebugEnabled(args.debug);
  dbg("bootstrap", "got initial args", args);

  applyInitialSettings(args);
  watchEnabled = args.watch;

  await listen("menu:open", () => void pickAndLoad());
  await listen("menu:reset_view", () => resetView());
  // For toggleable menu items the backend has already flipped the
  // CheckMenuItem state, persisted to Settings, and emits the new boolean
  // as the payload. Frontend just mirrors the value.
  await listen<boolean>("menu:toggle_grid", (e) => {
    grid.visible = e.payload;
  });
  await listen<boolean>("menu:toggle_axes", (e) => {
    axes.visible = e.payload;
  });
  await listen<boolean>("menu:toggle_watch", (e) => void setWatchEnabled(e.payload));

  await listen<string>("file-changed", (e) => {
    if (e.payload) scheduleReload(e.payload);
  });

  // Files macOS hands us via Launch Services (double-click, `open file.stl`,
  // recent items) — Rust forwards them as a `file-open` event with the
  // canonical path as payload. Behaves identically to drag-drop from here on.
  await listen<string>("file-open", (e) => {
    if (e.payload) void loadFile(e.payload);
  });

  const win = getCurrentWebviewWindow();
  await win.onDragDropEvent((e) => {
    if (e.payload.type === "drop" && e.payload.paths.length > 0) {
      void loadFile(e.payload.paths[0]);
    }
  });

  if (args.file) {
    await loadFile(args.file);
  }
}

void bootstrap();

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}
animate();
