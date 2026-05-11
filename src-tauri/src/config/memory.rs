//! Process-local in-memory `KvStore`. Used by tests and as the fallback
//! backend on non-macOS targets until XDG / Windows Registry impls land.

use std::collections::HashMap;
use std::sync::Mutex;

use super::{KvStore, Result};

#[derive(Debug, Clone)]
enum Value {
    Bool(bool),
    String(String),
}

#[derive(Default)]
pub struct InMemoryStore {
    inner: Mutex<HashMap<String, Value>>,
}

impl InMemoryStore {
    pub fn new() -> Self {
        Self::default()
    }
}

impl KvStore for InMemoryStore {
    fn get_bool(&self, key: &str) -> Option<bool> {
        match self.inner.lock().unwrap().get(key)? {
            Value::Bool(b) => Some(*b),
            _ => None,
        }
    }

    fn set_bool(&self, key: &str, value: bool) -> Result {
        self.inner.lock().unwrap().insert(key.to_owned(), Value::Bool(value));
        Ok(())
    }

    fn get_string(&self, key: &str) -> Option<String> {
        match self.inner.lock().unwrap().get(key)? {
            Value::String(s) => Some(s.clone()),
            _ => None,
        }
    }

    fn set_string(&self, key: &str, value: &str) -> Result {
        self.inner
            .lock()
            .unwrap()
            .insert(key.to_owned(), Value::String(value.to_owned()));
        Ok(())
    }

    fn unset(&self, key: &str) -> Result {
        self.inner.lock().unwrap().remove(key);
        Ok(())
    }
}
