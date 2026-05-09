# stlviewer

Lightweight STL/STEP viewer intended as a companion for Claude-assisted CAD
design and 3D printing workflows. Mac-first prototype; Linux and Windows
support planned.

## Status

Bootstrap scaffold. Renders a placeholder cube with orbit/pan/zoom controls.
File loading (STL via three.js, STEP via occt-import-js), file watching, and
config integration are pending.

## Layout

```
stlviewer/
├── Cargo.toml              # Rust workspace
├── package.json            # JS toolchain (Bun-driven)
├── vite.config.ts
├── tsconfig.json
├── index.html              # frontend entry
├── src/                    # TypeScript: Three.js scene, loaders, UI
├── src-tauri/              # Tauri GUI binary (Rust)
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   ├── capabilities/
│   └── src/{main.rs, lib.rs}
└── crates/
    └── stlviewer-cli/      # `stlviewer` shim that goes on $PATH
        └── src/main.rs
```

## Setup

Required toolchain:

- Rust (stable) — `rustc`, `cargo`
- [Bun](https://bun.sh) for the JS side: `curl -fsSL https://bun.sh/install | bash`

Install dependencies:

```sh
bun install
```

Run the dev app:

```sh
bun run tauri dev
```

## Architecture

- **GUI** is Tauri 2 (Rust shell) + Three.js (rendering) inside the OS-native
  webview. No bundled JS engine — see notes in design.
- **CLI shim** is a tiny Rust binary that hands off to the GUI via
  `open -na stlviewer --args …` on macOS so the terminal returns immediately
  and each invocation is its own process / window.
- **Config** will live in macOS `defaults` (CFPreferences) under bundle id
  `com.ivansich.stlviewer`, falling back to per-platform conventions on
  Linux/Windows.

## License

MIT — see [LICENSE](./LICENSE).
