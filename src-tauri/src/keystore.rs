//! API keys live in the OS credential store (Windows Credential Manager, macOS Keychain,
//! Secret Service on Linux). If no credential store is reachable (headless Linux), keys fall
//! back to a user-only file in the app data dir so the app still works.

use nook_core::ai::KeyStore;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

const SERVICE: &str = "com.realhackers.nook";

pub struct OsKeyStore {
    fallback: PathBuf,
    cache: Mutex<HashMap<String, Option<String>>>,
}

impl OsKeyStore {
    pub fn new(data_dir: PathBuf) -> Self {
        OsKeyStore { fallback: data_dir.join("keys.fallback.json"), cache: Mutex::new(HashMap::new()) }
    }

    fn entry(provider: &str) -> Option<keyring::Entry> {
        keyring::Entry::new(SERVICE, &format!("ai-key:{provider}")).ok()
    }

    fn read_fallback(&self) -> HashMap<String, String> {
        std::fs::read_to_string(&self.fallback).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
    }

    fn write_fallback(&self, map: &HashMap<String, String>) -> Result<(), String> {
        let s = serde_json::to_string(map).map_err(|e| e.to_string())?;
        std::fs::write(&self.fallback, s).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&self.fallback, std::fs::Permissions::from_mode(0o600));
        }
        Ok(())
    }
}

impl KeyStore for OsKeyStore {
    fn get(&self, provider: &str) -> Option<String> {
        if let Some(hit) = self.cache.lock().ok().and_then(|c| c.get(provider).cloned()) {
            return hit;
        }
        let v = Self::entry(provider)
            .and_then(|e| e.get_password().ok())
            .filter(|k| !k.is_empty())
            .or_else(|| self.read_fallback().get(provider).cloned());
        if let Ok(mut c) = self.cache.lock() {
            c.insert(provider.to_string(), v.clone());
        }
        v
    }

    fn set(&self, provider: &str, key: Option<&str>) -> Result<(), String> {
        if let Ok(mut c) = self.cache.lock() {
            c.remove(provider);
        }
        let mut fb = self.read_fallback();
        match key.filter(|k| !k.is_empty()) {
            Some(k) => {
                let stored = Self::entry(provider).map(|e| e.set_password(k).is_ok()).unwrap_or(false);
                if stored {
                    if fb.remove(provider).is_some() {
                        self.write_fallback(&fb)?;
                    }
                } else {
                    log::warn!("OS keyring unavailable — storing the {provider} key in the app data dir");
                    fb.insert(provider.to_string(), k.to_string());
                    self.write_fallback(&fb)?;
                }
            }
            None => {
                if let Some(e) = Self::entry(provider) {
                    let _ = e.delete_credential();
                }
                if fb.remove(provider).is_some() {
                    self.write_fallback(&fb)?;
                }
            }
        }
        Ok(())
    }
}
