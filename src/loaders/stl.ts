import * as THREE from "three";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";

export function parseStl(bytes: Uint8Array, material: THREE.Material): THREE.Mesh {
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const geom = new STLLoader().parse(ab);
  if (!geom.attributes.normal) geom.computeVertexNormals();
  return new THREE.Mesh(geom, material);
}
