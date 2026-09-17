"""Tests for assistant.media_tools — minimal, scoped to the SSRF DNS-
rebinding TOCTOU fix in render_web_media (bug backlog item #2). Full
media_tools.py coverage (every reject path, both size caps) is a separate,
not-yet-done task — see CLAUDE.md's Phase 26 status entry.
"""

import functools

import httpx

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

    import asyncio

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
    # pipeline, which #15's separate future coverage would exercise.
    content = result.update["messages"][0].content
    assert "example.com" not in content or "could not be read as an image" in content
