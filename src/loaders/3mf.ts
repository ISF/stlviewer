import * as THREE from "three";
import { ThreeMFLoader } from "three/examples/jsm/loaders/3MFLoader.js";

export interface ParsedThreeMf {
  group: THREE.Group;
  triangleCount: number;
  partCount: number;
}

/**
 * Parse a `.3mf` archive into a `THREE.Group`. We only care about the
 * geometry — project/build/material metadata in the .3mf is ignored.
 *
 * Three.js's loader uses the bundled fflate to unzip and the OPC-style XML
 * inside (`3D/3dmodel.model`) for mesh data. We hand it the raw bytes and
 * walk the returned scene tree to count parts + triangles for the status
 * bar, replacing every mesh's material with the caller-provided default so
 * STL-loaded and 3MF-loaded scenes look consistent.
 */
export function parseThreeMf(
  bytes: Uint8Array,
  defaultMaterial: THREE.Material,
): ParsedThreeMf {
  const ab = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;

  const group = new ThreeMFLoader().parse(ab);

  let triangleCount = 0;
  let partCount = 0;
  group.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      partCount += 1;
      const geom = child.geometry as THREE.BufferGeometry;
      if (!geom.attributes.normal) geom.computeVertexNormals();
      child.material = defaultMaterial;
      triangleCount += geom.index
        ? geom.index.count / 3
        : geom.attributes.position.count / 3;
    }
  });

  return { group, triangleCount, partCount };
}
