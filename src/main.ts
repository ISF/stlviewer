import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

const canvas = document.getElementById("app") as HTMLCanvasElement;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x202020);

const camera = new THREE.PerspectiveCamera(
  50,
  window.innerWidth / window.innerHeight,
  0.01,
  10_000,
);
// Z-up: CAD convention. Three.js defaults to Y-up, so we override before
// constructing OrbitControls so the controls' "up" matches.
camera.up.set(0, 0, 1);
camera.position.set(80, -80, 60);
camera.lookAt(0, 0, 0);

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight, false);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

// Ground grid in the XY plane (Z-up convention).
const grid = new THREE.GridHelper(200, 20, 0x444444, 0x303030);
grid.rotation.x = Math.PI / 2;
scene.add(grid);

scene.add(new THREE.AxesHelper(40));
scene.add(new THREE.AmbientLight(0xffffff, 0.4));

const sun = new THREE.DirectionalLight(0xffffff, 0.9);
sun.position.set(50, 50, 100);
scene.add(sun);

// Placeholder cube — proves the scene renders. Replaced by loaded geometry
// once we wire up STL/STEP loading.
const placeholder = new THREE.Mesh(
  new THREE.BoxGeometry(20, 20, 20),
  new THREE.MeshStandardMaterial({ color: 0x6699cc }),
);
placeholder.position.z = 10;
scene.add(placeholder);

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight, false);
});

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}
animate();
