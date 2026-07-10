"""Tool definitions: web search, file read/write, shell execution.

These are client-executed LangChain tools that sit behind the same tool node
as any model output — including text the model derived from untrusted
sources (search results, file contents). Treat everything the model passes
as tool input as potentially adversarial: the shell tool never invokes a
shell interpreter, and the file tools are confined to a workspace directory
that structurally excludes the project's secrets and git metadata.
"""

from __future__ import annotations

import shlex
import subprocess
from pathlib import Path

from dotenv import load_dotenv
from langchain_core.tools import tool
from langchain_tavily import TavilySearch

# Loaded here (not just in main.py) so this module doesn't depend on import
# order — TavilySearch below reads TAVILY_API_KEY from the environment at
# construction time, and this module can be imported directly (e.g. by tests)
# without going through main.py first. load_dotenv() is idempotent and won't
# override already-set env vars.
load_dotenv()

# Anchored to the project root (this file's grandparent), not the process's
# current working directory — so the workspace is the same regardless of
# where `assistant` happens to be invoked from.
WORKSPACE_DIR = Path(__file__).resolve().parent.parent / "workspace"


def ensure_workspace_dir() -> Path:
    """Create the workspace directory if needed and return its resolved path."""
    WORKSPACE_DIR.mkdir(parents=True, exist_ok=True)
    return WORKSPACE_DIR.resolve()


def _resolve_in_workspace(path: str) -> Path:
    """Resolve a tool-supplied path against the workspace dir, rejecting escapes.

    Raises ValueError if `path` is absolute, resolves outside the workspace
    directory (e.g. via '..'), or touches a dotfile/dotdir at any level
    (e.g. .env, .git) — the dotfile check is independent of the containment
    check, so a dotfile that happens to live inside the workspace is still
    blocked.
    """
    if Path(path).is_absolute():
        raise ValueError(f"'{path}' must be a relative path")

    workspace_root = ensure_workspace_dir()
    candidate = (workspace_root / path).resolve()

    try:
        relative = candidate.relative_to(workspace_root)
    except ValueError:
        raise ValueError(f"'{path}' escapes the workspace directory") from None

    if any(part.startswith(".") for part in relative.parts):
        raise ValueError(f"'{path}' targets a dotfile, which is not allowed")

    return candidate


# --- File tools --------------------------------------------------------


@tool
def read_file(path: str) -> str:
    """Read a text file from the workspace directory.

    Args:
        path: Path relative to the workspace directory.
    """
    try:
        resolved = _resolve_in_workspace(path)
    except ValueError as exc:
        return f"Error: {exc}"

    if not resolved.exists():
        return f"Error: '{path}' does not exist"
    if not resolved.is_file():
        return f"Error: '{path}' is not a file"

    try:
        return resolved.read_text()
    except UnicodeDecodeError:
        return f"Error: '{path}' is not a text file"


@tool
def write_file(path: str, content: str) -> str:
    """Write text content to a file in the workspace directory.

    Creates the file (and any parent directories) if they don't exist, and
    overwrites the file if it does.

    Args:
        path: Path relative to the workspace directory.
        content: Text content to write.
    """
    try:
        resolved = _resolve_in_workspace(path)
    except ValueError as exc:
        return f"Error: {exc}"

    resolved.parent.mkdir(parents=True, exist_ok=True)
    resolved.write_text(content)
    return f"Wrote {len(content)} characters to '{path}'"


# --- Shell tool ----------------------------------------------------------

# Destructive commands, blocked outright regardless of arguments.
_DENIED_EXECUTABLES = {"rm", "sudo", "su"}

# Shell interpreters — invoking one with "-c" would run its argument as a
# full shell script, defeating the argument-list execution model below.
_SHELL_EXECUTABLES = {"bash", "sh", "zsh", "csh", "tcsh", "ksh", "dash"}

# Substrings (not exact tokens) because shlex.split() doesn't treat these as
# delimiters by default — "ls&&rm -rf ~" parses to a single token "ls&&rm".
_SHELL_METACHARACTERS = ("|", "&&", ";", "`", "$(")

_SENSITIVE_PATH_PREFIXES = (
    "/etc",
    "/usr",
    "/bin",
    "/sbin",
    "/System",
    "/Library",
    "/private",
    "/var",
    "/Applications",
    "/root",
)


def _denial_reason(argv: list[str]) -> str | None:
    """Return why `argv` is blocked, or None if it's allowed to run.

    Denies, in order: rm/sudo/su directly; a shell interpreter invoked with
    -c (the back door around argument-list execution); shell metacharacters
    anywhere in any argument (pipes, chaining, substitution — inert under
    shell=False, but rejected explicitly rather than silently mangled);
    any argument referencing a sensitive system path; and piping a download
    tool into a shell interpreter.
    """
    if not argv:
        return "empty command"

    executable = Path(argv[0]).name

    if executable in _DENIED_EXECUTABLES:
        return f"'{executable}' is not allowed (destructive command)"

    if executable in _SHELL_EXECUTABLES and "-c" in argv:
        return f"invoking '{executable} -c' is not allowed (bypasses argument-list execution)"

    for token in argv:
        if any(meta in token for meta in _SHELL_METACHARACTERS):
            return "shell metacharacters (pipes, chaining, substitution) are not allowed"
        if any(sensitive in token for sensitive in _SENSITIVE_PATH_PREFIXES):
            return f"'{token}' targets a system path, which is not allowed"

    if executable in {"curl", "wget"} and any(
        Path(tok).name in _SHELL_EXECUTABLES for tok in argv
    ):
        return "piping a download into a shell interpreter is not allowed"

    return None


@tool
def execute_shell_command(command: str, timeout_seconds: int = 30) -> str:
    """Run a shell command in the workspace directory and return its output.

    The command is parsed into an argument list and run directly — no shell
    interpreter is ever invoked — and destructive patterns (rm, sudo, shell
    chaining/piping, redirects to system paths) are blocked before execution.

    Args:
        command: The command to run, e.g. "ls -la" or "git status".
        timeout_seconds: Max seconds to allow the command to run before it's killed.
    """
    try:
        argv = shlex.split(command)
    except ValueError as exc:
        return f"Error: could not parse command: {exc}"

    reason = _denial_reason(argv)
    if reason is not None:
        return f"Error: command blocked — {reason}"

    workspace_root = ensure_workspace_dir()

    try:
        result = subprocess.run(
            argv,
            shell=False,
            cwd=workspace_root,
            capture_output=True,
            text=True,
            timeout=timeout_seconds,
        )
    except FileNotFoundError:
        return f"Error: command not found: '{argv[0]}'"
    except subprocess.TimeoutExpired:
        return f"Error: command timed out after {timeout_seconds}s"

    output = result.stdout
    if result.stderr:
        output += f"\n[stderr]\n{result.stderr}"
    if result.returncode != 0:
        output += f"\n[exit code: {result.returncode}]"

    return output or "(no output)"


# --- Web search tool -------------------------------------------------------

web_search = TavilySearch(max_results=5)

TOOLS = [read_file, write_file, execute_shell_command, web_search]
