mod config;

use std::path::PathBuf;
use std::sync::Mutex;

use clap::Parser;
use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use tauri::menu::{AboutMetadata, CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Manager, Runtime};

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

    /// Verbose console logging of internal events (loader breadcrumbs, IPC, …)
    #[arg(long)]
    debug: bool,
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
    debug: bool,
}

#[derive(Default)]
struct WatcherState(Mutex<Option<RecommendedWatcher>>);

/// Buffer for file paths macOS delivers through Launch Services
/// (`RunEvent::Opened`) before the webview is wired up. The frontend drains
/// this when it asks for the initial args. Files that arrive after the
/// webview is ready are emitted as `file-open` events instead.
#[derive(Default)]
struct OpenedFiles(Mutex<Vec<PathBuf>>);

/// Handles to the menu-bar CheckMenuItems that mirror persistent settings.
/// We keep them in app state so menu clicks can push the toggled value back
/// to the item (defensive — macOS auto-toggles on click) and so the toggle
/// command handlers can read their post-click state.
struct CheckMenuItems<R: Runtime> {
    grid: CheckMenuItem<R>,
    axes: CheckMenuItem<R>,
    watch: CheckMenuItem<R>,
    /// Transient (not persisted): mirrors the in-window measure mode,
    /// which the frontend also toggles with the M key.
    measure: CheckMenuItem<R>,
}

#[tauri::command]
fn get_initial_args(
    state: tauri::State<'_, InitialArgs>,
    opened: tauri::State<'_, OpenedFiles>,
) -> InitialArgs {
    let mut args = state.inner().clone();
    // If the user double-clicked a .stl/.step/.3mf, the path was buffered by
    // the RunEvent::Opened handler before the webview was ready. Prefer it
    // over an absent CLI arg; if both are set, the CLI arg wins (it's the
    // more deliberate signal).
    if args.file.is_none() {
        if let Some(path) = opened.0.lock().unwrap().drain(..).next() {
            args.file = Some(path.to_string_lossy().into_owned());
        }
    }
    args
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

// --- Setting writers --------------------------------------------------------
//
// Each command persists to the user's KvStore (CFPreferences on macOS) so
// menu toggles and any future settings UI survive across launches. The
// frontend continues to drive scene state on its own — these commands are
// purely persistence + (for the menu-mirrored ones) check-state sync.

#[tauri::command]
fn set_grid_visible(
    settings: tauri::State<'_, Settings>,
    items: tauri::State<'_, CheckMenuItems<tauri::Wry>>,
    value: bool,
) -> Result<(), String> {
    settings.set_grid_visible(value).map_err(|e| e.to_string())?;
    items.grid.set_checked(value).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn set_axes_visible(
    settings: tauri::State<'_, Settings>,
    items: tauri::State<'_, CheckMenuItems<tauri::Wry>>,
    value: bool,
) -> Result<(), String> {
    settings.set_axes_visible(value).map_err(|e| e.to_string())?;
    items.axes.set_checked(value).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn set_watch_by_default(
    settings: tauri::State<'_, Settings>,
    items: tauri::State<'_, CheckMenuItems<tauri::Wry>>,
    value: bool,
) -> Result<(), String> {
    settings
        .set_watch_by_default(value)
        .map_err(|e| e.to_string())?;
    items.watch.set_checked(value).map_err(|e| e.to_string())?;
    Ok(())
}

/// Sync the menu checkmark when measure mode is toggled from the keyboard.
/// Unlike the toggles above this is session state, not a persisted setting.
#[tauri::command]
fn set_measure_mode(
    items: tauri::State<'_, CheckMenuItems<tauri::Wry>>,
    value: bool,
) -> Result<(), String> {
    items.measure.set_checked(value).map_err(|e| e.to_string())
}

#[tauri::command]
fn set_up_axis(settings: tauri::State<'_, Settings>, value: UpAxis) -> Result<(), String> {
    settings.set_up_axis(value).map_err(|e| e.to_string())
}

#[tauri::command]
fn set_background_color(
    settings: tauri::State<'_, Settings>,
    value: [f32; 3],
) -> Result<(), String> {
    settings.set_background_color(value).map_err(|e| e.to_string())
}

fn build_menu<R: Runtime>(
    app: &AppHandle<R>,
    initial_grid: bool,
    initial_axes: bool,
    initial_watch: bool,
) -> tauri::Result<(Menu<R>, CheckMenuItems<R>)> {
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

    let toggle_grid = CheckMenuItem::with_id(
        app,
        "toggle_grid",
        "Show Grid",
        true,
        initial_grid,
        Some("CmdOrCtrl+G"),
    )?;
    let toggle_axes = CheckMenuItem::with_id(
        app,
        "toggle_axes",
        "Show Axes",
        true,
        initial_axes,
        None::<&str>,
    )?;
    let toggle_watch = CheckMenuItem::with_id(
        app,
        "toggle_watch",
        "Auto-Reload File",
        true,
        initial_watch,
        Some("CmdOrCtrl+R"),
    )?;
    // The M keybind lives in the frontend (plain-letter menu accelerators
    // are unreliable on macOS); this item is the discoverable entry point.
    let toggle_measure = CheckMenuItem::with_id(
        app,
        "toggle_measure",
        "Measure Distance",
        true,
        false,
        None::<&str>,
    )?;

    let view_menu = Submenu::with_items(
        app,
        "View",
        true,
        &[
            &MenuItem::with_id(app, "reset_view", "Reset View", true, Some("CmdOrCtrl+0"))?,
            &PredefinedMenuItem::separator(app)?,
            &toggle_measure,
            &PredefinedMenuItem::separator(app)?,
            &toggle_grid,
            &toggle_axes,
            &PredefinedMenuItem::separator(app)?,
            &toggle_watch,
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

    let menu = Menu::with_items(
        app,
        &[&app_menu, &file_menu, &edit_menu, &view_menu, &window_menu],
    )?;

    Ok((
        menu,
        CheckMenuItems {
            grid: toggle_grid,
            axes: toggle_axes,
            watch: toggle_watch,
            measure: toggle_measure,
        },
    ))
}

pub fn run() {
    let cli = CliArgs::try_parse().unwrap_or_else(|e| e.exit());

    let settings = Settings::new(config::default_store());

    let initial_watch = resolve_watch(cli.watch, cli.no_watch, settings.watch_by_default());
    let initial_grid = settings.grid_visible();
    let initial_axes = settings.axes_visible();

    let initial = InitialArgs {
        file: cli.file.as_ref().map(|p| p.to_string_lossy().into_owned()),
        watch: initial_watch,
        up_axis: settings.up_axis(),
        background_color: settings.background_color(),
        grid_visible: initial_grid,
        axes_visible: initial_axes,
        debug: cli.debug,
    };

    let settings_for_state = settings.clone();
    let settings_for_menu_handler = settings.clone();

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(initial)
        .manage(WatcherState::default())
        .manage(OpenedFiles::default())
        .manage(settings_for_state)
        .setup(move |app| {
            let (menu, items) =
                build_menu(app.handle(), initial_grid, initial_axes, initial_watch)?;
            app.set_menu(menu)?;
            app.manage(items);
            Ok(())
        })
        .on_menu_event(move |app, event| {
            let id = event.id().as_ref();
            match id {
                "open" | "reset_view" => {
                    let _ = app.emit(&format!("menu:{id}"), ());
                }
                "toggle_grid" | "toggle_axes" | "toggle_watch" => {
                    // macOS auto-toggles CheckMenuItem on click before the
                    // event fires, so is_checked() reflects the new state.
                    let new_state = read_check(app, id);
                    if let Some(value) = new_state {
                        persist_toggle(&settings_for_menu_handler, id, value);
                        let _ = app.emit(&format!("menu:{id}"), value);
                    }
                }
                "toggle_measure" => {
                    // Session state only — forward to the frontend, no persist.
                    if let Some(value) = read_check(app, id) {
                        let _ = app.emit("menu:toggle_measure", value);
                    }
                }
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_initial_args,
            read_file_bytes,
            start_watch,
            stop_watch,
            set_grid_visible,
            set_axes_visible,
            set_watch_by_default,
            set_measure_mode,
            set_up_axis,
            set_background_color,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        // RunEvent::Opened delivers files macOS sends via Launch Services —
        // double-clicks, `open file.stl`, the recent-items list, etc.
        // Always emit `file-open` so a live frontend reloads immediately;
        // also stash in OpenedFiles so a cold-start frontend can pick it
        // up through get_initial_args before its listeners are armed.
        if let tauri::RunEvent::Opened { urls } = event {
            let opened = app_handle.state::<OpenedFiles>();
            for url in urls {
                if let Ok(path) = url.to_file_path() {
                    opened.0.lock().unwrap().push(path.clone());
                    let _ = app_handle.emit("file-open", path.to_string_lossy().to_string());
                }
            }
        }
    });
}

fn read_check<R: Runtime>(app: &AppHandle<R>, id: &str) -> Option<bool> {
    let items = app.try_state::<CheckMenuItems<R>>()?;
    let item = match id {
        "toggle_grid" => &items.grid,
        "toggle_axes" => &items.axes,
        "toggle_watch" => &items.watch,
        "toggle_measure" => &items.measure,
        _ => return None,
    };
    item.is_checked().ok()
}

fn persist_toggle(settings: &Settings, id: &str, value: bool) {
    let result = match id {
        "toggle_grid" => settings.set_grid_visible(value),
        "toggle_axes" => settings.set_axes_visible(value),
        "toggle_watch" => settings.set_watch_by_default(value),
        _ => return,
    };
    if let Err(err) = result {
        // Persistence failure shouldn't kill the toggle — log and move on.
        eprintln!("[stlviewer] failed to persist {id}={value}: {err}");
    }
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
