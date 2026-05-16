// Tiny debug-logging helper. Enabled when the GUI was launched with `--debug`
// (or via the CLI shim). All call sites stay zero-cost when off — the early
// return short-circuits before any string formatting.

let enabled = false;

export function setDebugEnabled(v: boolean): void {
  enabled = v;
  if (v) {
    // First-line marker so a grep on console output finds the start of a run.
    console.log("[stlviewer] debug logging enabled");
  }
}

export function isDebugEnabled(): boolean {
  return enabled;
}

export function dbg(tag: string, ...args: unknown[]): void {
  if (!enabled) return;
  console.log(`[stlviewer:${tag}]`, ...args);
}
