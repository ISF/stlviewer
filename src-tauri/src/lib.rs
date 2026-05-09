use std::path::PathBuf;

use clap::Parser;
use serde::Serialize;

#[derive(Parser, Debug, Clone)]
#[command(name = "stlviewer", version, about = "STL/STEP viewer", disable_help_flag = false)]
struct CliArgs {
    /// Path to the .stl or .step/.stp file to open
    file: Option<PathBuf>,

    /// Watch the file and reload on change (overrides config default)
    #[arg(long, conflicts_with = "no_watch")]
    watch: bool,

    /// Disable watching even if config has it on by default
    #[arg(long)]
    no_watch: bool,
}

/// Effective initial state shipped to the webview at startup.
#[derive(Serialize, Clone, Debug)]
struct InitialArgs {
    file: Option<String>,
    watch: bool,
}

#[tauri::command]
fn get_initial_args(state: tauri::State<'_, InitialArgs>) -> InitialArgs {
    state.inner().clone()
}

pub fn run() {
    // The Tauri binary may be launched directly (./stlviewer-app foo.stl) or
    // via `open -na stlviewer --args foo.stl`. In both cases the args land in
    // std::env::args(), so clap parses them uniformly.
    let cli = CliArgs::try_parse().unwrap_or_else(|e| {
        // On parse failure (e.g. --help), print and exit cleanly.
        e.exit()
    });

    let initial = InitialArgs {
        file: cli
            .file
            .as_ref()
            .map(|p| p.to_string_lossy().into_owned()),
        watch: resolve_watch(cli.watch, cli.no_watch),
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(initial)
        .invoke_handler(tauri::generate_handler![get_initial_args])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// Precedence: explicit CLI flag > config default > built-in default (false).
/// Config integration lands in a follow-up; for now the built-in default wins
/// when no flag is set.
fn resolve_watch(watch: bool, no_watch: bool) -> bool {
    if watch {
        return true;
    }
    if no_watch {
        return false;
    }
    config_default_watch().unwrap_or(false)
}

#[cfg(target_os = "macos")]
fn config_default_watch() -> Option<bool> {
    // TODO: read CFPreferences for `com.ivansich.stlviewer` key `watch_by_default`.
    None
}

#[cfg(not(target_os = "macos"))]
fn config_default_watch() -> Option<bool> {
    None
}
