/// <reference lib="webworker" />

// STEP parsing worker.
//
// Lives off the main thread because occt-import-js runs the OpenCascade
// kernel synchronously: a real assembly can block JS for seconds, freezing
// the renderer, OrbitControls, status updates, and menu input. With the
// kernel in a worker the main thread keeps rendering at 60 fps while parse
// proceeds; only the final geometry build (back on the main thread) touches
// Three.js state.

import occtFactory, { type OcctModule } from "occt-import-js";
import wasmUrl from "occt-import-js/dist/occt-import-js.wasm?url";

import type { ParseRequest, ParseResponse, WorkerMesh } from "./step-types";

const ctx = self as unknown as DedicatedWorkerGlobalScope;

function wdbg(enabled: boolean, ...args: unknown[]): void {
  if (enabled) console.log("[stlviewer:step-worker]", ...args);
}

wdbg(true, "module loaded; wasmUrl =", wasmUrl);

let modulePromise: Promise<OcctModule> | null = null;

function loadModule(debug: boolean): Promise<OcctModule> {
  if (!modulePromise) {
    wdbg(debug, "occtFactory typeof =", typeof occtFactory);
    if (typeof occtFactory !== "function") {
      throw new Error(
        `occt-import-js default export is ${typeof occtFactory}, expected function`,
      );
    }
    wdbg(debug, "calling occtFactory, wasmUrl =", wasmUrl);
    modulePromise = occtFactory({
      locateFile: (path) => {
        wdbg(debug, "locateFile called with", path);
        return path.endsWith(".wasm") ? wasmUrl : path;
      },
    });
    modulePromise
      .then(() => wdbg(debug, "occt module ready"))
      .catch((e) => wdbg(true, "occtFactory rejected", e));
  }
  return modulePromise;
}

ctx.onmessage = async (event: MessageEvent<ParseRequest>) => {
  const { id, bytes, debug } = event.data;
  wdbg(debug, "<- onmessage", { id, bytes: bytes.byteLength });
  try {
    const occt = await loadModule(debug);
    wdbg(debug, "calling ReadStepFile", { id });
    const result = occt.ReadStepFile(new Uint8Array(bytes), null);
    wdbg(debug, "ReadStepFile returned", {
      id,
      success: result.success,
      meshes: result.success ? result.meshes.length : undefined,
    });
    if (!result.success) {
      reply({ id, ok: false, error: "occt-import-js reported success=false" });
      return;
    }

    const meshes: WorkerMesh[] = [];
    const transfers: ArrayBuffer[] = [];

    for (const m of result.meshes) {
      const positions = new Float32Array(m.attributes.position.array).buffer;
      const normals = m.attributes.normal
        ? new Float32Array(m.attributes.normal.array).buffer
        : null;
      const indices = new Uint32Array(m.index.array).buffer;

      meshes.push({
        name: m.name,
        color: m.color ?? null,
        positions,
        normals,
        indices,
      });

      transfers.push(positions, indices);
      if (normals) transfers.push(normals);
    }

    wdbg(debug, "-> postMessage reply", {
      id,
      meshes: meshes.length,
      transferring_buffers: transfers.length,
    });
    reply({ id, ok: true, meshes }, transfers);
  } catch (err) {
    wdbg(true, "exception in onmessage", err);
    reply({ id, ok: false, error: errorMessage(err) });
  }
};

function reply(message: ParseResponse, transfer: ArrayBuffer[] = []): void {
  ctx.postMessage(message, transfer);
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return String(err);
}
