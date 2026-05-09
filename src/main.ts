import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { open as openDialog } from "@tauri-apps/plugin-dialog";

import { parseStl } from "./loaders/stl";
import { parseStep } from "./loaders/step";

interface InitialArgs {
  file: string | null;
  watch: boolean;
}

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

camera.position.set(80, -80, 60);
camera.lookAt(0, 0, 0);

function fitCameraTo(obj: THREE.Object3D, padding = 1.4) {
  const box = new THREE.Box3().setFromObject(obj);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z, 1e-3);
  const fovRad = (camera.fov * Math.PI) / 180;
  const dist = (maxDim / 2 / Math.tan(fovRad / 2)) * padding;

  const dir = new THREE.Vector3(1, -1, 0.6).normalize();
  camera.position.copy(center).addScaledVector(dir, dist);
  controls.target.copy(center);
  camera.near = Math.max(maxDim * 0.001, 0.01);
  camera.far = Math.max(dist * 100, 1000);
  camera.updateProjectionMatrix();
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
  if (!isStep && !isStl) {
    setStatus(`unsupported format: .${e}`, { error: true });
    return;
  }

  try {
    setStatus(`loading ${basename(path)}…`);

    const raw = await invoke<number[] | Uint8Array | ArrayBuffer>("read_file_bytes", { path });
    const u8 =
      raw instanceof Uint8Array
        ? raw
        : raw instanceof ArrayBuffer
          ? new Uint8Array(raw)
          : new Uint8Array(raw);

    let object: THREE.Object3D;
    let triangleCount: number;
    let partInfo = "";

    if (isStl) {
      const mesh = parseStl(u8, defaultMaterial);
      object = new THREE.Group();
      object.add(mesh);
      triangleCount = (mesh.geometry as THREE.BufferGeometry).attributes.position.count / 3;
    } else {
      // STEP: yield to the event loop so the "loading…" status paints
      // before occt-import-js blocks the main thread.
      await new Promise((r) => requestAnimationFrame(() => r(null)));
      const parsed = await parseStep(u8, defaultMaterial);
      object = parsed.group;
      triangleCount = parsed.triangleCount;
      partInfo = `  ·  ${parsed.partCount} part${parsed.partCount === 1 ? "" : "s"}`;
    }

    disposeCurrent();
    scene.add(object);
    currentObject = object;
    currentPath = path;

    fitCameraTo(object);
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
      { name: "CAD models", extensions: ["stl", "STL", "step", "STEP", "stp", "STP"] },
      { name: "STL Mesh", extensions: ["stl", "STL"] },
      { name: "STEP", extensions: ["step", "STEP", "stp", "STP"] },
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
    camera.position.set(80, -80, 60);
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
    args = { file: null, watch: false };
  }

  watchEnabled = args.watch;

  await listen("menu:open", () => void pickAndLoad());
  await listen("menu:reset_view", () => resetView());
  await listen("menu:toggle_grid", () => {
    grid.visible = !grid.visible;
  });
  await listen("menu:toggle_axes", () => {
    axes.visible = !axes.visible;
  });
  await listen("menu:toggle_watch", () => void setWatchEnabled(!watchEnabled));

  await listen<string>("file-changed", (e) => {
    if (e.payload) scheduleReload(e.payload);
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
