# stlviewer

Lightweight STL/STEP viewer intended as a companion for Claude-assisted CAD
design and 3D printing workflows. Mac-first prototype; Linux and Windows
support planned.

## Status

STL and STEP loading work (drag-and-drop, native macOS `File ▸ Open`,
or `stlviewer <path>` from the terminal once installed). Orbit/pan/zoom,
auto-fit to bounding box, file-watch reload. Bundling and CFPreferences-
backed config are next.

## Layout

```
stlviewer/
├── Cargo.toml              # Rust workspace
├── package.json            # JS toolchain (Bun-driven)
├── vite.config.ts
├── tsconfig.json
├── index.html              # frontend entry
├── src/                    # TypeScript: Three.js scene, loaders, UI
│   ├── main.ts
│   ├── loaders/{stl.ts, step.ts}
│   └── types/
├── src-tauri/              # Tauri GUI binary (Rust)
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   ├── capabilities/
│   ├── icons/
│   └── src/{main.rs, lib.rs}
├── crates/
│   └── stlviewer-cli/      # `stlviewer` shim that goes on $PATH
│       └── src/main.rs
├── licenses/               # third-party license texts (vendored)
└── scripts/                # tooling: icon generator, install scripts, …
```

## Setup

Required toolchain:

- Rust (stable) — `rustc`, `cargo`
- [Bun](https://bun.sh) — `brew install oven-sh/bun/bun` on macOS

Install dependencies:

```sh
bun install
```

Run the dev app:

```sh
bun run tauri dev
```

Build a release `.app` bundle:

```sh
bun run tauri build
```

## Architecture

- **GUI** is Tauri 2 (Rust shell) + Three.js (rendering) inside the OS-native
  webview. No bundled JS engine — the OS provides the JS runtime (WKWebView
  on macOS, WebView2 on Windows, WebKitGTK on Linux).
- **CLI shim** is a tiny Rust binary that hands off to the GUI via
  `open -na stlviewer --args …` on macOS so the terminal returns immediately
  and each invocation is its own process / window.
- **STEP** is parsed by Open CASCADE Technology, loaded as a WebAssembly
  module (`occt-import-js`) at runtime.
- **Config** will live in macOS `defaults` (CFPreferences) under bundle id
  `com.ivansich.stlviewer`, falling back to per-platform conventions on
  Linux/Windows.

## Licensing

`stlviewer`'s own source is **MIT**-licensed — see [LICENSE](./LICENSE).

At runtime it loads Open CASCADE Technology (LGPL-2.1) via the
[`occt-import-js`](https://github.com/kovacsv/occt-import-js) WebAssembly
build. That dependency stays separate (a discrete `.wasm` asset) so users
remain free to substitute their own OCCT build, per LGPL-2.1.

Full attribution, license texts, and substitution instructions are in
[THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md). Vendored copies of the
license files live under [`licenses/`](./licenses/) and are bundled into
the application's `Contents/Resources/` when built.
