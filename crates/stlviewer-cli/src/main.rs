//! `stlviewer` — terminal shim that hands off to the GUI app and returns
//! immediately, so the shell prompt isn't blocked.
//!
//! macOS: uses `open -na "stlviewer" --args …` so launchd starts each instance
//! as an independent process (per design: every invocation is a new window).
//! Linux/Windows are stubbed out for v0.

use std::path::PathBuf;
use std::process::Command;

use anyhow::{bail, Context, Result};
use clap::Parser;

#[derive(Parser, Debug)]
#[command(name = "stlviewer", version, about = "Open STL/STEP files in stlviewer")]
struct Args {
    /// Path to the .stl or .step/.stp file to open
    file: Option<PathBuf>,

    /// Watch the file and reload on change
    #[arg(long, conflicts_with = "no_watch")]
    watch: bool,

    /// Do not watch the file (overrides config default)
    #[arg(long)]
    no_watch: bool,
}

fn main() -> Result<()> {
    let args = Args::parse();

    // Canonicalize so the GUI doesn't have to know the shell's CWD. `open
    // --args` runs the GUI from an unrelated working directory.
    let resolved = args
        .file
        .as_ref()
        .map(|p| {
            p.canonicalize()
                .with_context(|| format!("resolving path: {}", p.display()))
        })
        .transpose()?;

    let mut forwarded: Vec<String> = Vec::new();
    if let Some(path) = resolved {
        forwarded.push(path.to_string_lossy().into_owned());
    }
    if args.watch {
        forwarded.push("--watch".into());
    } else if args.no_watch {
        forwarded.push("--no-watch".into());
    }

    launch(&forwarded)
}

#[cfg(target_os = "macos")]
fn launch(forwarded: &[String]) -> Result<()> {
    let mut cmd = Command::new("open");
    // -n: always start a new instance (per-window-is-its-own-process design)
    // -a: by app name; resolves via Launch Services
    cmd.args(["-na", "stlviewer"]);
    if !forwarded.is_empty() {
        cmd.arg("--args").args(forwarded);
    }
    let status = cmd.status().context("invoking `open`")?;
    if !status.success() {
        bail!(
            "`open` exited with status {status}. Is stlviewer.app installed and registered with Launch Services?"
        );
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn launch(_forwarded: &[String]) -> Result<()> {
    bail!("stlviewer-cli currently supports macOS only; Linux/Windows shims land in a follow-up")
}
