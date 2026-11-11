//! The messages the viewer's page and the plugin's code exchange.
//!
//! A web view talks to its plugin's code in text (`openidea.postMessage` /
//! `views.post-message`), and it is sandboxed: no storage of its own, no file
//! system. API 1.5 gives a custom-editor page `document.bytes()` directly; the
//! code-side fallback reads only the current editor's file through the
//! project-scoped `project.read-bytes` API, and cached/user-picked files go in
//! the plugin's own private directory (`src/store.rs`).
//!
//! Requests, all with the page's own `id`:
//!
//! ```text
//! page → code   {"op":"info","id":"0"}
//! code → page   {"op":"info","id":"0","path":"/…/paper.pdf"|null}
//! page → code   {"op":"read","id":"9"}
//! code → page   {"op":"bytes","id":"9","part":0,"parts":3,"data":"JVBERi0x…"}
//! code → page   {"op":"none","id":"9","reason":"…"}
//! page → code   {"op":"get","id":"1","key":"pdfviewer/cache/…"}
//! code → page   {"op":"value","id":"1","key":"…","value":"…"|null}
//! page → code   {"op":"set","id":"2","key":"…","value":"…"}
//! page → code   {"op":"ok","id":"2","key":"…"}
//! page → code   {"op":"del","id":"3","key":"…"}
//! page → code   {"op":"keys","id":"4","prefix":"pdfviewer/"}
//! code → page   {"op":"keys","id":"4","prefix":"…","keys":["…"]}
//! page → code   {"op":"ping","id":"5"}
//! code → page   {"op":"pong","id":"5"}
//! ```
//!
//! `info` is the API 1.3 `invocation.editor().path()`: the absolute path of
//! the tab's file, which the page uses as the cache's identity (two PDFs of
//! the same name in different folders are different files) and `null` when
//! the view has no file behind it.
//!
//! `read` asks the code to read that file *in place* — the page never names a
//! path, so it cannot ask for another file. API 1.5's `project.read-bytes`
//! confines the read to the open project and requires `project.read`; the file
//! is sent in [`PART`]-byte parts, with the API's 16 MiB cap. The page's direct
//! `document.bytes()` path is preferred and supports up to 64 MiB.
//!
//! A failed call answers `{"op":"error","id":…,"message":"…"}` — a key with a
//! forbidden character, a value over the limit, a full disk. Every frame of
//! the view receives every message (`views.post-message` reaches all of them),
//! so `id` is what tells the tabs apart.

use serde_json::{Map, Value};

/// Longest key the page may use. A key becomes a file name in the plugin's
/// directory (`/` escaped), so the limit keeps it well under a file system's.
pub const MAX_KEY: usize = 120;
/// Longest prefix `keys` accepts.
pub const MAX_PREFIX: usize = 96;
/// Longest value in one `set` (bytes of UTF-8): the page keeps a PDF in
/// chunks of its own, well under this.
pub const MAX_VALUE: usize = 4 << 20;
/// Longest request id.
const MAX_ID: usize = 64;
/// `project.read-bytes` limit in API 1.5 (also applies to `fs.read-bytes`).
pub const MAX_READ: u64 = 16 << 20;
/// Bytes of the file in one `bytes` message: base64 grows a part by a third,
/// and a message between the code and a view is capped at 8 MiB.
pub const PART: usize = 3 << 20;

/// What the page asks for.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Request {
    /// The tab's absolute path and file name, as the IDE reports them.
    Info {
        id: String,
    },
    /// Read the tab's own project file (needs `project.read`).
    Read {
        id: String,
    },
    Get {
        id: String,
        key: String,
    },
    Set {
        id: String,
        key: String,
        value: String,
    },
    Delete {
        id: String,
        key: String,
    },
    Keys {
        id: String,
        prefix: String,
    },
    Ping {
        id: String,
    },
}

/// Reads a page message. Anything that is not this protocol (another plugin's
/// page, a future version's message) is `None` and ignored.
///
/// A request that breaks a limit is answered instead — `Err((id, message))` —
/// so a page that got its arithmetic wrong is told, rather than hanging.
pub fn parse(text: &str) -> Option<Result<Request, (String, String)>> {
    let value: Value = serde_json::from_str(text).ok()?;
    let object = value.as_object()?;
    let raw_id = object.get("id")?.as_str()?;
    if raw_id.is_empty() || raw_id.len() > MAX_ID {
        return None;
    }
    let id = raw_id.to_owned();
    let raw_key = || object.get("key")?.as_str().map(check_key);
    let request = match object.get("op")?.as_str()? {
        "info" => Request::Info { id },
        "read" => Request::Read { id },
        "get" => {
            let key = match raw_key() {
                None => return None,
                Some(Err(e)) => return Some(Err((id, e))),
                Some(Ok(key)) => key,
            };
            Request::Get { id, key }
        }
        "set" => {
            let key = match raw_key() {
                None => return None,
                Some(Err(e)) => return Some(Err((id, e))),
                Some(Ok(key)) => key,
            };
            let Some(value) = object.get("value").and_then(Value::as_str) else {
                return None;
            };
            if value.len() > MAX_VALUE {
                let message = format!(
                    "value of {} bytes is over the {} MiB limit",
                    value.len(),
                    MAX_VALUE >> 20
                );
                return Some(Err((id, message)));
            }
            Request::Set {
                id,
                key,
                value: value.to_owned(),
            }
        }
        "del" => {
            let key = match raw_key() {
                None => return None,
                Some(Err(e)) => return Some(Err((id, e))),
                Some(Ok(key)) => key,
            };
            Request::Delete { id, key }
        }
        "keys" => {
            let prefix = object.get("prefix").and_then(Value::as_str).unwrap_or("");
            if prefix.len() > MAX_PREFIX {
                return Some(Err((
                    id,
                    format!("prefix is longer than {MAX_PREFIX} bytes"),
                )));
            }
            Request::Keys {
                id,
                prefix: prefix.to_owned(),
            }
        }
        "ping" => Request::Ping { id },
        _ => return None,
    };
    Some(Ok(request))
}

/// A key the plugin is willing to store under: `/`-separated segments of
/// letters, digits, `.`, `_` and `-` — a safe file name once `/` is escaped,
/// and never `.` or `..`.
fn check_key(key: &str) -> Result<String, String> {
    if key.is_empty() {
        return Err("key is empty".into());
    }
    if key.len() > MAX_KEY {
        return Err(format!("key is longer than {MAX_KEY} bytes"));
    }
    for segment in key.split('/') {
        if segment.is_empty() || segment == "." || segment == ".." {
            return Err("key has an empty or relative segment".into());
        }
        if !segment
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
        {
            return Err(
                "key has a character that is not a letter, a digit, '.', '_' or '-'".into(),
            );
        }
    }
    Ok(key.to_owned())
}

/// The tab's file path (`null` when the view has none) and its name.
pub fn info(id: &str, path: Option<&str>) -> String {
    let mut object = Map::new();
    object.insert("op".into(), "info".into());
    object.insert("id".into(), id.into());
    object.insert(
        "path".into(),
        path.map_or(Value::Null, |p| Value::String(p.to_owned())),
    );
    Value::Object(object).to_string()
}

/// One part of the tab's file, `data` base64 (the bridge carries text).
pub fn bytes(id: &str, part: usize, parts: usize, data: &str) -> String {
    let mut object = Map::new();
    object.insert("op".into(), "bytes".into());
    object.insert("id".into(), id.into());
    object.insert("part".into(), Value::from(part));
    object.insert("parts".into(), Value::from(parts));
    object.insert("data".into(), data.into());
    Value::Object(object).to_string()
}

/// The tab's file could not be read in place; the page asks the user.
pub fn none(id: &str, reason: &str) -> String {
    let mut object = Map::new();
    object.insert("op".into(), "none".into());
    object.insert("id".into(), id.into());
    object.insert("reason".into(), reason.into());
    Value::Object(object).to_string()
}

/// The stored value of `key`, `null` when there is none.
pub fn value(id: &str, key: &str, value: Option<&str>) -> String {
    let mut object = Map::new();
    object.insert("op".into(), "value".into());
    object.insert("id".into(), id.into());
    object.insert("key".into(), key.into());
    object.insert(
        "value".into(),
        match value {
            Some(v) => Value::String(v.to_owned()),
            None => Value::Null,
        },
    );
    Value::Object(object).to_string()
}

/// A `set` or `del` that went through.
pub fn ok(id: &str, key: &str) -> String {
    let mut object = Map::new();
    object.insert("op".into(), "ok".into());
    object.insert("id".into(), id.into());
    object.insert("key".into(), key.into());
    Value::Object(object).to_string()
}

pub fn keys(id: &str, prefix: &str, keys: &[String]) -> String {
    let mut object = Map::new();
    object.insert("op".into(), "keys".into());
    object.insert("id".into(), id.into());
    object.insert("prefix".into(), prefix.into());
    object.insert(
        "keys".into(),
        Value::Array(keys.iter().map(|k| Value::String(k.clone())).collect()),
    );
    Value::Object(object).to_string()
}

pub fn pong(id: &str) -> String {
    let mut object = Map::new();
    object.insert("op".into(), "pong".into());
    object.insert("id".into(), id.into());
    Value::Object(object).to_string()
}

pub fn error(id: &str, message: &str) -> String {
    let mut object = Map::new();
    object.insert("op".into(), "error".into());
    object.insert("id".into(), id.into());
    object.insert("message".into(), message.into());
    Value::Object(object).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse_ok(text: &str) -> Request {
        parse(text).expect("a request").expect("within the limits")
    }

    fn parse_err(text: &str) -> (String, String) {
        parse(text).expect("a request").err().expect("over a limit")
    }

    #[test]
    fn reads_every_request() {
        assert_eq!(
            parse_ok(r#"{"op":"info","id":"0"}"#),
            Request::Info { id: "0".into() }
        );
        assert_eq!(
            parse_ok(r#"{"op":"read","id":"9"}"#),
            Request::Read { id: "9".into() }
        );
        assert_eq!(
            parse_ok(r#"{"op":"get","id":"1","key":"pdfviewer/a"}"#),
            Request::Get {
                id: "1".into(),
                key: "pdfviewer/a".into()
            }
        );
        assert_eq!(
            parse_ok(r#"{"op":"set","id":"2","key":"k","value":"v"}"#),
            Request::Set {
                id: "2".into(),
                key: "k".into(),
                value: "v".into()
            }
        );
        assert_eq!(
            parse_ok(r#"{"op":"del","id":"3","key":"k"}"#),
            Request::Delete {
                id: "3".into(),
                key: "k".into()
            }
        );
        assert_eq!(
            parse_ok(r#"{"op":"keys","id":"4","prefix":"pdfviewer/"}"#),
            Request::Keys {
                id: "4".into(),
                prefix: "pdfviewer/".into()
            }
        );
        assert_eq!(
            parse_ok(r#"{"op":"ping","id":"5"}"#),
            Request::Ping { id: "5".into() }
        );
        // A missing prefix lists everything.
        assert_eq!(
            parse_ok(r#"{"op":"keys","id":"6"}"#),
            Request::Keys {
                id: "6".into(),
                prefix: String::new()
            }
        );
    }

    #[test]
    fn ignores_messages_that_are_not_this_protocol() {
        for text in [
            "",
            "hello",
            "[]",
            "null",
            r#"{"op":"get"}"#,
            r#"{"op":"get","id":"1"}"#,
            r#"{"op":"get","id":1,"key":"k"}"#,
            r#"{"op":"nope","id":"1"}"#,
            r#"{"op":"get","id":"","key":"k"}"#,
        ] {
            assert_eq!(parse(text), None, "{text:?}");
        }
        let long_id = format!(r#"{{"op":"ping","id":"{}"}}"#, "x".repeat(MAX_ID + 1));
        assert_eq!(parse(&long_id), None);
    }

    #[test]
    fn answers_over_the_limits_with_a_message() {
        let bad_key = format!(
            r#"{{"op":"get","id":"1","key":"{}"}}"#,
            "k".repeat(MAX_KEY + 1)
        );
        assert!(parse_err(&bad_key).1.contains("key"));
        assert_eq!(
            parse_err(r#"{"op":"get","id":"1","key":""}"#).0,
            "1",
            "the page still learns which request failed"
        );
        assert!(
            parse_err(r#"{"op":"get","id":"1","key":""}"#)
                .1
                .contains("empty")
        );
        for bad in [
            "a\nb",
            "a b",
            "../x",
            "a//b",
            "a/./b",
            "a%b",
            "caf\u{e9}",
            "/abs",
        ] {
            let text = serde_json::json!({ "op": "get", "id": "1", "key": bad }).to_string();
            let (_, message) = parse_err(&text);
            assert!(
                message.contains("character") || message.contains("segment"),
                "{bad:?}: {message}"
            );
        }
        let big = format!(
            r#"{{"op":"set","id":"1","key":"k","value":"{}"}}"#,
            "v".repeat(MAX_VALUE + 1)
        );
        assert!(parse_err(&big).1.contains("limit"));
        let long_prefix = format!(
            r#"{{"op":"keys","id":"1","prefix":"{}"}}"#,
            "p".repeat(MAX_PREFIX + 1)
        );
        assert!(parse_err(&long_prefix).1.contains("prefix"));
    }

    #[test]
    fn answers_are_json_the_page_can_read() {
        let value_msg: Value = serde_json::from_str(&value("1", "k", Some("v"))).unwrap();
        assert_eq!(
            (&value_msg["op"], &value_msg["value"]),
            (&Value::from("value"), &Value::from("v"))
        );
        let empty: Value = serde_json::from_str(&value("1", "k", None)).unwrap();
        assert!(empty["value"].is_null());
        let keys_msg: Value =
            serde_json::from_str(&keys("2", "p/", &["p/a".to_owned(), "p/b".to_owned()])).unwrap();
        assert_eq!(keys_msg["keys"], serde_json::json!(["p/a", "p/b"]));
        let ok_msg: Value = serde_json::from_str(&ok("3", "k")).unwrap();
        assert_eq!(
            (&ok_msg["op"], &ok_msg["key"]),
            (&Value::from("ok"), &Value::from("k"))
        );
        assert_eq!(
            serde_json::from_str::<Value>(&pong("4")).unwrap()["op"],
            "pong"
        );
        let error: Value = serde_json::from_str(&error("5", "denied: storage")).unwrap();
        assert_eq!(error["message"], "denied: storage");
        let part: Value = serde_json::from_str(&bytes("8", 1, 3, "JVBE")).unwrap();
        assert_eq!(
            (&part["op"], &part["part"], &part["parts"]),
            (&Value::from("bytes"), &Value::from(1), &Value::from(3))
        );
        assert_eq!(part["data"], "JVBE");
        let none_msg: Value = serde_json::from_str(&none("9", "denied: project.read")).unwrap();
        assert_eq!(
            (&none_msg["op"], &none_msg["reason"]),
            (&Value::from("none"), &Value::from("denied: project.read"))
        );
        let info_msg: Value = serde_json::from_str(&info("6", Some("/tmp/a.pdf"))).unwrap();
        assert_eq!(
            (&info_msg["op"], &info_msg["path"]),
            (&Value::from("info"), &Value::from("/tmp/a.pdf"))
        );
        assert!(serde_json::from_str::<Value>(&info("7", None)).unwrap()["path"].is_null());
    }

    #[test]
    fn values_with_quotes_and_newlines_survive() {
        let text = r#"{"op":"set","id":"1","key":"k","value":"a\"b\nc\\d"}"#;
        let Request::Set { value: stored, .. } = parse_ok(text) else {
            panic!("a set")
        };
        assert_eq!(stored, "a\"b\nc\\d");
        let round = value("1", "k", Some(&stored));
        let parsed: Value = serde_json::from_str(&round).unwrap();
        assert_eq!(parsed["value"], stored);
    }
}
