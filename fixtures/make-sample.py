#!/usr/bin/env python3
"""Builds fixtures/sample.pdf: three ASCII pages, a base-14 font and two
bookmarks. The tests (and a person trying the plugin) use it.

Deliberately uncompressed and pure ASCII, so the file's bytes are also valid
UTF-8 text: the plugin's "the document text is the PDF" path can be exercised
with it. Real PDFs are almost never ASCII, which is why the plugin has the
other paths.

    python3 fixtures/make-sample.py
"""

from pathlib import Path

PAGES = [
    ("Fast Reader Test Fixture", "Page one. The quick brown fox jumps over the lazy dog."),
    ("Chapter One", "Page two. Bookmarks reach this page."),
    ("Chapter Two", "Page three. The quick brown fox is back."),
]

objects: list[bytes] = []


def add(body: str) -> int:
    objects.append(body.encode("ascii"))
    return len(objects)


def stream(content: str) -> str:
    return f"<< /Length {len(content)} >>\nstream\n{content}\nendstream"


catalog = add("")
pages = add("")
page_ids = [add("") for _ in PAGES]
font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
content_ids = [
    add(stream(f"BT /F1 24 Tf 72 760 Td ({title}) Tj ET\nBT /F1 12 Tf 72 720 Td ({body}) Tj ET"))
    for title, body in PAGES
]
outlines = add("")
bookmark_one = add("")
bookmark_two = add("")

objects[catalog - 1] = (
    f"<< /Type /Catalog /Pages {pages} 0 R /Outlines {outlines} 0 R /PageMode /UseOutlines >>"
).encode("ascii")
objects[pages - 1] = (
    f"<< /Type /Pages /Kids [{' '.join(f'{i} 0 R' for i in page_ids)}] /Count {len(PAGES)} >>"
).encode("ascii")
for index, page_id in enumerate(page_ids):
    objects[page_id - 1] = (
        f"<< /Type /Page /Parent {pages} 0 R /MediaBox [0 0 595 842] "
        f"/Resources << /Font << /F1 {font} 0 R >> >> /Contents {content_ids[index]} 0 R >>"
    ).encode("ascii")
objects[outlines - 1] = (
    f"<< /Type /Outlines /First {bookmark_one} 0 R /Last {bookmark_two} 0 R /Count 2 >>"
).encode("ascii")
objects[bookmark_one - 1] = (
    f"<< /Title (Chapter One) /Parent {outlines} 0 R /Next {bookmark_two} 0 R /Dest [{page_ids[1]} 0 R /Fit] >>"
).encode("ascii")
objects[bookmark_two - 1] = (
    f"<< /Title (Chapter Two) /Parent {outlines} 0 R /Prev {bookmark_one} 0 R /Dest [{page_ids[2]} 0 R /Fit] >>"
).encode("ascii")

out = bytearray(b"%PDF-1.4\n")
offsets = []
for number, body in enumerate(objects, start=1):
    offsets.append(len(out))
    out += f"{number} 0 obj\n".encode("ascii") + body + b"\nendobj\n"

xref_at = len(out)
out += f"xref\n0 {len(objects) + 1}\n".encode("ascii")
out += b"0000000000 65535 f \n"
for offset in offsets:
    out += f"{offset:010d} 00000 n \n".encode("ascii")
out += (
    f"trailer\n<< /Size {len(objects) + 1} /Root {catalog} 0 R >>\nstartxref\n{xref_at}\n%%EOF\n"
).encode("ascii")

target = Path(__file__).with_name("sample.pdf")
target.write_bytes(out)
print(f"{target}: {len(out)} bytes, {len(PAGES)} pages")
