"""A2UI generative-UI surfaces (Phase 17, PLAN.md).

Lets an agent present a rich, structured UI in the dashboard — cards, lists,
comparisons — instead of only prose, using a constrained subset of Google's
A2UI v0.9 declarative component vocabulary (https://github.com/google/A2UI).

**Security posture — this is a DISPLAY channel, never a side-effect channel.**
`render_ui` (below) cannot execute anything: it validates a component tree,
forwards it to the dashboard for rendering via `adispatch_custom_event`
(the same mechanism `supervisor.py`'s `research_agent_proxy` already uses to
stream tokens across a process boundary — proven live to surface through
`astream_events()`), and returns a Command carrying a ToolMessage whose
`.content` is a short text summary the model keeps talking from. Every real
side effect in this project (send email, calendar write, Mac control,
memory write) still happens exclusively through the existing gated
wrappers in `write_tools.py`/`mac_tools.py`/`memory_extraction.py`, each
calling `interrupt()` itself and shown verbatim — none of that is touched
or bypassed here. The interactive extension below (buttons/forms whose
input feeds back to the agent) is still just an INPUT to the agent,
resolved by the SAME unmodified gates; see PLAN.md's Phase 17 entry for
the full reasoning, not repeated here.

**Persistence (Phase 18, PLAN.md).** Phase 17 made the live render
ephemeral — a reload only ever saw `_summarize_surface`'s text. Phase 18
additionally stashes the FULL validated surface in that same ToolMessage's
`additional_kwargs[A2UI_SURFACE_KEY]` — a side channel the model itself
never sees (only `.content` is sent back to the API, same reasoning as
`supervisor.py`'s `_GATED_ACTION_APPROVED_KEY` marker), but which
`server.py`'s `/history` reads back so a reload can re-render the same UI
instead of only the text summary. The live SSE `adispatch_custom_event`
path is unchanged and still the fast path during an active stream; this is
purely an additional, independent way to retrieve the same tree later.

**Scope (Phase 18, PLAN.md).** `render_ui` is no longer supervisor-only —
`research_agent` and `life_admin_agent` also carry it (sub_agents.py),
since they're the ones actually holding structured data worth rendering.
See `build_render_ui_tool`'s own docstring below for the live verification
this rested on before extending it.

**Validation is defense-in-depth, not the security boundary above.**
`validate_surface` rejects anything outside a small, explicitly enumerated
component/field allowlist before a tree ever reaches the client — matches
this project's "errors are data, not exceptions" rule (CLAUDE.md): a
rejected surface returns as a normal tool result string, never raises into
the graph. v1 scope deliberately excludes Modal/Tabs/Video/AudioPlayer/
Slider/DateTimeInput, and remote `Image` URLs (only `data:` URIs pass,
closing an easy tracking/exfiltration vector).

**Part B — interactive components (TextField/CheckBox/ChoicePicker/Button)
still cannot perform any action.** A `Button`'s `action` field is
structurally constrained to EXACTLY `{"name": <string>}` — no
`functionCall`, no embedded tool-call-shaped payload, nothing else is a
valid key on that dict (`_validate_component_fields` enforces this with a
strict `set(action) != {"name"}` check, not a "looks safe" heuristic). All
it can ever do is label which submission this was; the actual submitted
values (whatever the client-side renderer collected from that surface's
TextField/CheckBox/ChoicePicker local state) travel separately as
`POST /a2ui/action`'s `context` field, and server.py turns that into a
PLAIN, ordinary user turn — see server.py's `a2ui_action` endpoint
docstring for why that's the safe design (real user input, not tool
content; no new path to a side effect, since whatever the agent decides to
do about it still goes through the unmodified gated tools/interrupt()).
"""

from __future__ import annotations

import json
from typing import Annotated, Any

from langchain_core.callbacks import adispatch_custom_event
from langchain_core.messages import ToolMessage
from langchain_core.tools import BaseTool, InjectedToolCallId, tool
from langgraph.types import Command

MAX_COMPONENTS = 50
MAX_SURFACE_CHARS = 20_000

# additional_kwargs marker key on a ToolMessage, carrying a LIST of full
# validated surfaces (not just _summarize_surface's text) — a plain list,
# always, even where exactly one surface is involved, so render_ui's own
# ToolMessage and supervisor.py's call_specialist forwarding (which may
# collect several from one delegated specialist run) share one shape. See
# this module's docstring, "Persistence (Phase 18)". server.py's /history
# reads this directly.
A2UI_SURFACE_KEY = "a2ui_surface"

# Per-type field allowlist: {"required": {...}, "optional": {...}}. "id" and
# "component" are implicitly allowed on every type. Any field not listed
# here is rejected outright — this is what keeps a future `action` field
# (or anything else outside this deliberately small v1 vocabulary) from
# silently riding through on some component type nobody thought to check.
COMPONENT_SCHEMA: dict[str, dict[str, set[str]]] = {
    "Text": {"required": {"text"}, "optional": set()},
    "Badge": {"required": {"text"}, "optional": set()},
    "Divider": {"required": set(), "optional": {"axis"}},
    "Image": {"required": {"url"}, "optional": {"alt"}},
    "Column": {"required": {"children"}, "optional": set()},
    "Row": {"required": {"children"}, "optional": set()},
    "List": {"required": {"children"}, "optional": set()},
    "Card": {"required": {"child"}, "optional": set()},
    # Part B — interactive. "path" is the key under which the renderer's
    # LOCAL (client-only) data model stores this field's current value; it
    # is never resolved against a server-side data model in v1 (no such
    # thing exists), only echoed back verbatim as a key in
    # POST /a2ui/action's `context` when a Button on the same surface fires.
    "TextField": {"required": {"label", "path"}, "optional": {"value"}},
    "CheckBox": {"required": {"label", "path"}, "optional": {"value"}},
    "ChoicePicker": {"required": {"label", "path", "options"}, "optional": {"variant"}},
    # `action` is intentionally NOT in COMPONENT_SCHEMA's normal Dynamic*/
    # str/list validation path below — see _validate_component_fields for
    # why it gets its own strict, closed-shape check.
    "Button": {"required": {"text", "action"}, "optional": set()},
}

INTERACTIVE_COMPONENTS = {"TextField", "CheckBox", "ChoicePicker", "Button"}


def _is_dynamic_string(value: object) -> bool:
    """A2UI's DynamicString: a literal string, or {"path": <str>} bound
    against the surface's data model. v1 renders literals directly; a
    `path` value is accepted structurally (for forward-compat with a later
    interactive Part) but there is no server-side data model to resolve it
    against yet, so authors should prefer literals today."""
    if isinstance(value, str):
        return True
    return isinstance(value, dict) and set(value) == {"path"} and isinstance(value["path"], str)


def _validate_component_fields(comp_id: str, comp_type: str, comp: dict[str, Any], by_id: dict[str, dict]) -> None:
    if comp_type in ("Text", "Badge"):
        if not _is_dynamic_string(comp["text"]):
            raise ValueError(f"component {comp_id!r}.text must be a string or {{'path': str}}")
    elif comp_type == "Image":
        url = comp["url"]
        if not _is_dynamic_string(url):
            raise ValueError(f"component {comp_id!r}.url must be a string or {{'path': str}}")
        if isinstance(url, str) and not url.startswith("data:"):
            raise ValueError(
                f"component {comp_id!r}: Image.url must be a data: URI — no remote "
                "image allowlist exists in v1"
            )
        if "alt" in comp and not isinstance(comp["alt"], str):
            raise ValueError(f"component {comp_id!r}.alt must be a string")
    elif comp_type == "Divider":
        axis = comp.get("axis", "horizontal")
        if axis not in ("horizontal", "vertical"):
            raise ValueError(f"component {comp_id!r}.axis must be 'horizontal' or 'vertical'")
    elif comp_type in ("Column", "Row", "List"):
        children = comp["children"]
        if not isinstance(children, list) or not children or not all(isinstance(c, str) for c in children):
            raise ValueError(f"component {comp_id!r}.children must be a non-empty list of component ids")
        for child_id in children:
            if child_id not in by_id:
                raise ValueError(f"component {comp_id!r} references unknown child id {child_id!r}")
    elif comp_type == "Card":
        child = comp["child"]
        if not isinstance(child, str) or child not in by_id:
            raise ValueError(f"component {comp_id!r}.child must reference a known component id")
    elif comp_type in ("TextField", "CheckBox", "ChoicePicker"):
        if not isinstance(comp["label"], str) or not comp["label"]:
            raise ValueError(f"component {comp_id!r}.label must be a non-empty string")
        if not isinstance(comp["path"], str) or not comp["path"]:
            raise ValueError(f"component {comp_id!r}.path must be a non-empty string")
        if comp_type == "TextField" and "value" in comp and not isinstance(comp["value"], str):
            raise ValueError(f"component {comp_id!r}.value must be a string")
        if comp_type == "CheckBox" and "value" in comp and not isinstance(comp["value"], bool):
            raise ValueError(f"component {comp_id!r}.value must be a boolean")
        if comp_type == "ChoicePicker":
            options = comp["options"]
            if not isinstance(options, list) or not options or not all(
                isinstance(o, str) and o for o in options
            ):
                raise ValueError(f"component {comp_id!r}.options must be a non-empty list of non-empty strings")
            variant = comp.get("variant", "mutuallyExclusive")
            if variant not in ("mutuallyExclusive", "multiSelect"):
                raise ValueError(
                    f"component {comp_id!r}.variant must be 'mutuallyExclusive' or 'multiSelect'"
                )
    elif comp_type == "Button":
        if not _is_dynamic_string(comp["text"]):
            raise ValueError(f"component {comp_id!r}.text must be a string or {{'path': str}}")
        action = comp["action"]
        # Deliberately strict, not just "has a name": this is the one field
        # in the whole v1 vocabulary that could theoretically carry an
        # executable-shaped payload if it were left open — closing it to
        # EXACTLY {"name": <non-empty str>} is the actual security boundary
        # for interactive surfaces, not a style preference. See this
        # module's docstring.
        if (
            not isinstance(action, dict)
            or set(action) != {"name"}
            or not isinstance(action.get("name"), str)
            or not action["name"]
        ):
            raise ValueError(
                f"component {comp_id!r}.action must be exactly {{'name': <non-empty string>}} — "
                "no other keys are permitted (no functionCall, no nested payload)"
            )


def validate_surface(surface: Any) -> None:
    """Raise ValueError on the first structural or vocabulary violation;
    return None (no exception) when `surface` is safe to forward as-is.
    Callers (render_ui below) turn a raised ValueError into a normal tool
    result string — this function itself never needs to be defensive about
    how it's called, only about what it accepts."""
    if not isinstance(surface, dict):
        raise ValueError("surface must be a JSON object")
    if len(json.dumps(surface)) > MAX_SURFACE_CHARS:
        raise ValueError(f"surface exceeds the {MAX_SURFACE_CHARS}-character limit")

    surface_id = surface.get("surfaceId")
    if not isinstance(surface_id, str) or not surface_id:
        raise ValueError("surface.surfaceId must be a non-empty string")

    components = surface.get("components")
    if not isinstance(components, list) or not components:
        raise ValueError("surface.components must be a non-empty list")
    if len(components) > MAX_COMPONENTS:
        raise ValueError(f"surface.components exceeds the {MAX_COMPONENTS}-component limit")

    by_id: dict[str, dict] = {}
    for comp in components:
        if not isinstance(comp, dict):
            raise ValueError("each component must be a JSON object")
        comp_id = comp.get("id")
        comp_type = comp.get("component")
        if not isinstance(comp_id, str) or not comp_id:
            raise ValueError("every component needs a non-empty string 'id'")
        if comp_id in by_id:
            raise ValueError(f"duplicate component id: {comp_id!r}")
        if comp_type not in COMPONENT_SCHEMA:
            raise ValueError(
                f"unsupported component type {comp_type!r} on {comp_id!r}; "
                f"supported: {sorted(COMPONENT_SCHEMA)}"
            )
        by_id[comp_id] = comp

    if "root" not in by_id:
        raise ValueError("surface.components must include a component with id 'root'")

    for comp_id, comp in by_id.items():
        comp_type = comp["component"]
        schema = COMPONENT_SCHEMA[comp_type]
        allowed = schema["required"] | schema["optional"] | {"id", "component"}
        unknown = set(comp) - allowed
        if unknown:
            raise ValueError(f"component {comp_id!r} ({comp_type}) has unsupported field(s): {sorted(unknown)}")
        missing = schema["required"] - set(comp)
        if missing:
            raise ValueError(f"component {comp_id!r} ({comp_type}) is missing required field(s): {sorted(missing)}")
        _validate_component_fields(comp_id, comp_type, comp, by_id)


def _summarize_surface(surface: dict[str, Any]) -> str:
    """The text the MODEL sees on its next turn (a ToolMessage's `.content`
    — additional_kwargs, where the full tree also now rides per
    A2UI_SURFACE_KEY below, is never sent back to the API). Keeping the
    model's own view of what it just rendered short and deterministic
    avoids re-feeding a large component tree into context on every
    subsequent turn — see this module's docstring for the full split
    between what the model sees and what a client can retrieve."""
    components = surface["components"]
    texts = [
        c["text"] for c in components if c.get("component") in ("Text", "Badge") and isinstance(c.get("text"), str)
    ]
    kinds = sorted({c["component"] for c in components})
    preview = "; ".join(texts[:3])
    suffix = "…" if len(texts) > 3 else ""
    detail = f" — {preview}{suffix}" if preview else ""
    interactive = " (interactive)" if any(c.get("component") in INTERACTIVE_COMPONENTS for c in components) else ""
    return f"[UI presented{interactive}: {len(components)} component(s) ({', '.join(kinds)}){detail}]"


def build_render_ui_tool() -> BaseTool:
    """Builds a fresh `render_ui` tool instance — called once per agent that
    carries it, same as every other per-agent tool factory in this project.

    **Phase 17 (v1): supervisor-only.** The custom-event channel this tool
    depends on (`adispatch_custom_event`) was only proven, live, at the
    supervisor's own graph level.

    **Phase 18: extended to `research_agent` and `life_admin_agent`**
    (PLAN.md) — the two specialists that actually hold structured data worth
    rendering (search results/comparisons; Gmail/Calendar reads), unlike the
    supervisor, which only ever sees a specialist's own prose summary and
    would have to reconstruct a card from it. Verified live before wiring
    in for real (not assumed safe just because the code compiles): under
    the agents-as-tools architecture (supervisor.py's module docstring,
    STEPS.md 94) a specialist is invoked via a bare `await
    other_graph.ainvoke(...)` from inside the supervisor's OWN tool
    function — one level of nesting deeper than `research_fa_token`'s
    proof (STEPS.md 84), which dispatches directly from a tool function,
    not from a further-nested graph's own ToolNode. `adispatch_custom_event`
    resolves the ambient run via a contextvar-propagated `RunnableConfig`
    (`ensure_config()`), which LangChain's own `Runnable.ainvoke()` machinery
    re-threads at every nested call boundary regardless of whether the
    caller passes an explicit `config` — the same mechanism that already
    lets `on_chat_model_stream` events from a specialist's OWN model calls
    surface through the OUTER graph's `astream_events()` today (server.py's
    `_stream_turn` doesn't filter by which node/run a token came from).
    Confirmed with a real end-to-end test directing the supervisor to
    delegate to research_agent, which then calls render_ui itself
    (tests/test_a2ui.py) — not just reasoned from the mechanism. NOT
    extended to `coding_agent` (output is code/files, not naturally
    card-shaped) or `mac_control_agent` (mostly action confirmations) —
    a deliberate scope decision, revisit if that stops holding."""

    @tool
    async def render_ui(
        surface: dict[str, Any],
        tool_call_id: Annotated[str, InjectedToolCallId],
    ) -> Command:
        """Render a rich UI surface in the dashboard alongside your reply,
        for structured, comparative, or list-shaped content that would be
        awkward as prose (e.g. a set of calendar events, a comparison, a
        short list of options). Don't use this for every reply — plain text
        is still correct for simple answers. Has no effect outside the
        dashboard (CLI/voice ignore it silently).

        `surface` is a JSON object: {"surfaceId": <unique string>,
        "components": [<component>, ...]}. Exactly one component must have
        id "root" — that's where rendering starts. Every other component
        must be reachable from root via a Column/Row/List's "children"
        (a list of ids) or a Card's "child" (a single id) — no orphans.

        Supported component types (nothing outside this list is accepted):
        - Text:        {"id", "component": "Text", "text": <string>}
        - Badge:       {"id", "component": "Badge", "text": <string>}
        - Divider:     {"id", "component": "Divider", "axis"?: "horizontal"|"vertical"}
        - Image:       {"id", "component": "Image", "url": <a "data:" URI —
                        no remote URLs>, "alt"?: <string>}
        - Column:      {"id", "component": "Column", "children": [<id>, ...]}
        - Row:         {"id", "component": "Row", "children": [<id>, ...]}
        - List:        {"id", "component": "List", "children": [<id>, ...]}
        - Card:        {"id", "component": "Card", "child": <id>}
        - TextField:   {"id", "component": "TextField", "label": <string>,
                        "path": <string — a unique key for this field's
                        value>, "value"?: <string, initial value>}
        - CheckBox:    {"id", "component": "CheckBox", "label": <string>,
                        "path": <string>, "value"?: <bool>}
        - ChoicePicker: {"id", "component": "ChoicePicker", "label": <string>,
                        "path": <string>, "options": [<string>, ...],
                        "variant"?: "mutuallyExclusive"|"multiSelect"}
        - Button:      {"id", "component": "Button", "text": <string>,
                        "action": {"name": <string>}} — clicking it sends
                        every TextField/CheckBox/ChoicePicker value
                        currently on this SAME surface back to you as a new
                        user turn (see below). "action" may ONLY contain
                        "name" — nothing else.

        Example — a small card with a title and two badges:
        {"surfaceId": "s1", "components": [
          {"id": "root", "component": "Card", "child": "col"},
          {"id": "col", "component": "Column", "children": ["title", "row"]},
          {"id": "title", "component": "Text", "text": "Today"},
          {"id": "row", "component": "Row", "children": ["b1", "b2"]},
          {"id": "b1", "component": "Badge", "text": "3 meetings"},
          {"id": "b2", "component": "Badge", "text": "1 unread"}]}

        Example — a small form:
        {"surfaceId": "s2", "components": [
          {"id": "root", "component": "Column", "children": ["name", "go"]},
          {"id": "name", "component": "TextField", "label": "Guest name", "path": "/name"},
          {"id": "go", "component": "Button", "text": "RSVP", "action": {"name": "rsvp"}}]}
        When the user fills this in and clicks RSVP, you will receive a new
        ordinary user message reporting the "rsvp" action and the value
        they typed under "/name" — respond to it exactly like any other
        request (including, if it needs one, using whatever tool actually
        performs the action, whose own confirmation gate still applies as
        usual).

        This is otherwise DISPLAY ONLY. No component can perform an action
        by itself or substitute for a confirmation gate — a Button only
        ever reports data back to you as a new turn; if THAT turn needs a
        side-effectful action, use the normal gated tool for it as usual,
        and its own interrupt() gate still applies exactly as if render_ui
        had never been called.
        """
        try:
            validate_surface(surface)
        except ValueError as exc:
            return Command(
                update={
                    "messages": [
                        ToolMessage(
                            content=f"render_ui rejected this surface: {exc}",
                            tool_call_id=tool_call_id,
                        )
                    ]
                }
            )
        await adispatch_custom_event("a2ui_surface", surface)
        return Command(
            update={
                "messages": [
                    ToolMessage(
                        content=_summarize_surface(surface),
                        tool_call_id=tool_call_id,
                        # The FULL validated tree, not just the text
                        # summary above — additional_kwargs never reaches
                        # the model (only .content does), so this rides
                        # alongside purely for retrieval. Always a LIST
                        # (of one, here) for a uniform shape with
                        # supervisor.py's call_specialist, which forwards
                        # possibly-several surfaces a delegated specialist
                        # rendered during its own isolated run. server.py's
                        # /history reads it back to let a reload re-render
                        # the same surface(s) instead of only ever showing
                        # the text summary (Phase 18, PLAN.md).
                        additional_kwargs={A2UI_SURFACE_KEY: [surface]},
                    )
                ]
            }
        )

    return render_ui
