"""List the top-level keys each gated action's `interrupt({...})` payload carries.

The iPhone app draws a confirmation card from a per-action layout
(ios/OniCore/Sources/OniCore/Mac/Gate.swift). Those layouts were written from
this code, so they can drift when a tool gains a field. This scans every
`interrupt(<dict literal>)` call under assistant/ and writes
{action: [keys...]} for the Swift tests (GateLayoutDriftTests) to check the
layouts against. Run with --write to refresh the fixture, no flag to check it.

A payload built any other way (a spread, a function result) fails the script,
so it cannot silently escape the check.
"""

from __future__ import annotations

import ast
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
# An `interrupt()` whose "action" is not a string constant: the supervisor's upfront
# confirmation, which carries the action it is asking about.
DYNAMIC = "<dynamic action>"
FIXTURE = ROOT / "ios/OniCore/Tests/OniCoreTests/Fixtures/gate_payload_keys.json"


def _enclosing_function(tree: ast.AST, target: ast.AST) -> ast.AST:
    """The innermost function containing `target` (or the module)."""
    best: ast.AST = tree
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            if any(child is target for child in ast.walk(node)):
                best = node  # ast.walk is outermost-first, so the last hit is innermost
    return best


def _resolve_dict(tree: ast.AST, call: ast.Call) -> tuple[ast.Dict | None, set[str]]:
    """The payload dict literal, following `payload = {...}` (and later
    `payload["k"] = ...`) when the call passes a variable."""
    arg = call.args[0]
    if isinstance(arg, ast.Dict):
        return arg, set()
    if not isinstance(arg, ast.Name):
        return None, set()
    scope = _enclosing_function(tree, call)
    literal: ast.Dict | None = None
    extra: set[str] = set()
    for node in ast.walk(scope):
        if isinstance(node, ast.Assign) and len(node.targets) == 1:
            t = node.targets[0]
            if isinstance(t, ast.Name) and t.id == arg.id and isinstance(node.value, ast.Dict):
                literal = node.value
            if (
                isinstance(t, ast.Subscript) and isinstance(t.value, ast.Name) and t.value.id == arg.id
                and isinstance(t.slice, ast.Constant) and isinstance(t.slice.value, str)
            ):
                extra.add(t.slice.value)
    return literal, extra


def extract() -> dict[str, list[str]]:
    found: dict[str, set[str]] = {}
    unresolved: list[str] = []
    for path in sorted((ROOT / "assistant").glob("*.py")):
        tree = ast.parse(path.read_text())
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            func = node.func
            name = func.id if isinstance(func, ast.Name) else getattr(func, "attr", None)
            if name != "interrupt" or not node.args:
                continue
            where = f"{path.name}:{node.lineno}"
            payload, extra = _resolve_dict(tree, node)
            if payload is None or any(k is None for k in payload.keys):
                unresolved.append(where)
                continue
            keys = {k.value for k in payload.keys if isinstance(k, ast.Constant) and isinstance(k.value, str)} | extra
            action = DYNAMIC
            for k, v in zip(payload.keys, payload.values):
                if isinstance(k, ast.Constant) and k.value == "action" and isinstance(v, ast.Constant):
                    action = v.value
            found.setdefault(action, set()).update(keys)
    if unresolved:
        print("unresolved interrupt() payloads (not a dict literal or a variable assigned one):", file=sys.stderr)
        for where in unresolved:
            print("  " + where, file=sys.stderr)
        sys.exit(1)
    return {action: sorted(keys) for action, keys in sorted(found.items())}


if __name__ == "__main__":
    keys = extract()
    text = json.dumps(keys, indent=2) + "\n"
    if "--write" in sys.argv:
        FIXTURE.parent.mkdir(parents=True, exist_ok=True)
        FIXTURE.write_text(text)
        print(f"wrote {FIXTURE.relative_to(ROOT)} ({len(keys)} actions)")
    else:
        print(text, end="")
