"""Tests for assistant.media_tools.

The DNS-rebinding TOCTOU test below was added first, scoped narrowly to
that one bug fix. This file was later extended to close Phase 26's
"zero test coverage" gap — MODERATE depth, per direct instruction: the
security/correctness-critical paths (credential-path bypass, both size
caps, content-type spoofing, redirect/connection-error handling, unsupported
extensions), not full exhaustive coverage of every branch.

Real dispatch_surface success paths need a real LangGraph run context
(adispatch_custom_event raises RuntimeError outside one — confirmed live,
not assumed) — the two happy-path tests below monkeypatch
assistant.a2ui.adispatch_custom_event to a no-op so they can verify the
tool reaches a successful dispatch without a real graph/API call, same
"unit-test the boundary, integration-test the pipeline separately" split
this project already uses elsewhere (e.g. Phase 17's Part A/B).
"""

import asyncio
import functools
import tempfile
from io import BytesIO
from pathlib import Path

import httpx
from PIL import Image

import assistant.a2ui as a2ui
import assistant.media_tools as media_tools


def test_render_web_media_pins_the_connection_to_the_validated_ip(monkeypatch) -> None:
    """The actual DNS-rebinding regression test: getaddrinfo is called
    exactly once, and the real outbound request (observed via
    httpx.MockTransport, which intercepts before any real network I/O)
    targets the SAFE ip that call returned — not a second, possibly
    different resolution of the hostname. If _resolve_safe_ip's result
    were discarded and the fetch re-resolved by name, this test would
    have no way to tell; asserting the actual request host proves the
    pinning is real, not just that the check function returns non-None."""
    calls = []

    def fake_getaddrinfo(host, port):
        calls.append(host)
        # Simulate a rebinding host: this call (the only one that should
        # ever happen) returns a safe address. A buggy implementation that
        # re-resolves by name for the real connection would get an UNSAFE
        # address on any subsequent call — asserting len(calls) == 1 below
        # proves that second call never happens.
        return [(2, 1, 6, "", ("93.184.216.34", 0))]

    monkeypatch.setattr(media_tools.socket, "getaddrinfo", fake_getaddrinfo)

    seen_requests = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen_requests.append(request)
        return httpx.Response(
            200, headers={"content-type": "image/png"}, content=b"\x89PNG\r\n\x1a\nfake-but-short"
        )

    mock_transport = httpx.MockTransport(handler)
    monkeypatch.setattr(
        media_tools.httpx, "AsyncClient", functools.partial(httpx.AsyncClient, transport=mock_transport)
    )

    result = asyncio.run(
        media_tools.render_web_media.coroutine(
            url="https://example.com/pic.png", tool_call_id="test-call-id"
        )
    )

    assert len(calls) == 1, "getaddrinfo must be called exactly once — a second call reopens the TOCTOU"
    assert len(seen_requests) == 1
    sent = seen_requests[0]
    assert sent.url.host == "93.184.216.34"  # connected to the PINNED ip, not re-resolved by name
    assert sent.headers["host"] == "example.com"  # Host header still the original hostname
    assert sent.extensions.get("sni_hostname") == "example.com"  # TLS SNI/cert check also correct
    # A downsample failure (fake bytes aren't a real PNG) is expected and
    # fine here — this test is about the connection target, not the image
    # pipeline, which the success-path test below exercises separately.
    content = result.update["messages"][0].content
    assert "example.com" not in content or "could not be read as an image" in content


def _no_op_dispatch(monkeypatch) -> None:
    """Lets a tool reach a real, successful Command return without needing
    a real LangGraph run context — see module docstring. Patched at its
    source (assistant.a2ui, where dispatch_surface actually calls it),
    since media_tools.py only imports dispatch_surface itself, not the
    adispatch_custom_event name."""

    async def _fake_dispatch(*_args, **_kwargs) -> None:
        return None

    monkeypatch.setattr(a2ui, "adispatch_custom_event", _fake_dispatch)


def _real_png_bytes(size: tuple[int, int] = (4, 4)) -> bytes:
    buf = BytesIO()
    Image.new("RGB", size, color=(200, 50, 50)).save(buf, format="PNG")
    return buf.getvalue()


# --- render_local_media ------------------------------------------------


def test_render_local_media_refuses_credential_path() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        target = Path(tmp) / "id_rsa"
        target.write_bytes(_real_png_bytes())  # extension doesn't matter, name does
        result = asyncio.run(
            media_tools.render_local_media.coroutine(path=str(target), tool_call_id="t")
        )
        content = result.update["messages"][0].content
        assert "credential" in content.lower()


def test_render_local_media_refuses_unsupported_extension() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        target = Path(tmp) / "notes.txt"
        target.write_text("just text")
        result = asyncio.run(
            media_tools.render_local_media.coroutine(path=str(target), tool_call_id="t")
        )
        content = result.update["messages"][0].content
        assert "unsupported extension" in content.lower()


def test_render_local_media_refuses_video_over_the_size_cap() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        target = Path(tmp) / "clip.mp4"
        target.write_bytes(b"\x00" * (media_tools._MAX_LOCAL_VIDEO_BYTES + 1))
        result = asyncio.run(
            media_tools.render_local_media.coroutine(path=str(target), tool_call_id="t")
        )
        content = result.update["messages"][0].content
        assert "too large" in content.lower()


def test_render_local_media_renders_a_real_image(monkeypatch) -> None:
    _no_op_dispatch(monkeypatch)
    with tempfile.TemporaryDirectory() as tmp:
        target = Path(tmp) / "photo.png"
        target.write_bytes(_real_png_bytes())
        result = asyncio.run(
            media_tools.render_local_media.coroutine(path=str(target), tool_call_id="t")
        )
        msg = result.update["messages"][0]
        assert "rejected" not in msg.content.lower()
        assert a2ui.A2UI_SURFACE_KEY in (msg.additional_kwargs or {})


# --- render_web_media ----------------------------------------------------


def _mock_client_returning(monkeypatch, *, status: int = 200, headers: dict, content: bytes) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(status, headers=headers, content=content)

    monkeypatch.setattr(media_tools.socket, "getaddrinfo", lambda host, port: [(2, 1, 6, "", ("93.184.216.34", 0))])
    monkeypatch.setattr(
        media_tools.httpx,
        "AsyncClient",
        functools.partial(httpx.AsyncClient, transport=httpx.MockTransport(handler)),
    )


def test_render_web_media_refuses_non_http_scheme() -> None:
    result = asyncio.run(
        media_tools.render_web_media.coroutine(url="file:///etc/passwd", tool_call_id="t")
    )
    content = result.update["messages"][0].content
    assert "only http/https" in content.lower()


def test_render_web_media_does_not_follow_redirects(monkeypatch) -> None:
    _mock_client_returning(
        monkeypatch, status=302, headers={"location": "https://evil.example/"}, content=b""
    )
    result = asyncio.run(
        media_tools.render_web_media.coroutine(url="https://example.com/pic.png", tool_call_id="t")
    )
    content = result.update["messages"][0].content
    assert "redirect" in content.lower()


def test_render_web_media_refuses_non_image_video_content_type(monkeypatch) -> None:
    """Content-type spoofing defense: a URL that claims to be an image but
    actually serves something else (e.g. text/html, or an attacker trying
    to smuggle a different payload) must be refused, not rendered."""
    _mock_client_returning(
        monkeypatch, headers={"content-type": "text/html"}, content=b"<html>not media</html>"
    )
    result = asyncio.run(
        media_tools.render_web_media.coroutine(url="https://example.com/pic.png", tool_call_id="t")
    )
    content = result.update["messages"][0].content
    assert "not an image or video" in content.lower()


def test_render_web_media_refuses_response_over_the_fetch_cap(monkeypatch) -> None:
    oversized = b"\x00" * (media_tools._MAX_FETCH_BYTES + 1)
    _mock_client_returning(monkeypatch, headers={"content-type": "image/png"}, content=oversized)
    result = asyncio.run(
        media_tools.render_web_media.coroutine(url="https://example.com/pic.png", tool_call_id="t")
    )
    content = result.update["messages"][0].content
    assert "exceeds" in content.lower() and "fetch cap" in content.lower()


def test_render_web_media_reports_connection_errors_cleanly(monkeypatch) -> None:
    """A real network failure (DNS/connect/timeout) must come back as a
    normal rejection message, never an unhandled exception reaching the
    model's tool-call loop."""

    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused", request=request)

    monkeypatch.setattr(media_tools.socket, "getaddrinfo", lambda host, port: [(2, 1, 6, "", ("93.184.216.34", 0))])
    monkeypatch.setattr(
        media_tools.httpx, "AsyncClient", functools.partial(httpx.AsyncClient, transport=httpx.MockTransport(handler))
    )

    result = asyncio.run(
        media_tools.render_web_media.coroutine(url="https://example.com/pic.png", tool_call_id="t")
    )
    content = result.update["messages"][0].content
    assert "fetch failed" in content.lower()


def test_render_web_media_renders_a_real_fetched_image(monkeypatch) -> None:
    _no_op_dispatch(monkeypatch)
    _mock_client_returning(monkeypatch, headers={"content-type": "image/png"}, content=_real_png_bytes())
    result = asyncio.run(
        media_tools.render_web_media.coroutine(url="https://example.com/pic.png", tool_call_id="t")
    )
    msg = result.update["messages"][0]
    assert "rejected" not in msg.content.lower()
    assert a2ui.A2UI_SURFACE_KEY in (msg.additional_kwargs or {})
