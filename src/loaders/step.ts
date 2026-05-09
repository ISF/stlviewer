import * as THREE from "three";
import occtFactory, { type OcctMesh, type OcctModule } from "occt-import-js";
import wasmUrl from "occt-import-js/dist/occt-import-js.wasm?url";

let modulePromise: Promise<OcctModule> | null = null;

function loadModule(): Promise<OcctModule> {
  // Lazy & cached. The Emscripten module's locateFile callback is asked to
  // resolve "occt-import-js.wasm" — we hand back the URL Vite gives us.
  if (!modulePromise) {
    if (typeof occtFactory !== "function") {
      // The package is UMD with `module.exports = …`. If Vite's CJS interop
      // is misconfigured the default import will be the namespace object, not
      // the factory — fail loudly so we don't silently `await undefined`.
      throw new Error(
        `occt-import-js default import is ${typeof occtFactory}, expected function. ` +
          `Check Vite optimizeDeps configuration.`,
      );
    }
    modulePromise = occtFactory({
      locateFile: (path) => (path.endsWith(".wasm") ? wasmUrl : path),
    });
  }
  return modulePromise;
}

export interface ParsedStep {
  group: THREE.Group;
  triangleCount: number;
  partCount: number;
}

export async function parseStep(
  bytes: Uint8Array,
  defaultMaterial: THREE.Material,
): Promise<ParsedStep> {
  const occt = await loadModule();
  const result = occt.ReadStepFile(bytes, null);
  if (!result.success) {
    throw new Error("STEP parse failed (occt-import-js reported success=false)");
  }

  const group = new THREE.Group();
  let triangleCount = 0;

  for (const meshData of result.meshes) {
    const mesh = buildMesh(meshData, defaultMaterial);
    triangleCount += meshData.index.array.length / 3;
    group.add(mesh);
  }

  return { group, triangleCount, partCount: result.meshes.length };
}

function buildMesh(meshData: OcctMesh, defaultMaterial: THREE.Material): THREE.Mesh {
  const geom = new THREE.BufferGeometry();
  geom.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(meshData.attributes.position.array, 3),
  );
  if (meshData.attributes.normal) {
    geom.setAttribute(
      "normal",
      new THREE.Float32BufferAttribute(meshData.attributes.normal.array, 3),
    );
  } else {
    // Fall back to flat-face normals if the kernel didn't provide them.
    geom.setIndex(new THREE.BufferAttribute(Uint32Array.from(meshData.index.array), 1));
    geom.computeVertexNormals();
  }

  // Set or replace the index after the (possible) normal computation above.
  geom.setIndex(new THREE.BufferAttribute(Uint32Array.from(meshData.index.array), 1));
  geom.name = meshData.name;

  // Use the part color if STEP carried one; otherwise the shared default
  // material is fine. We deliberately skip per-face brep_faces colors in v0
  // to keep the scene cheap; revisit when we add the inspection panel.
  const material = meshData.color
    ? new THREE.MeshStandardMaterial({
        color: new THREE.Color(meshData.color[0], meshData.color[1], meshData.color[2]),
        metalness: 0.1,
        roughness: 0.55,
        side: THREE.DoubleSide,
      })
    : defaultMaterial;

  const mesh = new THREE.Mesh(geom, material);
  mesh.name = meshData.name;
  return mesh;
}

/**
 * Recursively dispose all geometries and any per-mesh materials on a Group.
 * The shared default material is owned by main.ts and left alone.
 */
export function disposeStepGroup(group: THREE.Group, sharedMaterial: THREE.Material): void {
  group.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      child.geometry.dispose();
      const mats = Array.isArray(child.material) ? child.material : [child.material];
      for (const m of mats) {
        if (m !== sharedMaterial) m.dispose();
      }
    }
  });
}
