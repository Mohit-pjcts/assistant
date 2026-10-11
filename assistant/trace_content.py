"""Turning message content into the text and JSON the History panel shows
(STEPS.md 158) — the helpers `tool_trace.py` (what gets recorded) and
`history_trace.py` (what gets shown) both need, kept in one module so a result
reads the same in both and neither imports the other's internals.

Everything here is a pure function over plain values; nothing touches a
database, a graph or the network.

**The only things ever dropped** (the History's rule is that nothing about a
call is lost, bar these): a base64 payload — an image's bytes, an embedded
`data:` URI — longer than `DATA_URI_MIN_CHARS`, replaced by a marker that says
how big it was. Nobody can read base64, and one picture would otherwise turn a
payload into megabytes. Text is never clipped here (`trace_store` has its own,
much higher, per-field cap).
"""

from __future__ import annotations

import json
import re
from typing import Any

# Longer than this, a data: URI is shown as a size marker, not inline.
DATA_URI_MIN_CHARS = 500
# Past this a `data` field inside a content block is a base64 payload (an
# image, a PDF), not text anyone can read — rendered as its size instead.
_BLOB_MIN_CHARS = 500

# A string that IS one data: URI: no whitespace anywhere (RFC 2397 allows
# none). Requiring that is what keeps a long piece of prose that merely starts
# with "data:" from being mistaken for one.
_WHOLE_DATA_URI = re.compile(r"data:[^\s,]*,\S*")
# A data: URI inside a longer string (a JSON dump, markdown). The parameter and
# mime classes exclude `;` so the groups can't match the same text two ways
# (which would let a malformed URI backtrack badly).
_DATA_URI = re.compile(r"data:(?P<mime>[^;,\s\"'<>()]*)(?:;[^;,\s\"'<>()]*)*,[A-Za-z0-9+/=%_-]*")


def _data_uri_marker(uri: str) -> str:
    match = re.match(r"data:([^;,]*)", uri)
    mime = (match.group(1) if match else "") or "text/plain"  # RFC 2397's default type
    return f"<data URI: {mime}, {len(uri)} chars>"


def _elide_string(text: str) -> str:
    if "data:" not in text:
        return text
    if len(text) > DATA_URI_MIN_CHARS and _WHOLE_DATA_URI.fullmatch(text):
        return _data_uri_marker(text)
    return _DATA_URI.sub(
        lambda m: (
            _data_uri_marker(m.group(0)) if len(m.group(0)) > DATA_URI_MIN_CHARS else m.group(0)
        ),
        text,
    )


def elide_data_uris(value: Any) -> Any:
    """`value` (any JSON-shaped structure) with every data: URI longer than
    `DATA_URI_MIN_CHARS` replaced by a size marker. Dict keys are left alone."""
    if isinstance(value, str):
        return _elide_string(value)
    if isinstance(value, dict):
        return {key: elide_data_uris(item) for key, item in value.items()}
    if isinstance(value, list | tuple):
        return [elide_data_uris(item) for item in value]
    return value


def without_blobs(value: Any) -> Any:
    """`value` with every long base64 `data` field replaced by a size marker,
    at any depth — the one non-text thing a content block carries that would
    otherwise turn a result into megabytes of noise."""
    if isinstance(value, dict):
        return {
            key: (
                f"<base64 data: {len(item)} chars>"
                if key == "data" and isinstance(item, str) and len(item) > _BLOB_MIN_CHARS
                else without_blobs(item)
            )
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [without_blobs(item) for item in value]
    return value


def strip_blobs(value: Any) -> Any:
    """`value` with both kinds of blob gone: base64 `data` fields and long
    data: URIs. What `tool_trace.py` records for a call's extras — an A2UI
    surface carries its images as data: URIs, which would otherwise swamp the
    row (and, past `trace_store`'s cap, leave it as unparseable half-JSON)."""
    return elide_data_uris(without_blobs(value))


def _block_text(block: object) -> str:
    if isinstance(block, str):
        return block
    if isinstance(block, dict):
        if block.get("type") == "text":
            return str(block.get("text") or "")
        # Anything else (an image, a file, a tool-use block): keep it, as
        # JSON, rather than dropping information on the floor.
        return json.dumps(without_blobs(block), ensure_ascii=False, default=str)
    return str(block)


def render_text(content: object) -> str:
    """A message's `content` as plain text: a string as is; a content-block
    list with its text blocks joined by newlines and any other block kept as
    compact JSON (base64 payloads shown as their size, see `without_blobs`).
    Shared by `tool_trace.py` (what a call returned) and `history_trace.py`
    (what a message said), so a result reads the same wherever it is shown."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = [_block_text(block) for block in content]
        return "\n".join(part for part in parts if part)
    return str(content)


def ai_text_and_thinking(content: object) -> tuple[str, str | None]:
    """(text, thinking) of an AIMessage's `content`: its text blocks, and its
    thinking blocks in full (None when there are none, or they carry no text —
    a block the API returned signature-only). Tool-use blocks are skipped; a
    call comes from the message's `tool_calls`, not its content. Shared by the
    builder (the supervisor's turns, from the checkpoint) and the model-call
    hook (a specialist's turns, as they happen)."""
    if isinstance(content, str):
        return content, None
    texts: list[str] = []
    thoughts: list[str] = []
    for block in content if isinstance(content, list) else []:
        if isinstance(block, str):
            texts.append(block)
        elif isinstance(block, dict):
            if block.get("type") == "text":
                texts.append(str(block.get("text") or ""))
            elif block.get("type") == "thinking":
                thoughts.append(str(block.get("thinking") or ""))
    return "\n".join(t for t in texts if t), "\n\n".join(t for t in thoughts if t) or None
