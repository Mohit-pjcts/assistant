"""Tools that get a real image/video INTO an A2UI surface without a model
ever having to read, retype, or relay its raw bytes.

**The problem this fixes (live-diagnosed, not theoretical):** render_ui's
Image/Video fields need a base64 data: URI. Asking a specialist to read a
file, then hand the base64 back to the supervisor as its own reply text,
breaks for anything beyond a tiny file — the specialist's reply is a model
COMPLETION, bounded by max output tokens, and a real screenshot's base64
(1-2MB+) is far larger than that. A real turn hit exactly this: the model
correctly worked around read_disk_file's text-only limit by shelling out to
`base64`, got a truncated string back (confirmed independently — Langfuse's
own base64 decode of the same string failed with "Incorrect padding"), and
shipped a broken image. No tool in this file relies on a model regenerating
raw bytes as text; each one reads/fetches bytes directly in Python and
dispatches the finished surface itself — same "code builds the surface, not
the model" pattern as board_tools.py's render_board_ui.

**render_local_media** — full-disk read, same credential-path denylist as
disk_tools.py's own tools (imported directly, not re-implemented, so the
two lists can't drift apart).

**render_web_media** — fetches a URL SERVER-SIDE and embeds the result as a
data: URI; the browser never makes an outbound request to the original URL.
This is deliberate, not incidental: assistant/a2ui.py's Image/Video
validation requires data: URIs specifically to close a tracking/
exfiltration vector (a live remote <img src> silently phones home to
whoever hosts it, no confirmation gate, the moment it renders). Letting the
MODEL embed a raw remote URL directly would reopen exactly that vector —
this tool preserves the closed vector by making the fetch happen once,
under this tool's own control, with its own guards, and only ever handing
the browser inert bytes. Guards, since this now makes server-side requests
to a URL an agent (possibly acting on injected content) supplies:
- http/https only, no redirects followed (redirect-based SSRF bypass)
- every resolved IP for the hostname checked against private/loopback/
  link-local/reserved ranges before the request is made
- Content-Type must actually be image/* or video/*
- response streamed with a hard byte cap, same discipline as server.py's
  own /uploads handler

Images downsample to the SAME 1568px long edge server.py's own upload
handler already uses (IMAGE_MAX_LONG_EDGE) — not a new convention, reusing
the existing cost-driven decision. Video gets no such treatment (no
transcode dependency in this project) — just a hard raw-byte cap, tighter
than images, because an embedded video's base64 doesn't just cost tokens
once: it duplicates into the LangGraph checkpoint on every turn it's part
of, and into Langfuse traces.
"""

from __future__ import annotations

import base64
import ipaddress
import mimetypes
import socket
from io import BytesIO
from pathlib import Path
from typing import Annotated, Any

import httpx
from langchain_core.tools import InjectedToolCallId, tool
from langgraph.types import Command
from PIL import Image

from assistant.a2ui import dispatch_surface
from assistant.disk_tools import _is_credential_path

# Matches server.py's IMAGE_MAX_LONG_EDGE exactly — same cost rationale
# (CLAUDE.md's standing cost-consciousness rule), not redefined arbitrarily.
_IMAGE_MAX_LONG_EDGE = 1568
_MAX_LOCAL_VIDEO_BYTES = 3_000_000
_MAX_FETCH_BYTES = 8_000_000
_FETCH_TIMEOUT_SECONDS = 15.0

_IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".gif", ".webp"}
_VIDEO_EXTENSIONS = {".mp4", ".mov", ".webm", ".m4v"}


def _downsample_image_bytes(raw: bytes) -> tuple[bytes, str]:
    """Returns (re-encoded bytes, mime type). Mirrors server.py's own
    upload-resize logic exactly (same long edge, same LANCZOS filter) —
    PNG kept for images with real transparency, JPEG otherwise (smaller)."""
    with Image.open(BytesIO(raw)) as img:
        img.load()
        long_edge = max(img.size)
        if long_edge > _IMAGE_MAX_LONG_EDGE:
            scale = _IMAGE_MAX_LONG_EDGE / long_edge
            img = img.resize(
                (max(1, round(img.width * scale)), max(1, round(img.height * scale))),
                Image.LANCZOS,
            )
        keep_png = img.mode in ("RGBA", "LA") or "transparency" in img.info
        buf = BytesIO()
        if keep_png:
            img.save(buf, format="PNG")
            mime = "image/png"
        else:
            img.convert("RGB").save(buf, format="JPEG", quality=85)
            mime = "image/jpeg"
        return buf.getvalue(), mime


def _build_media_surface(surface_id: str, title: str, mime: str, raw: bytes) -> dict[str, Any]:
    b64 = base64.b64encode(raw).decode("ascii")
    url = f"data:{mime};base64,{b64}"
    is_video = mime.startswith("video/")
    media_id = "media"
    return {
        "surfaceId": surface_id,
        "components": [
            {"id": "root", "component": "Card", "child": "col"},
            {"id": "col", "component": "Column", "children": ["title", media_id]},
            {"id": "title", "component": "Text", "text": title, "variant": "h4"},
            {"id": media_id, "component": "Video" if is_video else "Image", "url": url}
            | ({} if is_video else {"fit": "contain", "variant": "largeFeature"}),
        ],
    }


@tool
async def render_local_media(path: str, tool_call_id: Annotated[str, InjectedToolCallId]) -> Command:
    """Render an image or video file already on this Mac's filesystem
    directly in the dashboard.

    Reads and encodes the file itself — you never see, retype, or relay its
    bytes, which is the whole point: a real photo or screenshot's base64 is
    far larger than any reply you could generate, so handing it back to the
    supervisor as text (e.g. via a shell `base64` command) silently
    truncates and produces a broken image. Use this instead of trying to
    read the file yourself and pass its content to render_ui.

    Args:
        path: Absolute path, or one starting with ~ for the home directory.
            Use search_disk first if you don't already know the exact path.

    Images are automatically downsized for a reasonable file size; nothing
    is transcoded for video, so a very large video file will be rejected —
    tell the user it's too large to embed inline if that happens. Has no
    effect outside the dashboard, same as render_ui.
    """

    def _reject(message: str) -> Command:
        from langchain_core.messages import ToolMessage

        return Command(update={"messages": [ToolMessage(content=message, tool_call_id=tool_call_id)]})

    try:
        resolved = Path(path).expanduser().resolve()
    except OSError as exc:
        return _reject(f"render_local_media: could not resolve '{path}': {exc}")
    if _is_credential_path(resolved):
        return _reject(f"render_local_media: '{path}' is a credential/secret path and cannot be rendered")
    if not resolved.is_file():
        return _reject(f"render_local_media: '{path}' does not exist or is not a file")

    ext = resolved.suffix.lower()
    try:
        raw = resolved.read_bytes()
    except OSError as exc:
        return _reject(f"render_local_media: could not read '{path}': {exc}")

    if ext in _IMAGE_EXTENSIONS:
        try:
            raw, mime = _downsample_image_bytes(raw)
        except Exception as exc:  # noqa: BLE001 — any Pillow decode failure is just "not a valid image"
            return _reject(f"render_local_media: '{path}' could not be read as an image: {exc}")
    elif ext in _VIDEO_EXTENSIONS:
        if len(raw) > _MAX_LOCAL_VIDEO_BYTES:
            return _reject(
                f"render_local_media: '{path}' is {len(raw)} bytes, over the "
                f"{_MAX_LOCAL_VIDEO_BYTES}-byte inline-video cap — too large to embed. "
                "Tell the user this file is too big to show inline; open it directly instead."
            )
        mime = mimetypes.guess_type(str(resolved))[0] or "video/mp4"
    else:
        return _reject(f"render_local_media: '{path}' has an unsupported extension for inline media ({ext!r})")

    surface = _build_media_surface(f"media-{resolved.stem[:32]}", resolved.name, mime, raw)
    return await dispatch_surface(surface, tool_call_id, "render_local_media rejected the surface")


def _resolve_safe_ip(host: str) -> str | None:
    """SSRF guard, resolving ONCE: every IP `host` resolves to must be
    public/routable (rejects loopback/private/link-local/reserved ranges —
    blocks the classic 127.0.0.1 / 169.254.169.254 cloud-metadata /
    internal-LAN targets an injected instruction could otherwise point this
    tool at), and the caller must connect to the SAME resolved IP this
    function returns rather than re-resolving `host` by name a second time.
    A real DNS-rebinding TOCTOU otherwise exists here: a short-TTL DNS
    record can validate safe on this call and then resolve to a private/
    loopback address moments later when the actual connection is made —
    returning the validated IP (not just True/False) is what lets the
    caller pin the connection and close that window."""
    try:
        infos = socket.getaddrinfo(host, None)
    except OSError:
        return None
    safe_ip: str | None = None
    for info in infos:
        addr = info[4][0]
        try:
            ip = ipaddress.ip_address(addr)
        except ValueError:
            return None
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast:
            return None
        if safe_ip is None:
            safe_ip = addr
    return safe_ip


@tool
async def render_web_media(url: str, tool_call_id: Annotated[str, InjectedToolCallId]) -> Command:
    """Fetch an image or video from a URL and render it directly in the
    dashboard.

    The fetch happens here, server-side — the surface that reaches the
    dashboard always carries the actual bytes (a data: URI), never the
    original URL, matching render_ui's own no-remote-URL rule. Use this
    instead of ever putting a live http(s) URL directly into a render_ui
    Image/Video component (which is rejected).

    Args:
        url: A direct http(s) link to an image or video file.

    Rejects non-http(s) schemes, redirects, non-image/video content types,
    anything resolving to a private/internal address, and anything over
    the size cap. Has no effect outside the dashboard, same as render_ui.
    """
    from langchain_core.messages import ToolMessage

    def _reject(message: str) -> Command:
        return Command(update={"messages": [ToolMessage(content=message, tool_call_id=tool_call_id)]})

    parsed = httpx.URL(url)
    if parsed.scheme not in ("http", "https"):
        return _reject(f"render_web_media: only http/https URLs are supported, got scheme {parsed.scheme!r}")
    safe_ip = _resolve_safe_ip(parsed.host)
    if safe_ip is None:
        return _reject(f"render_web_media: '{parsed.host}' does not resolve to a public address — refused")

    try:
        # A real, non-adversarial UA — some CDNs (Wikimedia's included,
        # confirmed live) 403 the default httpx UA string outright.
        headers = {"User-Agent": "Mozilla/5.0 (compatible; OniAssistant/1.0)"}
        async with httpx.AsyncClient(follow_redirects=False, timeout=_FETCH_TIMEOUT_SECONDS) as client:
            # Pin the actual TCP connection to the IP just validated above,
            # rather than letting httpx re-resolve `parsed.host` by name a
            # second time — closes the DNS-rebinding TOCTOU window
            # _resolve_safe_ip's own docstring explains. `sni_hostname`
            # keeps TLS SNI (and certificate hostname verification) correct
            # for the ORIGINAL hostname despite connecting to a raw IP; the
            # Host header is computed from `request.url` before the swap,
            # so it's also still the original hostname, not the IP.
            request = client.build_request(
                "GET", url, headers=headers, extensions={"sni_hostname": parsed.host}
            )
            request.url = request.url.copy_with(host=safe_ip)
            response = await client.send(request, stream=True)
            try:
                if response.is_redirect:
                    return _reject("render_web_media: the URL redirected — redirects are not followed, refused")
                if response.status_code != 200:
                    return _reject(f"render_web_media: fetch failed with status {response.status_code}")
                content_type = response.headers.get("content-type", "").split(";")[0].strip()
                if not (content_type.startswith("image/") or content_type.startswith("video/")):
                    return _reject(
                        f"render_web_media: URL content-type is {content_type!r}, not an image or video"
                    )
                chunks: list[bytes] = []
                total = 0
                async for chunk in response.aiter_bytes(65_536):
                    total += len(chunk)
                    if total > _MAX_FETCH_BYTES:
                        return _reject(
                            f"render_web_media: response exceeds the {_MAX_FETCH_BYTES}-byte fetch cap"
                        )
                    chunks.append(chunk)
                raw = b"".join(chunks)
            finally:
                await response.aclose()
    except httpx.HTTPError as exc:
        return _reject(f"render_web_media: fetch failed — {exc}")

    if content_type.startswith("image/"):
        try:
            raw, mime = _downsample_image_bytes(raw)
        except Exception as exc:  # noqa: BLE001 — any Pillow decode failure is just "not a valid image"
            return _reject(f"render_web_media: fetched content could not be read as an image: {exc}")
    else:
        if len(raw) > _MAX_LOCAL_VIDEO_BYTES:
            return _reject(
                f"render_web_media: video is {len(raw)} bytes, over the "
                f"{_MAX_LOCAL_VIDEO_BYTES}-byte inline-video cap — too large to embed. "
                "Tell the user this is too big to show inline; suggest opening the link directly instead."
            )
        mime = content_type

    surface = _build_media_surface("media-web", parsed.host, mime, raw)
    return await dispatch_surface(surface, tool_call_id, "render_web_media rejected the surface")


def build_media_tools() -> list:
    return [render_local_media, render_web_media]
