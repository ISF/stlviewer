// Setters are part of the public API and exercised by the test module
// below; production code paths currently only read. Silence dead-code at
// the module level until a write-from-frontend feature lands.
#![allow(dead_code)]

//! Persistent application configuration.
//!
//! Two layers:
//!
//! * [`KvStore`] — a small, key-oriented trait that each platform implements.
//!   On macOS it talks to CFPreferences; on other platforms today it falls
//!   back to an in-memory store. Adding XDG / Windows Registry impls later
//!   slots in here without touching the rest of the app.
//! * [`Settings`] — a concrete struct sitting on top of any `KvStore`. Its
//!   methods are field-named (`watch_by_default()`, `up_axis()`, …) and
//!   typed; defaults, parsing, and validation live here in one place.
//!
//! Adding a new setting = add two methods to `Settings`. No backend changes.
//!
//! See `THIRD_PARTY_NOTICES.md` for licensing of the supporting crates.

use std::fmt;
use std::sync::Arc;

#[cfg(target_os = "macos")]
pub mod macos;
pub mod memory;

/// Bundle identifier — also the macOS preferences domain.
pub const APP_DOMAIN: &str = "com.ivansich.stlviewer";

/// Errors a `KvStore` mutation can surface. Reads return `Option<T>`, so a
/// missing key is not an error.
#[derive(Debug)]
pub struct ConfigError(String);

impl ConfigError {
    pub fn new(msg: impl Into<String>) -> Self {
        Self(msg.into())
    }
}

impl fmt::Display for ConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for ConfigError {}

pub type Result<T = ()> = std::result::Result<T, ConfigError>;

/// Low-level key-value backend. Implementations are platform-specific.
///
/// Reads return `None` when the key is absent so the schema layer can apply
/// its own default. Writes go through the platform's native mechanism so
/// out-of-process tools (`defaults`, `regedit`, a text editor on a TOML
/// file) keep working.
pub trait KvStore: Send + Sync {
    fn get_bool(&self, key: &str) -> Option<bool>;
    fn set_bool(&self, key: &str, value: bool) -> Result;

    fn get_string(&self, key: &str) -> Option<String>;
    fn set_string(&self, key: &str, value: &str) -> Result;

    fn unset(&self, key: &str) -> Result;
}

/// Construct the platform-native KvStore.
pub fn default_store() -> Arc<dyn KvStore> {
    #[cfg(target_os = "macos")]
    {
        Arc::new(macos::CfPreferencesStore::new(APP_DOMAIN))
    }
    #[cfg(not(target_os = "macos"))]
    {
        Arc::new(memory::InMemoryStore::new())
    }
}

// ---------------------------------------------------------------------------
// Schema: typed accessors over the KvStore. One concrete impl today; if we
// ever grow a second meaningfully-different schema (snapshot, overlay, …),
// promote this to a trait and call sites won't need to change.
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum UpAxis {
    Z,
    Y,
}

impl UpAxis {
    fn parse(s: &str) -> Option<Self> {
        match s.trim().to_ascii_lowercase().as_str() {
            "z" => Some(Self::Z),
            "y" => Some(Self::Y),
            _ => None,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Z => "z",
            Self::Y => "y",
        }
    }
}

/// Default background — kept in sync with the original frontend constant.
const DEFAULT_BG: [u8; 3] = [0x18, 0x1c, 0x22];

/// Field-named accessor over a `KvStore`. Cheap to clone — the underlying
/// store is `Arc`-shared so multiple holders see the same writes.
#[derive(Clone)]
pub struct Settings {
    store: Arc<dyn KvStore>,
}

impl Settings {
    pub fn new(store: Arc<dyn KvStore>) -> Self {
        Self { store }
    }

    /// Test/utility constructor that wraps an in-memory store.
    #[allow(dead_code)]
    pub fn in_memory() -> Self {
        Self::new(Arc::new(memory::InMemoryStore::new()))
    }

    pub fn watch_by_default(&self) -> bool {
        self.store.get_bool("watch_by_default").unwrap_or(false)
    }

    pub fn set_watch_by_default(&self, v: bool) -> Result {
        self.store.set_bool("watch_by_default", v)
    }

    pub fn up_axis(&self) -> UpAxis {
        self.store
            .get_string("up_axis")
            .as_deref()
            .and_then(UpAxis::parse)
            .unwrap_or(UpAxis::Z)
    }

    pub fn set_up_axis(&self, v: UpAxis) -> Result {
        self.store.set_string("up_axis", v.as_str())
    }

    /// Background color as linear-RGB floats in [0, 1].
    pub fn background_color(&self) -> [f32; 3] {
        self.store
            .get_string("background_color")
            .as_deref()
            .and_then(parse_hex_color)
            .unwrap_or_else(|| u8_rgb_to_f32(DEFAULT_BG))
    }

    pub fn set_background_color(&self, v: [f32; 3]) -> Result {
        self.store.set_string("background_color", &format_hex_color(v))
    }

    pub fn grid_visible(&self) -> bool {
        self.store.get_bool("grid_visible").unwrap_or(true)
    }

    pub fn set_grid_visible(&self, v: bool) -> Result {
        self.store.set_bool("grid_visible", v)
    }

    pub fn axes_visible(&self) -> bool {
        self.store.get_bool("axes_visible").unwrap_or(true)
    }

    pub fn set_axes_visible(&self, v: bool) -> Result {
        self.store.set_bool("axes_visible", v)
    }
}

fn u8_rgb_to_f32([r, g, b]: [u8; 3]) -> [f32; 3] {
    [r as f32 / 255.0, g as f32 / 255.0, b as f32 / 255.0]
}

fn parse_hex_color(s: &str) -> Option<[f32; 3]> {
    let s = s.trim().trim_start_matches('#');
    if s.len() != 6 {
        return None;
    }
    let r = u8::from_str_radix(&s[0..2], 16).ok()?;
    let g = u8::from_str_radix(&s[2..4], 16).ok()?;
    let b = u8::from_str_radix(&s[4..6], 16).ok()?;
    Some(u8_rgb_to_f32([r, g, b]))
}

fn format_hex_color(rgb: [f32; 3]) -> String {
    let to_u8 = |c: f32| (c.clamp(0.0, 1.0) * 255.0).round() as u8;
    format!("#{:02x}{:02x}{:02x}", to_u8(rgb[0]), to_u8(rgb[1]), to_u8(rgb[2]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_apply_when_keys_absent() {
        let s = Settings::in_memory();
        assert_eq!(s.watch_by_default(), false);
        assert_eq!(s.up_axis(), UpAxis::Z);
        assert_eq!(s.grid_visible(), true);
        assert_eq!(s.axes_visible(), true);
        assert_eq!(s.background_color(), u8_rgb_to_f32(DEFAULT_BG));
    }

    #[test]
    fn roundtrip_each_field() {
        let s = Settings::in_memory();

        s.set_watch_by_default(true).unwrap();
        assert!(s.watch_by_default());

        s.set_up_axis(UpAxis::Y).unwrap();
        assert_eq!(s.up_axis(), UpAxis::Y);

        s.set_grid_visible(false).unwrap();
        assert!(!s.grid_visible());

        s.set_axes_visible(false).unwrap();
        assert!(!s.axes_visible());

        s.set_background_color([0.1, 0.2, 0.3]).unwrap();
        let bg = s.background_color();
        // Allow a hex-rounding epsilon (1/255 ≈ 0.004).
        for (got, want) in bg.iter().zip([0.1, 0.2, 0.3]) {
            assert!((got - want).abs() < 0.01, "got {:?} want {:?}", bg, [0.1, 0.2, 0.3]);
        }
    }

    #[test]
    fn malformed_hex_falls_back_to_default() {
        let s = Settings::in_memory();
        s.store.set_string("background_color", "not a color").unwrap();
        assert_eq!(s.background_color(), u8_rgb_to_f32(DEFAULT_BG));
    }
}
