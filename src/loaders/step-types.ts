// Shared message protocol between the main thread (step.ts) and the worker
// (step.worker.ts). Kept in its own module so both sides import the same
// declarations and Vite doesn't accidentally pull the worker's runtime
// dependencies into the main bundle.

export interface WorkerMesh {
  name: string;
  /** STEP-supplied RGB in [0, 1], or null when the part inherits the default. */
  color: [number, number, number] | null;
  /** Float32 vertex positions, flat triplets. Transferred. */
  positions: ArrayBuffer;
  /** Float32 vertex normals, flat triplets, or null. Transferred when present. */
  normals: ArrayBuffer | null;
  /** Uint32 triangle indices into the vertex array. Transferred. */
  indices: ArrayBuffer;
}

export interface ParseRequest {
  id: number;
  /** Raw STEP file bytes. Transferred — caller must not touch after post. */
  bytes: ArrayBuffer;
  /** When true, the worker emits console breadcrumbs for this request. */
  debug: boolean;
}

export type ParseResponse =
  | {
      id: number;
      ok: true;
      meshes: WorkerMesh[];
    }
  | {
      id: number;
      ok: false;
      error: string;
    };
