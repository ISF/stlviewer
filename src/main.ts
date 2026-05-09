import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { open as openDialog } from "@tauri-apps/plugin-dialog";

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

const meshMaterial = new THREE.MeshStandardMaterial({
  color: 0xb6bdc6,
  metalness: 0.1,
  roughness: 0.55,
  side: THREE.DoubleSide,
  flatShading: false,
});

let currentMesh: THREE.Mesh | null = null;
let currentPath: string | null = null;
let watchEnabled = false;
let watchActive = false; // whether the Rust watcher is currently armed

// Default camera framing (used when no file loaded).
camera.position.set(80, -80, 60);
camera.lookAt(0, 0, 0);

function fitCameraToMesh(mesh: THREE.Mesh, padding = 1.4) {
  const box = new THREE.Box3().setFromObject(mesh);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z, 1e-3);
  const fovRad = (camera.fov * Math.PI) / 180;
  const dist = (maxDim / 2 / Math.tan(fovRad / 2)) * padding;

  // Three-quarter view: in front-right, slightly above.
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

function disposeMesh(mesh: THREE.Mesh) {
  scene.remove(mesh);
  (mesh.geometry as THREE.BufferGeometry).dispose();
}

async function loadFile(path: string) {
  const e = ext(path);
  if (e === "step" || e === "stp") {
    setStatus(`STEP support not yet implemented: ${basename(path)}`, { error: true });
    return;
  }
  if (e !== "stl") {
    setStatus(`unsupported format: .${e}`, { error: true });
    return;
  }

  try {
    const raw = await invoke<number[] | Uint8Array | ArrayBuffer>("read_file_bytes", { path });
    const u8 =
      raw instanceof Uint8Array
        ? raw
        : raw instanceof ArrayBuffer
          ? new Uint8Array(raw)
          : new Uint8Array(raw);
    const ab = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;

    const geom = new STLLoader().parse(ab);
    if (!geom.attributes.normal) geom.computeVertexNormals();

    const mesh = new THREE.Mesh(geom, meshMaterial);
    if (currentMesh) disposeMesh(currentMesh);
    scene.add(mesh);
    currentMesh = mesh;
    currentPath = path;

    fitCameraToMesh(mesh);

    hintEl.style.display = "none";
    const tris = geom.attributes.position.count / 3;
    setStatus(
      `${basename(path)}  ·  ${tris.toLocaleString()} tris`,
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

async function armWatcher(path: string) {
  try {
    await invoke("start_watch", { path });
    watchActive = true;
    if (currentPath) {
      const tris = currentMesh
        ? (currentMesh.geometry as THREE.BufferGeometry).attributes.position.count / 3
        : 0;
      setStatus(
        `${basename(currentPath)}  ·  ${tris.toLocaleString()} tris`,
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
  if (currentPath && currentMesh) {
    const tris = (currentMesh.geometry as THREE.BufferGeometry).attributes.position.count / 3;
    setStatus(`${basename(currentPath)}  ·  ${tris.toLocaleString()} tris`);
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
    filters: [{ name: "STL Mesh", extensions: ["stl", "STL"] }],
  });
  if (typeof picked === "string") {
    await loadFile(picked);
  }
}

// File watcher events come in bursts (atomic save = remove + create).
// Coalesce within 120ms.
let reloadTimer: number | undefined;
function scheduleReload(path: string) {
  if (reloadTimer !== undefined) window.clearTimeout(reloadTimer);
  reloadTimer = window.setTimeout(() => {
    reloadTimer = undefined;
    loadFile(path);
  }, 120);
}

function resetView() {
  if (currentMesh) {
    fitCameraToMesh(currentMesh);
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

  // Menu events from the macOS menu bar
  await listen("menu:open", () => void pickAndLoad());
  await listen("menu:reset_view", () => resetView());
  await listen("menu:toggle_grid", () => {
    grid.visible = !grid.visible;
  });
  await listen("menu:toggle_axes", () => {
    axes.visible = !axes.visible;
  });
  await listen("menu:toggle_watch", () => void setWatchEnabled(!watchEnabled));

  // File watcher reload
  await listen<string>("file-changed", (e) => {
    if (e.payload) scheduleReload(e.payload);
  });

  // OS-native drag and drop
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
