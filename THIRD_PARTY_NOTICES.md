# Third-party notices

`stlviewer` is distributed under the [MIT License](./LICENSE). It links against
the following third-party components at runtime, each of which retains its
own license. Acknowledgements and the obligations imposed by those licenses
are documented here.

## Open CASCADE Technology (OCCT)

- **Role:** CAD geometry kernel. STEP files are parsed and tessellated by
  OCCT, which is invoked through `occt-import-js` (a WebAssembly build).
- **License:** GNU Lesser General Public License v2.1 (LGPL-2.1), with
  Open CASCADE's exception clause.
- **License text:** [`licenses/occt.txt`](./licenses/occt.txt)
- **Upstream source:** <https://dev.opencascade.org/>

## occt-import-js

- **Role:** The Emscripten/WebAssembly binding around OCCT that exposes
  `ReadStepFile`, `ReadIgesFile`, and `ReadBrepFile` to JavaScript.
- **License:** GNU Lesser General Public License v2.1 (LGPL-2.1).
- **License text:** [`licenses/occt-import-js.txt`](./licenses/occt-import-js.txt)
- **Upstream source:** <https://github.com/kovacsv/occt-import-js>

## LGPL compliance model

`stlviewer` loads `occt-import-js.wasm` at runtime as a discrete asset
(located in dev under `node_modules/occt-import-js/dist/` and copied verbatim
into the macOS `.app` bundle under `Contents/Resources/_up_/dist/` when built).
This satisfies LGPL-2.1 §6 by being dynamic linking: users are free to
substitute an alternative build of OCCT / `occt-import-js` without rebuilding
`stlviewer` itself, by replacing the `occt-import-js.wasm` (and accompanying
`occt-import-js.js`) inside the bundle.

For users who wish to do so:

1. Obtain or build a compatible `occt-import-js.wasm`. The upstream sources
   above contain build instructions (Emscripten + the OCCT source tree).
2. Inside `stlviewer.app/Contents/Resources/`, replace the existing
   `occt-import-js.wasm` and `occt-import-js.js` with your build.
3. Re-codesign the bundle if it was previously signed and your platform
   enforces signature verification.

The full corresponding source for OCCT and `occt-import-js` is available from
the upstream URLs listed above.

## Other dependencies

The remaining runtime and build dependencies are permissively licensed:

- **three.js** — MIT — <https://github.com/mrdoob/three.js>
- **Tauri** — MIT or Apache-2.0 — <https://github.com/tauri-apps/tauri>
- **Rust crates** used by the Tauri binary and the CLI shim — see
  `Cargo.lock` for the precise version graph; all are MIT- or Apache-2.0-
  licensed at the versions pinned there.

No copyleft propagates into `stlviewer`'s own source code.
