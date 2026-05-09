declare module "occt-import-js" {
  export interface OcctMesh {
    name: string;
    color?: [number, number, number];
    attributes: {
      position: { array: number[] };
      normal?: { array: number[] };
    };
    index: { array: number[] };
    brep_faces?: Array<{
      first: number;
      last: number;
      color: [number, number, number] | null;
    }>;
  }

  export interface OcctResult {
    success: boolean;
    root: { name: string; meshes: number[]; children: unknown[] };
    meshes: OcctMesh[];
  }

  export interface OcctModule {
    ReadStepFile(buffer: Uint8Array, params: object | null): OcctResult;
    ReadIgesFile(buffer: Uint8Array, params: object | null): OcctResult;
    ReadBrepFile(buffer: Uint8Array, params: object | null): OcctResult;
  }

  type OcctModuleArgs = {
    locateFile?: (path: string, scriptDirectory: string) => string;
  };

  const factory: (moduleArgs?: OcctModuleArgs) => Promise<OcctModule>;
  export default factory;
}

declare module "*.wasm?url" {
  const url: string;
  export default url;
}
