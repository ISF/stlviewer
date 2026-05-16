import * as THREE from "three";

import StepWorker from "./step.worker?worker";
import type { ParseRequest, ParseResponse, WorkerMesh } from "./step-types";
import { dbg, isDebugEnabled } from "../debug";

export interface ParsedStep {
  group: THREE.Group;
  triangleCount: number;
  partCount: number;
}

// One worker, kept alive across parses. The first parse pays the WASM load
// cost; subsequent parses skip it. Cancellation isn't needed yet — the
// worker processes requests serially and the user can't queue much faster
// than `occt-import-js` consumes.
let workerInstance: Worker | null = null;
const pending = new Map<
  number,
  { resolve: (r: Extract<ParseResponse, { ok: true }>) => void; reject: (e: Error) => void }
>();
let nextId = 0;

function getWorker(): Worker {
  if (workerInstance) return workerInstance;

  dbg("step", "constructing worker");
  const w = new StepWorker({ name: "stlviewer-step" });
  dbg("step", "worker constructed", w);

  w.onmessage = (event: MessageEvent<ParseResponse>) => {
    const resp = event.data;
    dbg("step", "<- worker message", {
      id: resp.id,
      ok: resp.ok,
      meshes: resp.ok ? resp.meshes.length : undefined,
      error: resp.ok ? undefined : resp.error,
    });
    const handler = pending.get(resp.id);
    if (!handler) return;
    pending.delete(resp.id);
    if (resp.ok) handler.resolve(resp);
    else handler.reject(new Error(resp.error));
  };

  w.onerror = (event) => {
    // An unexpected error inside the worker (e.g. WASM load failure)
    // carries no request id, so fail every in-flight parse.
    dbg("step", "worker onerror", event.message, event.filename, event.lineno);
    const err = new Error(event.message || "STEP worker errored");
    for (const { reject } of pending.values()) reject(err);
    pending.clear();
  };

  w.onmessageerror = (event) => {
    dbg("step", "worker onmessageerror", event);
  };

  workerInstance = w;
  return w;
}

export async function parseStep(
  bytes: Uint8Array,
  defaultMaterial: THREE.Material,
): Promise<ParsedStep> {
  const id = nextId++;
  dbg("step", "parseStep enter", { id, bytes: bytes.byteLength });

  // Copy into a fresh, owned ArrayBuffer before transferring — the input
  // may be a view over a larger buffer (Tauri's IPC byte arrays often are),
  // and transferring that would steal more than we own.
  const owned = bytes.slice().buffer;
  dbg("step", "prepared owned buffer", {
    id,
    owned_bytes: owned.byteLength,
  });

  const response = await new Promise<Extract<ParseResponse, { ok: true }>>(
    (resolve, reject) => {
      pending.set(id, { resolve, reject });
      const message: ParseRequest = { id, bytes: owned, debug: isDebugEnabled() };
      dbg("step", "-> worker postMessage", { id, transferring: owned.byteLength });
      getWorker().postMessage(message, [owned]);
    },
  );

  dbg("step", "building THREE.Group", { id, meshes: response.meshes.length });
  const parsed = buildGroup(response.meshes, defaultMaterial);
  dbg("step", "parseStep return", {
    id,
    triangleCount: parsed.triangleCount,
    partCount: parsed.partCount,
  });
  return parsed;
}

function buildGroup(meshes: WorkerMesh[], defaultMaterial: THREE.Material): ParsedStep {
  const group = new THREE.Group();
  let triangleCount = 0;

  for (const m of meshes) {
    const geom = new THREE.BufferGeometry();
    geom.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array(m.positions), 3),
    );
    if (m.normals) {
      geom.setAttribute(
        "normal",
        new THREE.BufferAttribute(new Float32Array(m.normals), 3),
      );
    }
    geom.setIndex(new THREE.BufferAttribute(new Uint32Array(m.indices), 1));
    if (!m.normals) geom.computeVertexNormals();
    geom.name = m.name;

    const material = m.color
      ? new THREE.MeshStandardMaterial({
          color: new THREE.Color(m.color[0], m.color[1], m.color[2]),
          metalness: 0.1,
          roughness: 0.55,
          side: THREE.DoubleSide,
        })
      : defaultMaterial;

    const mesh = new THREE.Mesh(geom, material);
    mesh.name = m.name;

    triangleCount += m.indices.byteLength / Uint32Array.BYTES_PER_ELEMENT / 3;
    group.add(mesh);
  }

  return { group, triangleCount, partCount: meshes.length };
}
