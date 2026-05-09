import { defineConfig } from "vite";

// Tauri runs Vite as `beforeDevCommand`. We disable Vite's screen-clearing so
// Tauri's own logs stay visible, and we lock the dev port so `tauri.conf.json`
// (`devUrl`) and Vite agree.
export default defineConfig({
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    target: "es2022",
    minify: "esbuild",
    sourcemap: true,
  },
});
