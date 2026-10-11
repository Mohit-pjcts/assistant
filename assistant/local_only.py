"""Loopback-only guard for the endpoints that expose the most (STEPS.md 158).

The History endpoints return full tool inputs and outputs (email bodies, file
contents, shell output) and Stage's own logs, which carry screen contents. The
backend has no authentication and binds 0.0.0.0 — deliberately, so the iPhone
channel can reach it — so those endpoints can't rely on "only I can reach this
port". The dashboard that reads them runs on this Mac, and the iPhone never
needs them, so they answer only to this computer: 403 to anyone else. Every
other endpoint keeps the access it always had.

Two checks, both required:

1. **The client's address is loopback** (127.0.0.1 / ::1, including the
   IPv4-mapped form). FastAPI's in-process `TestClient` reports its client as
   the literal host "testclient" — no network is involved, so that passes too.
2. **The Host header names this computer** (127.0.0.1 / localhost / ::1). The
   address alone isn't enough: a reverse proxy on this Mac (`tailscale serve`,
   a tunnel) connects from 127.0.0.1 on behalf of a remote caller, and a web
   page can make the browser send requests to 127.0.0.1 under its own
   hostname ("DNS rebinding"). Both arrive with a foreign Host. `stage/src/
   localonly.ts` makes the same check for the same reason.

The in-process test client skips (2): it has no network path to rebind.
"""

from __future__ import annotations

import ipaddress

from fastapi import HTTPException, Request

LOCAL_HOST_NAMES = frozenset({"127.0.0.1", "localhost", "::1"})
TEST_CLIENT_HOST = "testclient"


def _is_loopback_address(host: str | None) -> bool:
    if host is None:
        return False
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:  # a hostname or a unix-socket path, not an address
        return False


def is_local_request(request: Request) -> bool:
    """True when the request came from this computer, by the two checks in the
    module docstring."""
    client_host = request.client.host if request.client else None
    if client_host == TEST_CLIENT_HOST:
        return True
    if not _is_loopback_address(client_host):
        return False
    # `url.hostname` is the Host header without its port or IPv6 brackets,
    # lowercased; with no Host header Starlette falls back to the socket's.
    return (request.url.hostname or "") in LOCAL_HOST_NAMES


def require_local_client(request: Request) -> None:
    """FastAPI dependency: 403 unless the request came from this computer.
    Attach it per route (`dependencies=[Depends(require_local_client)]`) or to
    a whole router."""
    if not is_local_request(request):
        raise HTTPException(status_code=403, detail="History is only available on this Mac.")
