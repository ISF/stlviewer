# stlviewer

Lightweight STL/STEP viewer for CAD design and 3D printing. macOS only for
now; Linux and Windows are planned.

## Features

- Opens `.stl` (binary or ASCII) and `.step` / `.stp` files.
- Drag-and-drop a file onto the window, open via the native ⌘O dialog, or
  pass a path to `stlviewer` from the terminal.
- Orbit / pan / zoom with mouse + trackpad gestures. ⌘0 fits the view to
  the loaded model.
- File watching — re-export from your CAD tool and the viewer reloads
  automatically (toggle from `View ▸ Auto-Reload File` or `--watch` on the
  command line).
- Native macOS menu bar with persistent View toggles for grid, axes, and
  auto-reload. Choices survive across launches.
- Settings live in macOS `defaults` under the
  `com.ivansich.stlviewer` domain, so you can tweak them from the terminal:

  ```sh
  defaults write com.ivansich.stlviewer background_color -string "#1a2030"
  defaults write com.ivansich.stlviewer up_axis -string "y"
  defaults delete com.ivansich.stlviewer up_axis        # back to default
  ```

## Install

There are no prebuilt binaries yet — build from source:

```sh
git clone https://github.com/ISF/stlviewer.git
cd stlviewer
bun install
./scripts/install.sh
```

`install.sh` builds the release `.app`, drops it in `/Applications/`,
registers it with Launch Services, and puts the `stlviewer` CLI shim on
your `$PATH` (`/opt/homebrew/bin` on Apple Silicon, `/usr/local/bin`
elsewhere). After install:

```sh
stlviewer                            # empty window
stlviewer path/to/model.stl          # open a file
stlviewer --watch path/to/part.step  # open + reload on save
```

`./scripts/uninstall.sh` reverses the install.

### Build requirements

- Rust (stable) — `rustc`, `cargo`
- [Bun](https://bun.sh) — `brew install oven-sh/bun/bun` on macOS
- Xcode Command Line Tools (for the macOS frameworks Tauri links against)

## Develop

Run the app in dev mode (Vite hot-reload + cargo watch + native window):

```sh
bun install
bun run tauri dev
```

Build a release `.app` bundle without installing:

```sh
bun run tauri build
```

The bundle ends up at `target/release/bundle/macos/stlviewer.app`.

## Layout

```
stlviewer/
├── Cargo.toml              # Rust workspace
├── package.json            # JS toolchain (Bun-driven)
├── bun.lock
├── vite.config.ts
├── tsconfig.json
├── index.html              # frontend entry
├── src/                    # TypeScript
│   ├── main.ts             # scene + IPC wiring
│   ├── debug.ts
│   ├── loaders/{stl,step,step.worker,step-types}.ts
│   └── types/
├── src-tauri/              # Tauri GUI binary (Rust)
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   ├── .taurignore         # dev-watcher exclusions
│   ├── capabilities/
│   ├── icons/
│   └── src/
│       ├── main.rs, lib.rs
│       └── config/         # KvStore trait + Settings + CFPreferences impl
├── crates/
│   └── stlviewer-cli/      # `stlviewer` shim that goes on $PATH
├── licenses/               # vendored third-party license texts
├── keys/                   # pinned release-signing public key
├── scripts/                # icon generator, install, uninstall, release
├── LICENSE                 # MIT
└── THIRD_PARTY_NOTICES.md  # OCCT / occt-import-js attribution
```

## Architecture

- **GUI** is Tauri 2 (Rust shell) + Three.js (rendering) inside the
  OS-native webview. No bundled JS engine — the OS provides the JS runtime
  (WKWebView on macOS, WebView2 on Windows, WebKitGTK on Linux).
- **STEP parsing** runs in a Web Worker via
  [occt-import-js](https://github.com/kovacsv/occt-import-js), a WebAssembly
  build of Open CASCADE Technology. Off the main thread so the renderer
  stays responsive even on large assemblies.
- **CLI shim** is a tiny Rust binary that hands off to the GUI via
  `open -na stlviewer --args …` on macOS, so the terminal returns
  immediately and each invocation is its own process / window.
- **Settings** live in macOS CFPreferences via a small `KvStore` trait;
  Linux (XDG) and Windows (Registry) backends can drop in alongside without
  touching the rest of the app.

## Verifying releases

Each release ships an SSH-signed `.app.zip` alongside its `.sig` and
`.sha256`. The signing public key is pinned in this repo at
[`keys/release-signing.pub`](./keys/release-signing.pub) — that's the
trusted out-of-band source for verification, not whatever the release
page happens to ship.

Once you've downloaded `stlviewer-vX.Y.Z-macos-<arch>.app.zip` and the
matching `.sig` from the release page:

```sh
# Build a one-line allowed_signers from the pinned key.
PRINCIPAL=release@stlviewer
ZIP=stlviewer-vX.Y.Z-macos-arm64.app.zip
KEY=$(curl -fsSL https://raw.githubusercontent.com/ISF/stlviewer/main/keys/release-signing.pub)
echo "$PRINCIPAL namespaces=\"file\" $KEY" > /tmp/allowed_signers

# Verify the signature.
ssh-keygen -Y verify -f /tmp/allowed_signers -I "$PRINCIPAL" -n file \
    -s "${ZIP}.sig" < "$ZIP"

# Sanity-check the checksum.
shasum -a 256 -c "${ZIP}.sha256"
```

A `Good "file" signature for release@stlviewer …` line means the artifact
came from someone with access to the pinned private key and hasn't been
modified since.

This is **not** Apple code signing — macOS Gatekeeper still treats the
unzipped `.app` as "unidentified developer" on first launch. The SSH
signature is an additional, independent attestation. Apple Developer ID
signing is a separate track that may land in a later release.

## Licensing

`stlviewer`'s own source is **MIT** — see [LICENSE](./LICENSE).

At runtime it loads Open CASCADE Technology (LGPL-2.1) via the
[`occt-import-js`](https://github.com/kovacsv/occt-import-js) WebAssembly
build. That dependency stays separate as a discrete `.wasm` asset so users
remain free to substitute their own OCCT build, per LGPL-2.1.

Full attribution, license texts, and substitution instructions are in
[THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md). Vendored copies of the
LGPL license texts live under [`licenses/`](./licenses/) and are bundled
into the application's `Contents/Resources/` when built.
