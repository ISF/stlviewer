import * as THREE from "three";

export type SnapPlane = "XY" | "XZ" | "YZ";

const ACCENT = 0xffb020;
/** Pointer travel (px) between down and up beyond which we call it an
 *  orbit drag, not a pick. */
const CLICK_SLOP_PX = 5;

/**
 * Two-click distance measurement. Clicks raycast onto the loaded model;
 * the second point is snapped onto the axis-aligned plane through the
 * first point that best contains the segment (the axis with the smallest
 * delta is flattened), so the reported distance always lies in one of
 * the XY/XZ/YZ planes.
 */
export class MeasureTool {
  /** Markers + line live here; add to the scene once. */
  readonly overlay = new THREE.Group();

  active = false;

  private points: THREE.Vector3[] = [];
  private labelAnchor = new THREE.Vector3();
  private hasResult = false;

  private raycaster = new THREE.Raycaster();
  private downPos: { x: number; y: number } | null = null;

  // depthTest off + high renderOrder so the measurement is never hidden
  // inside the model it was picked on.
  private markerGeom = new THREE.SphereGeometry(1, 16, 12);
  private markerMat = new THREE.MeshBasicMaterial({ color: ACCENT, depthTest: false });
  private lineMat = new THREE.LineBasicMaterial({ color: ACCENT, depthTest: false });

  constructor(
    private camera: THREE.PerspectiveCamera,
    private dom: HTMLElement,
    private getTarget: () => THREE.Object3D | null,
    private labelEl: HTMLElement,
    private hintEl: HTMLElement,
  ) {
    dom.addEventListener("pointerdown", this.onPointerDown);
    dom.addEventListener("pointerup", this.onPointerUp);
  }

  setActive(on: boolean) {
    if (this.active === on) return;
    this.active = on;
    document.body.classList.toggle("measuring", on);
    if (!on) this.clearMeasurement();
    this.updateHint();
  }

  /** Drop markers/line/label but stay in measure mode. Called when a new
   *  file replaces the model the points were picked on. */
  clearMeasurement() {
    for (const child of [...this.overlay.children]) {
      this.overlay.remove(child);
      if (child instanceof THREE.Line) child.geometry.dispose();
    }
    this.points = [];
    this.hasResult = false;
    this.labelEl.style.display = "none";
    this.updateHint();
  }

  /** Reproject the floating distance label each frame. */
  updateLabel() {
    if (!this.hasResult) return;
    const v = this.labelAnchor.clone().project(this.camera);
    if (v.z > 1) {
      // Behind the camera.
      this.labelEl.style.display = "none";
      return;
    }
    this.labelEl.style.display = "block";
    this.labelEl.style.left = `${(v.x * 0.5 + 0.5) * window.innerWidth}px`;
    this.labelEl.style.top = `${(-v.y * 0.5 + 0.5) * window.innerHeight}px`;
  }

  private onPointerDown = (e: PointerEvent) => {
    if (!this.active || e.button !== 0) return;
    this.downPos = { x: e.clientX, y: e.clientY };
  };

  private onPointerUp = (e: PointerEvent) => {
    if (!this.active || e.button !== 0 || !this.downPos) return;
    const moved = Math.hypot(e.clientX - this.downPos.x, e.clientY - this.downPos.y);
    this.downPos = null;
    if (moved > CLICK_SLOP_PX) return; // orbit drag, not a pick
    this.pick(e);
  };

  private pick(e: PointerEvent) {
    const target = this.getTarget();
    if (!target) return;

    const rect = this.dom.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = this.raycaster.intersectObject(target, true)[0];
    if (!hit) return;

    if (this.points.length === 2) this.clearMeasurement();

    const point = hit.point.clone();
    this.points.push(point);
    this.addMarker(point, target);

    if (this.points.length === 2) this.completeMeasurement();
    this.updateHint();
  }

  private completeMeasurement() {
    const [a, b] = this.points;
    const { snapped, plane } = snapToPlane(a, b);
    b.copy(snapped);
    // Move the second marker onto the snapped position.
    const secondMarker = this.overlay.children[this.overlay.children.length - 1];
    secondMarker.position.copy(snapped);

    const geom = new THREE.BufferGeometry().setFromPoints([a, b]);
    const line = new THREE.Line(geom, this.lineMat);
    line.renderOrder = 999;
    this.overlay.add(line);

    const distance = a.distanceTo(b);
    this.labelAnchor.addVectors(a, b).multiplyScalar(0.5);
    this.labelEl.textContent = `${formatDistance(distance)} mm · ${plane}`;
    this.hasResult = true;
  }

  private addMarker(point: THREE.Vector3, target: THREE.Object3D) {
    const marker = new THREE.Mesh(this.markerGeom, this.markerMat);
    marker.position.copy(point);
    marker.scale.setScalar(this.markerRadius(target));
    marker.renderOrder = 1000;
    this.overlay.add(marker);
  }

  private markerRadius(target: THREE.Object3D): number {
    const size = new THREE.Box3().setFromObject(target).getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);
    return Math.max(maxDim * 0.006, 0.05);
  }

  private updateHint() {
    if (!this.active) {
      this.hintEl.style.display = "none";
      return;
    }
    this.hintEl.style.display = "block";
    this.hintEl.textContent =
      this.points.length === 0
        ? "Measure — click first point · Esc to exit"
        : this.points.length === 1
          ? "Measure — click second point"
          : "Measure — click to start a new measurement · Esc to exit";
  }
}

/** Flatten the axis with the smallest |delta| so the segment lies in the
 *  axis-aligned plane through `a` that best contains it. */
function snapToPlane(
  a: THREE.Vector3,
  b: THREE.Vector3,
): { snapped: THREE.Vector3; plane: SnapPlane } {
  const dx = Math.abs(b.x - a.x);
  const dy = Math.abs(b.y - a.y);
  const dz = Math.abs(b.z - a.z);
  const snapped = b.clone();
  let plane: SnapPlane;
  if (dz <= dx && dz <= dy) {
    snapped.z = a.z;
    plane = "XY";
  } else if (dy <= dx) {
    snapped.y = a.y;
    plane = "XZ";
  } else {
    snapped.x = a.x;
    plane = "YZ";
  }
  return { snapped, plane };
}

function formatDistance(d: number): string {
  return d >= 100 ? d.toFixed(1) : d.toFixed(2);
}
