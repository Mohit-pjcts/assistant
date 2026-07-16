"""CLI entry point: runs the chat loop against the agent."""

from __future__ import annotations

import argparse
import asyncio

# Loaded before any other import — assistant.sub_agents/assistant.supervisor
# construct ChatAnthropic instances and assistant.tools constructs a
# TavilySearch instance, all at module import time, so the environment must
# already be populated by then.
from dotenv import load_dotenv

load_dotenv()

from langgraph.types import Command  # noqa: E402

from assistant import observability, thread_store  # noqa: E402
from assistant.agent import make_thread_config  # noqa: E402
from assistant.interrupts import send_test_notification  # noqa: E402
from assistant.mcp_tools import load_mcp_tools  # noqa: E402
from assistant.memory import get_checkpointer  # noqa: E402
from assistant.supervisor import build_graph  # noqa: E402

EXIT_COMMANDS = {"exit", "quit"}

# Phase 15: full thread management (list/rename/switch/create) lives in the
# GUI's History panel — the only surface that can actually show a picker.
# The CLI gets exactly these three in-session commands instead (PLAN.md
# Phase 15's scope-split decision, STEPS.md 66); anything else typed with a
# leading "/" is just a normal message to the assistant, not a command.
_THREAD_COMMANDS = {"/new", "/threads", "/switch"}


def _render_content(content: object) -> str:
    """Render an AIMessage's content as plain text.

    Normally a plain string, but LangChain's content type is technically
    `str | list[str | dict]` — guard against ever printing a raw Python repr
    if a response is ever returned as a list of content blocks.
    """
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for block in content:
            if isinstance(block, str):
                parts.append(block)
            elif isinstance(block, dict) and block.get("type") == "text":
                parts.append(block.get("text", ""))
        return "\n".join(part for part in parts if part)
    return str(content)


async def _handle_thread_command(command: str, thread_id: str) -> str:
    """Handle a recognized /new, /threads, or /switch command. Always
    returns the (possibly unchanged) thread_id the caller should now be
    using — callers rebuild their invocation config from this rather than
    inspecting any side state."""
    parts = command.split(maxsplit=1)
    name = parts[0].lower()

    if name == "/new":
        thread = await thread_store.create_thread()
        print(f"[thread] started a new conversation ({thread.id})")
        return thread.id

    if name == "/threads":
        threads = await thread_store.list_threads()
        for t in threads:
            marker = "*" if t.id == thread_id else " "
            label = t.title or t.id
            print(f"{marker} {label}  ({t.id})")
        return thread_id

    if name == "/switch":
        if len(parts) < 2 or not parts[1].strip():
            print("[thread] usage: /switch <thread_id>  (see /threads for ids)")
            return thread_id
        target = parts[1].strip()
        try:
            thread = await thread_store.set_active_thread(target)
        except KeyError:
            print(f"[thread] no thread with id {target!r} — see /threads for valid ids")
            return thread_id
        print(f"[thread] switched to {thread.title or thread.id}")
        return thread.id

    # Unreachable given _THREAD_COMMANDS gates the call site, but keeps this
    # function's contract honest if that ever changes.
    return thread_id


async def _run(start_new: bool) -> None:
    """Run the interactive CLI chat loop.

    start_new: begin on a brand-new thread (thread_store.create_thread())
    instead of continuing whatever thread_store's active pointer currently
    points at — the CLI's `--new` flag.
    """
    print(
        "Personal assistant. Type 'exit' or 'quit' to leave (Ctrl+C / Ctrl+D also work). "
        "'/new' starts a fresh conversation, '/threads' lists them, '/switch <id>' switches."
    )

    try:
        mcp_tools = await load_mcp_tools()
    except Exception as exc:  # e.g. GMAIL_MCP_SERVER_PATH unset, server not built
        print(f"[warning] Gmail/Calendar tools unavailable: {type(exc).__name__}: {exc}")
        mcp_tools = []

    async with get_checkpointer() as checkpointer:
        graph = build_graph(checkpointer, [send_test_notification], mcp_tools)

        if start_new:
            thread = await thread_store.create_thread()
            thread_id = thread.id
            print(f"[thread] started a new conversation ({thread_id})")
        else:
            thread_id = await thread_store.get_active_thread_id()
        config = make_thread_config(thread_id)

        while True:
            try:
                user_input = input("\nYou: ").strip()

                if not user_input:
                    continue
                if user_input.lower() in EXIT_COMMANDS:
                    break
                if user_input.split(maxsplit=1)[0].lower() in _THREAD_COMMANDS:
                    thread_id = await _handle_thread_command(user_input, thread_id)
                    config = make_thread_config(thread_id)
                    continue

                result = await graph.ainvoke(
                    {"messages": [("user", user_input)]},
                    config=config,
                )

                # A tool (e.g. interrupts.send_test_notification) paused the
                # graph for confirmation — CLAUDE.md's standing rule for
                # side-effectful actions. Loop in case a resumed turn hits a
                # second interrupt.
                while "__interrupt__" in result:
                    payload = result["__interrupt__"][0].value
                    approved = input(f"\n[confirm] {payload} Proceed? (y/n): ").strip().lower() == "y"
                    result = await graph.ainvoke(Command(resume=approved), config=config)
                    # Evaluations pillar (STEPS.md 82): log the real
                    # approve/decline outcome as a Langfuse score. Fired as
                    # a background task, never awaited — scoring must never
                    # add latency to the response the user is waiting on.
                    action = payload.get("action") if isinstance(payload, dict) else None
                    asyncio.create_task(observability.score_gate_outcome(thread_id, approved, action))

                final_message = result["messages"][-1]
                print(f"\nAssistant: {_render_content(final_message.content)}")
                await thread_store.touch_thread(thread_id)

            except (EOFError, KeyboardInterrupt):
                break
            except Exception as exc:  # network errors, rate limits, etc.
                print(f"\n[error] {type(exc).__name__}: {exc}")
                continue

    print("\nGoodbye.")


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Personal assistant CLI.")
    parser.add_argument(
        "--new",
        action="store_true",
        help="Start a brand-new conversation thread instead of continuing the active one.",
    )
    return parser.parse_args()


def main() -> None:
    """Sync entry point (required by the `assistant` console script) that
    drives the async chat loop."""
    # Must run before observability's lazy handler is first constructed
    # (i.e. before the first make_thread_config() call) — tags are
    # constructor-bound in Langfuse v2, not per-call overridable. Set here
    # rather than at module level: voice_daemon.py imports _render_content
    # from this module, which must NOT have the side effect of claiming
    # "cli" as the client identity for a process that is actually voice.
    observability.configure_client("cli")
    args = _parse_args()
    try:
        asyncio.run(_run(start_new=args.new))
    except KeyboardInterrupt:
        # SIGINT delivered while the event loop itself (not our coroutine) is
        # on the stack — e.g. between input() returning and ainvoke() being
        # scheduled — surfaces here instead of _run()'s try/except. Same
        # clean-exit behavior either way.
        print("\nGoodbye.")


if __name__ == "__main__":
    main()
