//! PDF Viewer for OpenIDEA.
//!
//! `.pdf` files open in a custom editor (`[[contributes.customEditors]]`) whose
//! content is a web page of this package (`web/index.html`: pdf.js and the
//! reader's UI). The page is sandboxed — it can load its own files and talk to
//! this component, nothing else — and it draws the pages.
//!
//! ## Why this component exists
//!
//! The IDE's text document model sees a PDF as a binary blob: its text is
//! empty and read-only, so it cannot carry the bytes the page needs. OpenIDEA
//! API 1.5 closes that gap in two ways: the custom editor's page can call
//! `document.bytes()` (up to 64 MiB), and the plugin code can call
//! `Project::read_bytes` (up to 16 MiB, confined to the project and gated by
//! `project.read`). The page uses the former first and the latter as fallback.
//!
//! The component also keeps files the user picked in a bounded cache in its
//! private data directory ([`store`]), and reports the editor path
//! ([`protocol::Request::Info`]) so two PDFs with the same basename do not
//! share one entry.
//!
//! Nothing here parses a PDF, renders a page or touches the network. It asks
//! only for the low-risk `project.read` capability; there is no path-specific
//! `fs.read` grant.

pub mod protocol;
pub mod store;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use openidea_plugin::views::{View, ViewEvent, Viewport, Views};
use openidea_plugin::{Error, Invocation, Plugin, host, register_plugin};

/// The custom editor's id in `plugin.toml`; the page talks to this view.
pub const VIEW: &str = "viewer";

pub struct PdfViewer;

impl Default for PdfViewer {
    fn default() -> Self {
        Self
    }
}

impl Plugin for PdfViewer {
    fn activate(&mut self, _ctx: &openidea_plugin::Context) -> Result<(), Error> {
        // Nothing to subscribe to or restore: the page asks for what it needs.
        Ok(())
    }

    fn run_command(
        &mut self,
        id: &str,
        _ctx: &Invocation,
        _arg: Option<&str>,
    ) -> Result<Option<String>, Error> {
        Err(Error::NotFound(format!("command {id}")))
    }
}

impl Views for PdfViewer {
    fn render(
        &mut self,
        view: &str,
        _viewport: Option<Viewport>,
        _ctx: &Invocation,
    ) -> Result<View, Error> {
        if view != VIEW {
            return Err(Error::NotFound(view.into()));
        }
        // A web custom editor is drawn by its page; this is only reached if an
        // IDE asks for content it does not need.
        Ok(View::message("The PDF is drawn by the plugin's page."))
    }

    fn handle(&mut self, view: &str, event: ViewEvent, ctx: &Invocation) -> Result<(), Error> {
        if view != VIEW {
            return Err(Error::NotFound(view.into()));
        }
        let ViewEvent::Message(text) = event else {
            return Ok(());
        };
        // Not ours (another message, a page from another version): ignore it
        // rather than fail the plugin.
        let Some(request) = protocol::parse(&text) else {
            return Ok(());
        };
        let request = match request {
            Ok(request) => request,
            Err((id, message)) => {
                post(&protocol::error(&id, &message));
                return Ok(());
            }
        };
        match request {
            // API 1.3: the tab's absolute path, when the view has one. The page
            // caches by it, so `a/paper.pdf` and `b/paper.pdf` stay apart.
            protocol::Request::Info { id } => {
                let path = ctx.editor().map(|editor| editor.path());
                post(&protocol::info(&id, path.as_deref()));
            }
            // API 1.5 fallback for a frame whose document.bytes() call fails:
            // read only the current file, through the open project's confined
            // `project.read-bytes` API (16 MiB cap, `project.read` grant).
            protocol::Request::Read { id } => match read_project_file(ctx) {
                Ok(bytes) => send_bytes(&id, &bytes),
                Err(e) => post(&protocol::none(&id, &e.to_string())),
            },
            protocol::Request::Get { id, key } => match store::get(&key) {
                Ok(value) => post(&protocol::value(&id, &key, value.as_deref())),
                Err(e) => post(&protocol::error(&id, &e.to_string())),
            },
            protocol::Request::Set { id, key, value } => match store::set(&key, &value) {
                Ok(()) => post(&protocol::ok(&id, &key)),
                Err(e) => post(&protocol::error(&id, &e.to_string())),
            },
            protocol::Request::Delete { id, key } => match store::delete(&key) {
                Ok(()) => post(&protocol::ok(&id, &key)),
                Err(e) => post(&protocol::error(&id, &e.to_string())),
            },
            protocol::Request::Keys { id, prefix } => match store::keys(&prefix) {
                Ok(found) => post(&protocol::keys(&id, &prefix, &found)),
                Err(e) => post(&protocol::error(&id, &e.to_string())),
            },
            protocol::Request::Ping { id } => post(&protocol::pong(&id)),
        }
        Ok(())
    }
}

/// Reads only the current editor's file, confined to the active project root.
/// API 1.5 caps this `project.read-bytes` call at 16 MiB and requires
/// `project.read`; the web page's `document.bytes()` is the preferred 64 MiB
/// path.
fn read_project_file(ctx: &Invocation) -> Result<Vec<u8>, Error> {
    let editor = ctx
        .editor()
        .ok_or_else(|| Error::NotFound("this view has no file".into()))?;
    let project = ctx
        .project()
        .ok_or_else(|| Error::NotFound("this view has no open project".into()))?;
    project.read_bytes(&editor.path())
}

/// Sends `bytes` to the page in [`protocol::PART`]-byte parts, base64 in text.
fn send_bytes(id: &str, bytes: &[u8]) {
    if bytes.is_empty() {
        post(&protocol::bytes(id, 0, 1, ""));
        return;
    }
    let parts = bytes.len().div_ceil(protocol::PART);
    for (index, chunk) in bytes.chunks(protocol::PART).enumerate() {
        post(&protocol::bytes(id, index, parts, &BASE64.encode(chunk)));
    }
}

/// The messages the page receives are broadcast to every frame of the view;
/// an id it does not know is dropped there.
fn post(message: &str) {
    let _ = host::post_view_message(VIEW, message);
}

register_plugin!(PdfViewer, views);

#[cfg(test)]
mod tests {
    use super::*;
    use openidea_plugin::mock::MockHost;
    use serde_json::Value;

    /// Runs one page message against a fresh mock with `caps`, returning what
    /// the page was told.
    fn ask(caps: &[&str], text: &str) -> Vec<Value> {
        let host = MockHost::install().with_capabilities(caps);
        PdfViewer
            .handle(VIEW, ViewEvent::Message(text.into()), &host.invocation())
            .unwrap();
        host.view_messages()
            .into_iter()
            .map(|(view, text)| {
                assert_eq!(view, VIEW);
                serde_json::from_str(&text).unwrap()
            })
            .collect()
    }

    /// The files the cache wrote into the plugin's directory, by key.
    fn stored_files() -> Vec<String> {
        let dir = host::fs::plugin_dir().unwrap();
        let mut names: Vec<String> = host::fs::read_dir(&dir)
            .unwrap()
            .into_iter()
            .map(|entry| entry.name.replace("%2F", "/"))
            .collect();
        names.sort();
        names
    }

    #[test]
    fn a_set_is_stored_and_read_back() {
        let host = MockHost::install();
        let mut plugin = PdfViewer;
        let set = r#"{"op":"set","id":"1","key":"pdfviewer/a/0","value":"JVBERi0xLjQK"}"#;
        plugin
            .handle(VIEW, ViewEvent::Message(set.into()), &host.invocation())
            .unwrap();
        let get = r#"{"op":"get","id":"2","key":"pdfviewer/a/0"}"#;
        plugin
            .handle(VIEW, ViewEvent::Message(get.into()), &host.invocation())
            .unwrap();

        let messages = host.view_messages();
        assert_eq!(messages.len(), 2);
        let ok: Value = serde_json::from_str(&messages[0].1).unwrap();
        assert_eq!(
            (&ok["op"], &ok["key"]),
            (&Value::from("ok"), &Value::from("pdfviewer/a/0"))
        );
        let value: Value = serde_json::from_str(&messages[1].1).unwrap();
        assert_eq!(
            (&value["op"], &value["value"]),
            (&Value::from("value"), &Value::from("JVBERi0xLjQK"))
        );
        // It really is a file in the plugin's own directory (API 1.3), named
        // after its key.
        assert_eq!(stored_files(), ["pdfviewer/a/0"]);
    }

    #[test]
    fn the_store_needs_no_capability_at_all() {
        // The store works with every capability declined: API 1.3's plugin
        // directory is the plugin's own, and no grant covers it.
        let host = MockHost::install().with_capabilities(&[]);
        let mut plugin = PdfViewer;
        for text in [
            r#"{"op":"set","id":"1","key":"pdfviewer/a/0","value":"x"}"#,
            r#"{"op":"get","id":"2","key":"pdfviewer/a/0"}"#,
        ] {
            plugin
                .handle(VIEW, ViewEvent::Message(text.into()), &host.invocation())
                .unwrap();
        }
        let messages = host.view_messages();
        let ok: Value = serde_json::from_str(&messages[0].1).unwrap();
        assert_eq!(ok["op"], "ok");
        let value: Value = serde_json::from_str(&messages[1].1).unwrap();
        assert_eq!(value["value"], "x");
    }

    #[test]
    fn info_reports_the_tabs_path() {
        let host = MockHost::install();
        host.open_editor("/papers/2024/attention.pdf", "pdf", "", &[]);
        let mut plugin = PdfViewer;
        plugin
            .handle(
                VIEW,
                ViewEvent::Message(r#"{"op":"info","id":"1"}"#.into()),
                &host.invocation(),
            )
            .unwrap();
        let answer: Value = serde_json::from_str(&host.view_messages()[0].1).unwrap();
        assert_eq!(answer["op"], "info");
        assert_eq!(answer["path"], "/papers/2024/attention.pdf");
    }

    #[test]
    fn info_without_a_file_is_null() {
        let messages = ask(&[], r#"{"op":"info","id":"1"}"#);
        assert_eq!(messages[0]["op"], "info");
        assert!(messages[0]["path"].is_null());
    }

    #[test]
    fn a_missing_key_is_null_not_an_error() {
        let messages = ask(&[], r#"{"op":"get","id":"1","key":"pdfviewer/none"}"#);
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0]["op"], "value");
        assert!(messages[0]["value"].is_null());
    }

    #[test]
    fn deletes_remove_what_was_stored() {
        let host = MockHost::install();
        let mut plugin = PdfViewer;
        for text in [
            r#"{"op":"set","id":"1","key":"pdfviewer/a/0","value":"x"}"#,
            r#"{"op":"del","id":"2","key":"pdfviewer/a/0"}"#,
            r#"{"op":"get","id":"3","key":"pdfviewer/a/0"}"#,
        ] {
            plugin
                .handle(VIEW, ViewEvent::Message(text.into()), &host.invocation())
                .unwrap();
        }
        let last: Value = serde_json::from_str(&host.view_messages().last().unwrap().1).unwrap();
        assert!(last["value"].is_null());
        // The file stays behind (fs has no remove), empty and unlisted.
        plugin
            .handle(
                VIEW,
                ViewEvent::Message(r#"{"op":"keys","id":"4","prefix":"pdfviewer/"}"#.into()),
                &host.invocation(),
            )
            .unwrap();
        let listed: Value = serde_json::from_str(&host.view_messages().last().unwrap().1).unwrap();
        assert!(
            listed["keys"].as_array().unwrap().is_empty(),
            "{}",
            listed["keys"]
        );
    }

    #[test]
    fn keys_lists_a_prefix() {
        let host = MockHost::install();
        let mut plugin = PdfViewer;
        for text in [
            r#"{"op":"set","id":"1","key":"pdfviewer/a/0","value":"x"}"#,
            r#"{"op":"set","id":"2","key":"pdfviewer/a/1","value":"y"}"#,
            r#"{"op":"set","id":"3","key":"pdfviewer/b/0","value":"z"}"#,
            r#"{"op":"keys","id":"4","prefix":"pdfviewer/a/"}"#,
        ] {
            plugin
                .handle(VIEW, ViewEvent::Message(text.into()), &host.invocation())
                .unwrap();
        }
        let listed: Value = serde_json::from_str(&host.view_messages().last().unwrap().1).unwrap();
        assert_eq!(listed["op"], "keys");
        assert_eq!(
            listed["keys"],
            serde_json::json!(["pdfviewer/a/0", "pdfviewer/a/1"])
        );
    }

    #[test]
    fn a_key_that_is_not_a_file_name_is_refused() {
        let host = MockHost::install();
        let mut plugin = PdfViewer;
        let text = serde_json::json!({ "op": "set", "id": "1", "key": "pdfviewer/../../escape", "value": "x" })
            .to_string();
        plugin
            .handle(VIEW, ViewEvent::Message(text), &host.invocation())
            .unwrap();
        let answer: Value = serde_json::from_str(&host.view_messages()[0].1).unwrap();
        assert_eq!(answer["op"], "error");
        assert!(
            answer["message"].as_str().unwrap().contains("segment"),
            "{}",
            answer["message"]
        );
        assert!(
            stored_files().is_empty(),
            "nothing was written: {:?}",
            stored_files()
        );
    }

    #[test]
    fn an_over_long_value_is_refused_before_it_reaches_the_disk() {
        let host = MockHost::install();
        let big = "v".repeat(protocol::MAX_VALUE + 1);
        let text =
            serde_json::json!({ "op": "set", "id": "1", "key": "pdfviewer/a/0", "value": big })
                .to_string();
        PdfViewer
            .handle(VIEW, ViewEvent::Message(text), &host.invocation())
            .unwrap();
        assert!(stored_files().is_empty());
        let answer: Value = serde_json::from_str(&host.view_messages()[0].1).unwrap();
        assert_eq!(answer["op"], "error");
        assert!(answer["message"].as_str().unwrap().contains("limit"));
    }

    #[test]
    fn a_large_value_within_the_limit_round_trips() {
        let host = MockHost::install();
        let mut plugin = PdfViewer;
        let body = "A".repeat(protocol::MAX_VALUE - 100);
        let set =
            serde_json::json!({ "op": "set", "id": "1", "key": "pdfviewer/big/0", "value": body })
                .to_string();
        plugin
            .handle(VIEW, ViewEvent::Message(set), &host.invocation())
            .unwrap();
        plugin
            .handle(
                VIEW,
                ViewEvent::Message(r#"{"op":"get","id":"2","key":"pdfviewer/big/0"}"#.into()),
                &host.invocation(),
            )
            .unwrap();
        let value: Value = serde_json::from_str(&host.view_messages().last().unwrap().1).unwrap();
        assert_eq!(value["value"].as_str().unwrap().len(), body.len());
    }

    #[test]
    fn project_read_bytes_reaches_the_page_without_a_path_grant() {
        let bytes = [b"%PDF-1.4\0".as_slice(), &[0xff, 0xfe, 0x1b, 0x7f]].concat();
        let host = MockHost::install().with_capabilities(&["project.read"]);
        host.add_file_bytes("attention.pdf", &bytes);
        host.open_editor("/project/attention.pdf", "pdf", "", &[]);
        PdfViewer
            .handle(
                VIEW,
                ViewEvent::Message(r#"{"op":"read","id":"1"}"#.into()),
                &host.invocation(),
            )
            .unwrap();
        let messages = host.view_messages();
        assert_eq!(messages.len(), 1, "one part: {:?}", messages);
        let reply: Value = serde_json::from_str(&messages[0].1).unwrap();
        assert_eq!(
            (&reply["op"], &reply["part"], &reply["parts"]),
            (&Value::from("bytes"), &Value::from(0), &Value::from(1))
        );
        let decoded = BASE64.decode(reply["data"].as_str().unwrap()).unwrap();
        assert_eq!(decoded, bytes, "the exact binary bytes arrive intact");
    }

    #[test]
    fn project_read_bytes_needs_project_read() {
        let host = MockHost::install().with_capabilities(&[]);
        host.add_file_bytes("attention.pdf", b"%PDF-1.4\0\xff");
        host.open_editor("/project/attention.pdf", "pdf", "", &[]);
        PdfViewer
            .handle(
                VIEW,
                ViewEvent::Message(r#"{"op":"read","id":"1"}"#.into()),
                &host.invocation(),
            )
            .unwrap();
        let reply: Value = serde_json::from_str(&host.view_messages()[0].1).unwrap();
        assert_eq!(reply["op"], "none");
        assert!(
            reply["reason"].as_str().unwrap().contains("project.read"),
            "{}",
            reply["reason"]
        );
    }

    #[test]
    fn answers_ping_and_ignores_what_is_not_its_protocol() {
        let host = MockHost::install();
        let mut plugin = PdfViewer;
        plugin
            .handle(
                VIEW,
                ViewEvent::Message(r#"{"op":"ping","id":"k"}"#.into()),
                &host.invocation(),
            )
            .unwrap();
        plugin
            .handle(VIEW, ViewEvent::Message("hello".into()), &host.invocation())
            .unwrap();
        plugin
            .handle(
                VIEW,
                ViewEvent::Button("refresh".into()),
                &host.invocation(),
            )
            .unwrap();
        let messages = host.view_messages();
        assert_eq!(messages.len(), 1);
        assert_eq!(
            serde_json::from_str::<Value>(&messages[0].1).unwrap()["op"],
            "pong"
        );
        assert!(
            plugin
                .handle(
                    "another-view",
                    ViewEvent::Message("{}".into()),
                    &host.invocation()
                )
                .is_err()
        );
    }

    #[test]
    fn render_only_answers_its_own_view() {
        let host = MockHost::install();
        let mut plugin = PdfViewer;
        assert!(plugin.render(VIEW, None, &host.invocation()).is_ok());
        assert!(
            plugin
                .render("another-view", None, &host.invocation())
                .is_err()
        );
    }
}
