mod config;

use std::path::PathBuf;
use std::sync::Mutex;

use clap::Parser;
use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter};

use crate::config::{Settings, UpAxis};

#[derive(Parser, Debug, Clone)]
#[command(name = "stlviewer", version, about = "STL/STEP viewer")]
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

#[derive(Serialize, Clone, Debug)]
struct InitialArgs {
    file: Option<String>,
    watch: bool,
    /// Effective settings the frontend needs at scene-construction time.
    /// Keep this struct flat so the JS side can read fields directly.
    up_axis: UpAxis,
    background_color: [f32; 3],
    grid_visible: bool,
    axes_visible: bool,
}

#[derive(Default)]
struct WatcherState(Mutex<Option<RecommendedWatcher>>);

#[tauri::command]
fn get_initial_args(state: tauri::State<'_, InitialArgs>) -> InitialArgs {
    state.inner().clone()
}

/// Read raw bytes from any path the user has explicitly chosen (CLI arg,
/// dialog selection, drag-drop). We bypass tauri-plugin-fs scoping on
/// purpose — the action is always user-initiated, and STL/STEP files can
/// live anywhere on disk.
#[tauri::command]
fn read_file_bytes(path: String) -> Result<Vec<u8>, String> {
    std::fs::read(&path).map_err(|e| format!("read {path}: {e}"))
}

#[tauri::command]
fn start_watch(
    app: AppHandle,
    state: tauri::State<'_, WatcherState>,
    path: String,
) -> Result<(), String> {
    let target = PathBuf::from(&path)
        .canonicalize()
        .map_err(|e| format!("canonicalize {path}: {e}"))?;
    // Watch the parent directory non-recursively. Editors often save via
    // write-to-tempfile-then-rename, which destroys the original inode and
    // detaches a file-level watcher. A directory watch survives that.
    let parent = target
        .parent()
        .ok_or_else(|| format!("no parent dir for {path}"))?
        .to_path_buf();

    let app_clone = app.clone();
    let target_for_filter = target.clone();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        let Ok(ev) = res else { return };
        if !matches!(ev.kind, EventKind::Modify(_) | EventKind::Create(_)) {
            return;
        }
        let matched = ev.paths.iter().any(|p| {
            p.canonicalize()
                .map(|cp| cp == target_for_filter)
                .unwrap_or_else(|_| p == &target_for_filter)
        });
        if matched {
            let _ = app_clone.emit("file-changed", target_for_filter.to_string_lossy().to_string());
        }
    })
    .map_err(|e| format!("create watcher: {e}"))?;

    watcher
        .watch(&parent, RecursiveMode::NonRecursive)
        .map_err(|e| format!("watch {}: {e}", parent.display()))?;

    *state.0.lock().unwrap() = Some(watcher);
    Ok(())
}

#[tauri::command]
fn stop_watch(state: tauri::State<'_, WatcherState>) {
    *state.0.lock().unwrap() = None;
}

fn build_menu<R: tauri::Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let app_menu = Submenu::with_items(
        app,
        "stlviewer",
        true,
        &[
            &PredefinedMenuItem::about(
                app,
                Some("About stlviewer"),
                Some(AboutMetadata {
                    name: Some("stlviewer".into()),
                    version: Some(env!("CARGO_PKG_VERSION").into()),
                    authors: Some(vec!["Ivan Sichmann Freitas".into()]),
                    copyright: Some("Copyright (c) 2026 Ivan Sichmann Freitas".into()),
                    license: Some("MIT".into()),
                    // macOS's native About panel shows `comments` near the top
                    // and `credits` in a smaller area below. We surface the
                    // OCCT acknowledgement here so the LGPL attribution is
                    // discoverable from inside the app.
                    comments: Some(
                        "STL/STEP viewer for Claude-assisted CAD design and 3D printing.".into(),
                    ),
                    credits: Some(
                        "STEP parsing uses Open CASCADE Technology (LGPL-2.1) via occt-import-js. \
                         See THIRD_PARTY_NOTICES.md in the application bundle for license details."
                            .into(),
                    ),
                    ..Default::default()
                }),
            )?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;

    let file_menu = Submenu::with_items(
        app,
        "File",
        true,
        &[
            &MenuItem::with_id(app, "open", "Open…", true, Some("CmdOrCtrl+O"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, None)?,
        ],
    )?;

    let edit_menu = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;

    let view_menu = Submenu::with_items(
        app,
        "View",
        true,
        &[
            &MenuItem::with_id(app, "reset_view", "Reset View", true, Some("CmdOrCtrl+0"))?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "toggle_grid", "Toggle Grid", true, Some("CmdOrCtrl+G"))?,
            &MenuItem::with_id(app, "toggle_axes", "Toggle Axes", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(
                app,
                "toggle_watch",
                "Auto-Reload File",
                true,
                Some("CmdOrCtrl+R"),
            )?,
        ],
    )?;

    let window_menu = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, None)?,
        ],
    )?;

    Menu::with_items(
        app,
        &[&app_menu, &file_menu, &edit_menu, &view_menu, &window_menu],
    )
}

pub fn run() {
    let cli = CliArgs::try_parse().unwrap_or_else(|e| e.exit());

    let settings = Settings::new(config::default_store());

    let initial = InitialArgs {
        file: cli.file.as_ref().map(|p| p.to_string_lossy().into_owned()),
        watch: resolve_watch(cli.watch, cli.no_watch, settings.watch_by_default()),
        up_axis: settings.up_axis(),
        background_color: settings.background_color(),
        grid_visible: settings.grid_visible(),
        axes_visible: settings.axes_visible(),
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(initial)
        .manage(WatcherState::default())
        .menu(build_menu)
        .on_menu_event(|app, event| {
            let id = event.id().as_ref();
            if matches!(
                id,
                "open" | "reset_view" | "toggle_grid" | "toggle_axes" | "toggle_watch"
            ) {
                let _ = app.emit(&format!("menu:{id}"), ());
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_initial_args,
            read_file_bytes,
            start_watch,
            stop_watch,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// Precedence: explicit CLI flag > stored config > built-in default (false).
/// `config_default` is supplied by `Settings::watch_by_default()`.
fn resolve_watch(watch_flag: bool, no_watch_flag: bool, config_default: bool) -> bool {
    if watch_flag {
        return true;
    }
    if no_watch_flag {
        return false;
    }
    config_default
}
