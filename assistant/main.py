"""CLI entry point: runs the chat loop against the agent."""

from __future__ import annotations

import asyncio

# Loaded before any other import — assistant.agent constructs a ChatAnthropic
# instance and assistant.tools constructs a TavilySearch instance, both at
# module import time, so the environment must already be populated by then.
from dotenv import load_dotenv

load_dotenv()

from assistant.agent import build_agent, make_thread_config  # noqa: E402
from assistant.mcp_tools import load_mcp_tools  # noqa: E402
from assistant.memory import get_checkpointer  # noqa: E402
from assistant.tools import TOOLS  # noqa: E402

# Fixed rather than generated per run: this is what makes conversation memory
# actually observable across separate launches of the CLI, not just within a
# single process. Revisit once there's a reason to support multiple threads.
THREAD_ID = "cli-default-thread"

EXIT_COMMANDS = {"exit", "quit"}


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


async def _run() -> None:
    """Run the interactive CLI chat loop."""
    print("Personal assistant. Type 'exit' or 'quit' to leave (Ctrl+C / Ctrl+D also work).")

    try:
        mcp_tools = await load_mcp_tools()
    except Exception as exc:  # e.g. GMAIL_MCP_SERVER_PATH unset, server not built
        print(f"[warning] Gmail tools unavailable: {type(exc).__name__}: {exc}")
        mcp_tools = []

    async with get_checkpointer() as checkpointer:
        graph = build_agent(checkpointer, tools=TOOLS + mcp_tools)
        config = make_thread_config(THREAD_ID)

        while True:
            try:
                user_input = input("\nYou: ").strip()

                if not user_input:
                    continue
                if user_input.lower() in EXIT_COMMANDS:
                    break

                result = await graph.ainvoke(
                    {"messages": [("user", user_input)]},
                    config=config,
                )
                final_message = result["messages"][-1]
                print(f"\nAssistant: {_render_content(final_message.content)}")

            except (EOFError, KeyboardInterrupt):
                break
            except Exception as exc:  # network errors, rate limits, etc.
                print(f"\n[error] {type(exc).__name__}: {exc}")
                continue

    print("\nGoodbye.")


def main() -> None:
    """Sync entry point (required by the `assistant` console script) that
    drives the async chat loop."""
    try:
        asyncio.run(_run())
    except KeyboardInterrupt:
        # SIGINT delivered while the event loop itself (not our coroutine) is
        # on the stack — e.g. between input() returning and ainvoke() being
        # scheduled — surfaces here instead of _run()'s try/except. Same
        # clean-exit behavior either way.
        print("\nGoodbye.")


if __name__ == "__main__":
    main()
