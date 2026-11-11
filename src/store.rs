//! The viewer's cache: small values kept as files in the plugin's own
//! directory.
//!
//! API 1.3 gives every plugin a private persistent directory
//! ([`host::fs::plugin_dir`]) that no capability gates and that is removed on
//! uninstall. That is where the bytes the page is handed go: a scanned PDF is
//! far too large for the 64 MiB key-value store, and a whole one is far too
//! large for a single value there. Files keep it bounded by the disk instead.
//!
//! The store is a plain key–value map. A key becomes a file in that directory,
//! with `/` escaped (`pdfviewer/index` → `pdfviewer%2Findex`): API 1.3's `fs`
//! has `read-dir`, `stat` and `write-bytes`, but no `create-dir` and no
//! `remove`, so entries are flat, and a deleted key is truncated to zero bytes
//! — the space comes back at once, the empty name stays behind, and [`get`]
//! reads an empty file as "no value".
//!
//! Keys are validated by [`crate::protocol`] before they get here: letters,
//! digits, `.`, `_`, `-` in `/`-separated segments, so a key is always a safe
//! file name once `/` is escaped.

use openidea_plugin::Error;
use openidea_plugin::FileKind;
use openidea_plugin::host;

/// How a `/` in a key is spelled in a file name. A key never contains `%`.
const SLASH: &str = "%2F";

/// The file a key lives in, inside the plugin's directory.
fn path(key: &str) -> Result<String, Error> {
    let dir = host::fs::plugin_dir()?;
    Ok(format!(
        "{}/{}",
        dir.trim_end_matches('/'),
        key.replace('/', SLASH)
    ))
}

/// The key a file name spells, or `None` for a file that is not one of ours.
fn decode(name: &str) -> Option<String> {
    let mut key = String::with_capacity(name.len());
    let mut rest = name;
    while let Some(at) = rest.find('%') {
        key.push_str(&rest[..at]);
        rest = rest[at..].strip_prefix(SLASH)?;
        key.push('/');
    }
    key.push_str(rest);
    Some(key)
}

/// The value of `key`, `None` when it was never stored or has been deleted.
pub fn get(key: &str) -> Result<Option<String>, Error> {
    match host::fs::read_bytes(&path(key)?) {
        // A deleted key is an empty file (see the module comment).
        Ok(bytes) if bytes.is_empty() => Ok(None),
        Ok(bytes) => String::from_utf8(bytes)
            .map(Some)
            .map_err(|_| Error::Invalid(format!("{key}: the stored value is not UTF-8"))),
        Err(Error::NotFound(_)) => Ok(None),
        Err(e) => Err(e),
    }
}

/// Stores `value` under `key`, replacing what was there.
pub fn set(key: &str, value: &str) -> Result<(), Error> {
    host::fs::write_bytes(&path(key)?, value.as_bytes())
}

/// Forgets `key`; `fs` has no `remove`, so the file is emptied instead.
pub fn delete(key: &str) -> Result<(), Error> {
    host::fs::write_bytes(&path(key)?, b"")
}

/// The keys starting with `prefix`, sorted. Deleted keys are left out.
pub fn keys(prefix: &str) -> Result<Vec<String>, Error> {
    let dir = host::fs::plugin_dir()?;
    let dir = dir.trim_end_matches('/');
    let mut found = Vec::new();
    for entry in host::fs::read_dir(dir)? {
        if entry.kind != FileKind::File {
            continue;
        }
        let Some(key) = decode(&entry.name) else {
            continue;
        };
        if !key.starts_with(prefix) {
            continue;
        }
        // The file a deleted key leaves behind is empty; skip those.
        let size = host::fs::stat(&format!("{dir}/{}", entry.name)).map_or(0, |stat| stat.size);
        if size > 0 {
            found.push(key);
        }
    }
    found.sort();
    Ok(found)
}
