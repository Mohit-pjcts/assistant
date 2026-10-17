"""Serves the REAL /vault router (assistant/vault_sync.py) over a throwaway
copy of the Vault, for OniCore's integration tests. Never touches the real
Vault or the real .vault_token: both are redirected before the app starts.

usage: serve_temp_vault.py <vault_copy_dir> <token_file> <port>
"""

from __future__ import annotations

import sys
from pathlib import Path

import uvicorn
from fastapi import FastAPI

from assistant import obsidian_tools, vault_sync

vault_dir, token_file, port = Path(sys.argv[1]), Path(sys.argv[2]), int(sys.argv[3])
obsidian_tools.VAULT_DIR = vault_dir
vault_sync.TOKEN_PATH = token_file

app = FastAPI()
app.include_router(vault_sync.router)
uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")
