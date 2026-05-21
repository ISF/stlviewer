import * as THREE from "three";
import { unzip } from "three/examples/jsm/libs/fflate.module.js";

export interface ParsedThreeMf {
  group: THREE.Group;
  triangleCount: number;
  partCount: number;
}

// ---------------------------------------------------------------------------
// Why this exists
//
// Three.js's bundled `ThreeMFLoader` builds an object map per `.model` file
// and never resolves the 3MF Production Extension's cross-file references
// (`p:path` on a `<component>` / `<item>` element). Slicer-generated files —
// BambuStudio, OrcaSlicer, PrusaSlicer — all use that extension to put the
// actual mesh in `3D/Objects/object_N.model` while the build manifest lives
// in `3D/3dmodel.model`. Result: the loader fails with
// `TypeError: undefined is not an object (evaluating 'X.mesh')`.
//
// Geometry is all we care about, so we parse the archive ourselves. fflate
// (bundled with three.js) handles the zip; DOMParser handles the XML.
// ---------------------------------------------------------------------------

interface MeshData {
  positions: Float32Array;
  indices: Uint32Array;
}

interface ComponentRef {
  objectId: string;
  /** Absolute archive path to the .model file the referenced object lives in.
   * `undefined` ⇒ same file as the containing object. */
  path?: string;
  transform?: THREE.Matrix4;
}

interface ObjectDef {
  id: string;
  name?: string;
  mesh?: MeshData;
  components?: ComponentRef[];
}

interface BuildItem {
  objectId: string;
  path?: string;
  transform?: THREE.Matrix4;
}

interface ParsedModelFile {
  objects: Map<string, ObjectDef>;
  buildItems: BuildItem[];
}

export async function parseThreeMf(
  bytes: Uint8Array,
  defaultMaterial: THREE.Material,
): Promise<ParsedThreeMf> {
  const files = await unzipAsync(bytes);

  // _rels/.rels names the canonical entry point. Fall back to the
  // conventional `3D/3dmodel.model` if relationships aren't present.
  const rootTarget = findRootModelTarget(files) ?? "/3D/3dmodel.model";
  const models = new Map<string, ParsedModelFile>();
  await loadModel(rootTarget, files, models);

  const rootPath = canonical(rootTarget);
  const root = models.get(rootPath);
  if (!root) {
    throw new Error(`3MF root model ${rootTarget} did not parse`);
  }

  const group = new THREE.Group();
  let triangleCount = 0;
  let partCount = 0;

  for (const item of root.buildItems) {
    const child = buildObject(
      item.objectId,
      item.path ? canonical(item.path) : rootPath,
      models,
      defaultMaterial,
    );
    if (item.transform) child.applyMatrix4(item.transform);
    group.add(child);
    child.traverse((c) => {
      if (c instanceof THREE.Mesh) {
        partCount += 1;
        const geom = c.geometry as THREE.BufferGeometry;
        triangleCount += geom.index
          ? geom.index.count / 3
          : geom.attributes.position.count / 3;
      }
    });
  }

  // If the file has no <build> manifest, fall back to rendering every mesh
  // object we found. Some authoring tools omit the build for view-only
  // archives.
  if (partCount === 0) {
    for (const model of models.values()) {
      for (const obj of model.objects.values()) {
        if (obj.mesh) {
          const mesh = makeMesh(obj.mesh, defaultMaterial, obj.name);
          group.add(mesh);
          partCount += 1;
          const geom = mesh.geometry as THREE.BufferGeometry;
          triangleCount += geom.index
            ? geom.index.count / 3
            : geom.attributes.position.count / 3;
        }
      }
    }
  }

  // Settle the assembly onto the grid. Slicer-generated 3MFs bake a
  // translation into the build-item transform that places the model at its
  // position on the print bed (e.g. `(128, 128, 14)`). For viewing we want
  // the part sitting on the grid plane (z = 0 in our Z-up scene), centered
  // in XY around the origin where the axes helper lives. Rotation and
  // scale from the build transform are preserved.
  group.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(group);
  if (!box.isEmpty()) {
    const center = new THREE.Vector3();
    box.getCenter(center);
    group.position.x -= center.x;
    group.position.y -= center.y;
    group.position.z -= box.min.z;
  }

  return { group, triangleCount, partCount };
}

// ---------------------------------------------------------------------------
// File-level resolution

function findRootModelTarget(files: Record<string, Uint8Array>): string | null {
  const relsBytes = files["_rels/.rels"];
  if (!relsBytes) return null;
  const doc = parseXml(decode(relsBytes));
  const rels = doc.getElementsByTagName("Relationship");
  for (let i = 0; i < rels.length; i++) {
    const type = rels[i].getAttribute("Type") ?? "";
    if (type.endsWith("/3dmodel")) {
      return rels[i].getAttribute("Target") ?? null;
    }
  }
  return null;
}

async function loadModel(
  path: string,
  files: Record<string, Uint8Array>,
  models: Map<string, ParsedModelFile>,
): Promise<void> {
  const canon = canonical(path);
  if (models.has(canon)) return;

  const key = canon.startsWith("/") ? canon.slice(1) : canon;
  const bytes = files[key];
  if (!bytes) {
    throw new Error(`3MF referenced missing model: ${path}`);
  }

  const parsed = parseModelXml(decode(bytes));
  models.set(canon, parsed);

  // Eagerly follow p:path so buildObject can stay synchronous.
  for (const obj of parsed.objects.values()) {
    for (const comp of obj.components ?? []) {
      if (comp.path) await loadModel(comp.path, files, models);
    }
  }
  for (const item of parsed.buildItems) {
    if (item.path) await loadModel(item.path, files, models);
  }
}

// ---------------------------------------------------------------------------
// XML → ObjectDef / BuildItem

function parseModelXml(text: string): ParsedModelFile {
  const doc = parseXml(text);
  const objects = new Map<string, ObjectDef>();

  const objectEls = doc.getElementsByTagName("object");
  for (let i = 0; i < objectEls.length; i++) {
    const el = objectEls[i];
    const id = el.getAttribute("id");
    if (!id) continue;
    const name = el.getAttribute("name") ?? undefined;

    const meshEl = firstChild(el, "mesh");
    if (meshEl) {
      objects.set(id, { id, name, mesh: parseMesh(meshEl) });
      continue;
    }

    const componentsEl = firstChild(el, "components");
    const components: ComponentRef[] = [];
    if (componentsEl) {
      const compEls = componentsEl.getElementsByTagName("component");
      for (let j = 0; j < compEls.length; j++) {
        const c = compEls[j];
        const objectId = c.getAttribute("objectid");
        if (!objectId) continue;
        components.push({
          objectId,
          path: attr(c, "p:path") ?? undefined,
          transform: parseMatrix(c.getAttribute("transform")),
        });
      }
    }
    objects.set(id, { id, name, components });
  }

  const buildItems: BuildItem[] = [];
  const buildEl = doc.getElementsByTagName("build")[0];
  if (buildEl) {
    const itemEls = buildEl.getElementsByTagName("item");
    for (let i = 0; i < itemEls.length; i++) {
      const it = itemEls[i];
      const objectId = it.getAttribute("objectid");
      if (!objectId) continue;
      buildItems.push({
        objectId,
        path: attr(it, "p:path") ?? undefined,
        transform: parseMatrix(it.getAttribute("transform")),
      });
    }
  }

  return { objects, buildItems };
}

function parseMesh(meshEl: Element): MeshData {
  const verticesEl = firstChild(meshEl, "vertices");
  const trianglesEl = firstChild(meshEl, "triangles");

  const vertexEls = verticesEl ? verticesEl.getElementsByTagName("vertex") : null;
  const triangleEls = trianglesEl ? trianglesEl.getElementsByTagName("triangle") : null;

  const vCount = vertexEls ? vertexEls.length : 0;
  const tCount = triangleEls ? triangleEls.length : 0;

  const positions = new Float32Array(vCount * 3);
  const indices = new Uint32Array(tCount * 3);

  if (vertexEls) {
    for (let i = 0; i < vCount; i++) {
      const v = vertexEls[i];
      positions[i * 3 + 0] = parseFloat(v.getAttribute("x") ?? "0");
      positions[i * 3 + 1] = parseFloat(v.getAttribute("y") ?? "0");
      positions[i * 3 + 2] = parseFloat(v.getAttribute("z") ?? "0");
    }
  }
  if (triangleEls) {
    for (let i = 0; i < tCount; i++) {
      const t = triangleEls[i];
      indices[i * 3 + 0] = parseInt(t.getAttribute("v1") ?? "0", 10);
      indices[i * 3 + 1] = parseInt(t.getAttribute("v2") ?? "0", 10);
      indices[i * 3 + 2] = parseInt(t.getAttribute("v3") ?? "0", 10);
    }
  }

  return { positions, indices };
}

// ---------------------------------------------------------------------------
// Object instantiation

function buildObject(
  objectId: string,
  modelPath: string,
  models: Map<string, ParsedModelFile>,
  defaultMaterial: THREE.Material,
): THREE.Object3D {
  const model = models.get(modelPath);
  if (!model) {
    throw new Error(`3MF model file not loaded: ${modelPath}`);
  }
  const obj = model.objects.get(objectId);
  if (!obj) {
    throw new Error(`3MF object ${objectId} not in ${modelPath}`);
  }

  if (obj.mesh) {
    return makeMesh(obj.mesh, defaultMaterial, obj.name);
  }

  const group = new THREE.Group();
  if (obj.name) group.name = obj.name;
  for (const comp of obj.components ?? []) {
    const childPath = comp.path ? canonical(comp.path) : modelPath;
    const child = buildObject(comp.objectId, childPath, models, defaultMaterial);
    if (comp.transform) child.applyMatrix4(comp.transform);
    group.add(child);
  }
  return group;
}

function makeMesh(mesh: MeshData, material: THREE.Material, name?: string): THREE.Mesh {
  const indexed = new THREE.BufferGeometry();
  indexed.setAttribute("position", new THREE.BufferAttribute(mesh.positions, 3));
  indexed.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
  // Expand to per-triangle vertices before computing normals so each face
  // gets its own face-normal (i.e. flat shading). Matches how STLLoader's
  // non-indexed output renders — mechanical parts read clearly that way.
  // Smooth-shaded indexed normals make sharp edges look like fabric folds.
  const geom = indexed.toNonIndexed();
  indexed.dispose();
  geom.computeVertexNormals();
  if (name) geom.name = name;
  const m = new THREE.Mesh(geom, material);
  if (name) m.name = name;
  return m;
}

// ---------------------------------------------------------------------------
// Helpers

function unzipAsync(bytes: Uint8Array): Promise<Record<string, Uint8Array>> {
  return new Promise((resolve, reject) => {
    unzip(bytes, (err, data) => {
      if (err) reject(err);
      else resolve(data);
    });
  });
}

function parseXml(text: string): Document {
  return new DOMParser().parseFromString(text, "application/xml");
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder("utf-8").decode(bytes);
}

function canonical(path: string): string {
  return path.startsWith("/") ? path : "/" + path;
}

function firstChild(el: Element, tag: string): Element | null {
  for (const child of Array.from(el.children)) {
    // Compare against the local name so XML namespaces don't trip us up.
    if (child.tagName === tag || child.localName === tag) return child;
  }
  return null;
}

/** DOM `getAttribute` doesn't always see namespaced attrs without the
 * declaring xmlns; fall back to a localName lookup. */
function attr(el: Element, name: string): string | null {
  const direct = el.getAttribute(name);
  if (direct !== null) return direct;
  const localName = name.includes(":") ? name.split(":")[1] : name;
  return el.getAttributeNS(null, localName) ?? null;
}

/** 3MF Core §3.3.1: 12 floats in column-major order (cols 1-3 = rotation/scale,
 * col 4 = translation). We feed the transposed layout to `Matrix4.set` since
 * that takes row-major args. */
function parseMatrix(raw: string | null | undefined): THREE.Matrix4 | undefined {
  if (!raw) return undefined;
  const v = raw.trim().split(/\s+/).map(Number);
  if (v.length !== 12 || v.some(Number.isNaN)) return undefined;
  const m = new THREE.Matrix4();
  m.set(
    v[0], v[3], v[6], v[9],
    v[1], v[4], v[7], v[10],
    v[2], v[5], v[8], v[11],
    0, 0, 0, 1,
  );
  return m;
}
