//! CFPreferences-backed `KvStore`.
//!
//! Talks directly to Core Foundation's preferences API so writes go through
//! the same `cfprefsd` daemon that `defaults(1)` uses. The practical effect:
//!
//! ```sh
//! defaults write com.ivansich.stlviewer watch_by_default -bool true
//! defaults read  com.ivansich.stlviewer
//! ```
//!
//! interoperate cleanly with the app — both directions.

use core_foundation::base::{CFType, TCFType};
use core_foundation::boolean::CFBoolean;
use core_foundation::string::CFString;
use core_foundation_sys::preferences::{
    CFPreferencesAppSynchronize, CFPreferencesCopyAppValue, CFPreferencesSetAppValue,
};
use core_foundation_sys::propertylist::CFPropertyListRef;

use super::{ConfigError, KvStore, Result};

pub struct CfPreferencesStore {
    /// Bundle / preferences-domain identifier. Stored as a plain `String` —
    /// CFString isn't `Send + Sync`, and rebuilding it per call is cheap
    /// next to the IPC round-trip to `cfprefsd`.
    app_id: String,
}

impl CfPreferencesStore {
    pub fn new(app_id: &str) -> Self {
        Self {
            app_id: app_id.to_owned(),
        }
    }

    fn cf_app_id(&self) -> CFString {
        CFString::new(&self.app_id)
    }

    /// Returns `Some(CFType)` when the key resolves to a value, `None` when
    /// the key is absent. Ownership: the returned `CFType` follows the
    /// create-rule (CFPreferencesCopyAppValue gives us a +1 reference).
    fn copy_value(&self, key: &str) -> Option<CFType> {
        let cf_key = CFString::new(key);
        let cf_app = self.cf_app_id();
        unsafe {
            let raw = CFPreferencesCopyAppValue(
                cf_key.as_concrete_TypeRef(),
                cf_app.as_concrete_TypeRef(),
            );
            if raw.is_null() {
                None
            } else {
                Some(CFType::wrap_under_create_rule(raw as _))
            }
        }
    }

    fn set_typed<T: TCFType>(&self, key: &str, value: &T) -> Result {
        let cf_key = CFString::new(key);
        let cf_app = self.cf_app_id();
        unsafe {
            CFPreferencesSetAppValue(
                cf_key.as_concrete_TypeRef(),
                value.as_CFTypeRef() as CFPropertyListRef,
                cf_app.as_concrete_TypeRef(),
            );
            if CFPreferencesAppSynchronize(cf_app.as_concrete_TypeRef()) == 0 {
                return Err(ConfigError::new(format!(
                    "CFPreferencesAppSynchronize failed (set {key})"
                )));
            }
        }
        Ok(())
    }

    fn delete(&self, key: &str) -> Result {
        let cf_key = CFString::new(key);
        let cf_app = self.cf_app_id();
        unsafe {
            // Passing a null value removes the key from the application domain.
            CFPreferencesSetAppValue(
                cf_key.as_concrete_TypeRef(),
                std::ptr::null(),
                cf_app.as_concrete_TypeRef(),
            );
            if CFPreferencesAppSynchronize(cf_app.as_concrete_TypeRef()) == 0 {
                return Err(ConfigError::new(format!(
                    "CFPreferencesAppSynchronize failed (unset {key})"
                )));
            }
        }
        Ok(())
    }
}

impl KvStore for CfPreferencesStore {
    fn get_bool(&self, key: &str) -> Option<bool> {
        let value = self.copy_value(key)?;
        let boolean: CFBoolean = value.downcast()?;
        Some(boolean.into())
    }

    fn set_bool(&self, key: &str, value: bool) -> Result {
        let cf = if value {
            CFBoolean::true_value()
        } else {
            CFBoolean::false_value()
        };
        self.set_typed(key, &cf)
    }

    fn get_string(&self, key: &str) -> Option<String> {
        let value = self.copy_value(key)?;
        let cfs: CFString = value.downcast()?;
        Some(cfs.to_string())
    }

    fn set_string(&self, key: &str, value: &str) -> Result {
        let cf = CFString::new(value);
        self.set_typed(key, &cf)
    }

    fn unset(&self, key: &str) -> Result {
        self.delete(key)
    }
}
