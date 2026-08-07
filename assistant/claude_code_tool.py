"""Delegates coding_agent's actual coding/file/shell work to a real, nested
Claude Code CLI session, instead of coding_agent doing that work itself with
its own hand-rolled read_file/write_file/execute_shell_command tools.

**Deliberately full-access, at the user's explicit direct request (2026-08-06)
— this is a real weakening of this project's security model, not an
oversight.** The nested session runs non-interactively (`claude --print`),
rooted at the user's HOME directory (not workspace/), with
`--dangerously-skip-permissions` — every one of Claude Code's own
permission prompts is bypassed, because a `subprocess.run()` call has no
way to answer one anyway (it would just hang forever on stdin). This means
run_claude_code can read, write, or delete anything reachable from $HOME,
and run any shell command, with none of tools.py's/disk_tools.py's own
denylists, workspace confinement, or interrupt() gates in the path — those
protections apply to THIS project's own tools, not to a separate Claude
Code process it shells out to.

**Billed against the user's Claude.ai subscription, not this project's
pay-per-token Console API key (2026-08-06, verified live via `claude auth
status`).** The main assistant's own model calls (ChatAnthropic in
supervisor.py/sub_agents.py) always bill Console pay-per-token — the plain
Messages API has no subscription-billing path, confirmed against current
Anthropic docs. Claude Code CLI is different: it supports signing in with
a Claude.ai account and billing against that subscription's included
usage, but ONLY when `ANTHROPIC_API_KEY` isn't present in its environment
— an API key always wins Claude Code's own auth precedence and forces
Console billing instead (confirmed live: `claude auth status` flips from
`authMethod: "claude.ai"/subscriptionType: "team"` to
`apiKeySource: "ANTHROPIC_API_KEY"` the moment that env var is set). Since
this project's own backend process calls `load_dotenv()` and would
otherwise pass its own `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` straight
through via `subprocess.run()`'s default environment inheritance, both are
explicitly stripped from the child's environment below so the nested
session falls back to its already-logged-in Claude.ai session instead.

Suggested follow-up hardening (not implemented — flagged for a future,
explicit decision, same pattern as disk_tools.py's own module docstring):
  - Drop --dangerously-skip-permissions in favor of --permission-mode
    acceptEdits/plan plus --allowedTools, so at least destructive
    operations (rm, git push, etc.) still need a human in the loop.
  - Run inside a disposable container/VM or a scratch git worktree instead
    of the real $HOME, so a runaway or injected task can't touch real
    files.
  - Route this tool through the same interrupt()-gated confirmation this
    project uses for every other side-effectful action (CLAUDE.md's
    Security model section) — right now it is the one exception.
  - Cap spend with --max-budget-usd, since this spins up a second, fully
    agentic Claude session on top of coding_agent's own model call.
  - Scope with --add-dir to a narrower directory than all of $HOME once a
    real use case shows the extra room isn't needed.
"""

from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

from langchain_core.tools import tool

_HOME = Path.home()
_DEFAULT_TIMEOUT_SECONDS = 1800

# Resolved once at import time via PATH; falls back to the path observed on
# this machine (~/.local/bin/claude) in case this process's own PATH (e.g.
# under launchd/Tauri) doesn't include it even though an interactive shell's
# does.
_CLAUDE_BIN = shutil.which("claude") or str(_HOME / ".local" / "bin" / "claude")

# Both outrank Claude Code's own Claude.ai OAuth login in its auth
# precedence — present, they force Console pay-per-token billing even
# though a `claude auth login` session is active. Stripped from the child
# process's environment (not this process's own os.environ) so the nested
# session bills the subscription instead.
_KEYS_TO_STRIP = ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN")


def _subscription_env() -> dict:
    env = dict(os.environ)
    for key in _KEYS_TO_STRIP:
        env.pop(key, None)
    return env


@tool
def run_claude_code(prompt: str, timeout_seconds: int = _DEFAULT_TIMEOUT_SECONDS) -> str:
    """Delegate a coding/file/shell task to a real, separate Claude Code
    session instead of doing the work yourself. The session runs
    non-interactively in the user's home directory with full read/write/
    shell access and none of your own tool restrictions — it can create,
    edit, and delete files and run arbitrary commands anywhere under the
    home directory. Prefer this over your own file/shell tools for actual
    coding work (writing or editing code, running a build/test, exploring
    an unfamiliar project) — it is a full agentic coding session, not a
    single command, so give it a complete, self-contained task description
    since it has no memory of this conversation.

    Args:
        prompt: The task to hand to Claude Code, with enough detail for a
            fresh session with no other context to act on directly.
        timeout_seconds: Max seconds to allow the session to run before
            it's killed (default 30 minutes — real coding tasks can take a
            while).
    """
    argv = [
        _CLAUDE_BIN,
        "--print",
        "--dangerously-skip-permissions",
        "--output-format",
        "text",
        prompt,
    ]
    try:
        result = subprocess.run(
            argv,
            shell=False,
            cwd=_HOME,
            env=_subscription_env(),
            capture_output=True,
            text=True,
            timeout=timeout_seconds,
        )
    except FileNotFoundError:
        return f"Error: 'claude' CLI not found (looked for it at '{_CLAUDE_BIN}')"
    except subprocess.TimeoutExpired:
        return f"Error: claude code session timed out after {timeout_seconds}s"

    output = result.stdout
    if result.stderr:
        output += f"\n[stderr]\n{result.stderr}"
    if result.returncode != 0:
        output += f"\n[exit code: {result.returncode}]"
    return output or "(no output)"


def build_claude_code_tools() -> list:
    return [run_claude_code]
