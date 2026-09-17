"""A2UI generative-UI surfaces (Phase 17, PLAN.md).

Lets an agent present a rich, structured UI in the dashboard — cards, lists,
comparisons — using Google's real A2UI v0.9 "Basic Catalog" component
vocabulary (https://github.com/google/A2UI, specification/v0_9/catalogs/
basic/catalog.json). Full parity pass: all 18 real catalog component types
(Text/Image/Icon/Video/AudioPlayer/Row/Column/List/Card/Tabs/Modal/Divider/
Button/TextField/CheckBox/ChoicePicker/Slider/DateTimeInput), field names
matching the real spec exactly (not our earlier ad-hoc shapes) — this
supersedes the earlier "constrained subset" (Text/Badge/Divider/Image/
Column/Row/List/Card/TextField/CheckBox/ChoicePicker/Button, with our own
simplified field names) that shipped through Phase 17/18. `Badge` is kept
as one deliberate LOCAL addition — it does NOT exist in the real catalog,
documented on its own COMPONENT_SCHEMA entry below.

**Deliberately still NOT built, scope cuts made explicit rather than
silently guessed at:**
- The real catalog's `functions` layer (required/regex/length/numeric/
  email/formatString/formatNumber/formatCurrency/formatDate/pluralize/
  openUrl/and/or/not) — client-side expression evaluation inside
  DynamicString/DynamicNumber bindings and TextField validation. A
  genuinely separate feature (an expression engine), not a component.
- `ChildList`'s "template object" form (generate children from a data-list
  at render time, i.e. a repeater/loop) — only the plain array-of-ids form
  is supported, matching what render_ui/render_form have always produced.
- `Icon.name`'s raw `{"svgPath": <string>}` form — deliberately excluded on
  security grounds (agent-supplied raw SVG path data is a rendering-
  injection vector this project's "reject, don't sanitize" posture doesn't
  want to open); only the fixed icon-name enum or a data-bound path is
  accepted.
- `DateTimeInput`/`Slider`'s `min`/`max` date-format validation (the real
  spec's oneOf date/time/date-time format constraint) — accepted as plain
  strings/numbers, not format-validated.

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

**Data binding.** Any `DynamicString`/`DynamicNumber`/`DynamicBoolean`/
`DynamicStringList` field accepts either a literal value, or
`{"path": <string>}` bound against the surface's own `dataModel` (a flat,
string-keyed dict — see validate_surface). This is how a component
displays data the MODEL never typed out itself — e.g. board_tools.py's
render_board_ui binds each task's title/priority to a path, with the real
values supplied entirely by board_store.py's own fetched data. A `path`
with no matching key in `dataModel` (or no `dataModel` at all) simply
renders as empty — not an error.

**Validation is defense-in-depth, not the security boundary above.**
`validate_surface` rejects anything outside a small, explicitly enumerated
component/field allowlist before a tree ever reaches the client — matches
this project's "errors are data, not exceptions" rule (CLAUDE.md): a
rejected surface returns as a normal tool result string, never raises into
the graph.

**Interactive components (TextField/CheckBox/ChoicePicker/Button/Slider/
DateTimeInput) still cannot perform any action.** A `Button`'s `action`
field is structurally constrained to EXACTLY `{"name": <string>}` — no
`functionCall`, no embedded tool-call-shaped payload, nothing else is a
valid key on that dict (`_validate_component_fields` enforces this with a
strict `set(action) != {"name"}` check, not a "looks safe" heuristic). All
it can ever do is label which submission this was; the actual submitted
values (whatever the client-side renderer collected from that surface's
interactive components' local state) travel separately as
`POST /a2ui/action`'s `context` field, and server.py turns that into a
PLAIN, ordinary user turn — see server.py's `a2ui_action` endpoint
docstring for why that's the safe design (real user input, not tool
content; no new path to a side effect, since whatever the agent decides to
do about it still goes through the unmodified gated tools/interrupt()).
"""

from __future__ import annotations

import json
import uuid
from typing import Annotated, Any

from langchain_core.callbacks import adispatch_custom_event
from langchain_core.messages import ToolMessage
from langchain_core.tools import BaseTool, InjectedToolCallId, tool
from langgraph.types import Command

MAX_COMPONENTS = 80
# 20_000 was sized for model-authored surfaces only. media_tools.py's
# render_local_media/render_web_media embed real image/video bytes as a
# base64 data: URI — even a downsampled (1568px long edge) JPEG comfortably
# runs past 20_000 chars, so a cap sized for hand-typed JSON would reject
# every real embed. Raised to fit a downsampled image or a capped-size
# video (media_tools.py's own _MAX_LOCAL_VIDEO_BYTES) with headroom, while
# still being a real ceiling — this isn't unlimited.
MAX_SURFACE_CHARS = 6_000_000

# additional_kwargs marker key on a ToolMessage, carrying a LIST of full
# validated surfaces (not just _summarize_surface's text) — a plain list,
# always, even where exactly one surface is involved, so render_ui's own
# ToolMessage and supervisor.py's call_specialist forwarding (which may
# collect several from one delegated specialist run) share one shape. See
# this module's docstring, "Persistence (Phase 18)". server.py's /history
# reads this directly.
A2UI_SURFACE_KEY = "a2ui_surface"

# Real A2UI v0.9 Basic Catalog icon names (catalogs/basic/catalog.json's
# Icon.name enum) — the only names Icon accepts as a literal string.
ICON_NAMES: frozenset[str] = frozenset({
    "accountCircle", "add", "arrowBack", "arrowForward", "attachFile", "calendarToday", "call", "camera",
    "check", "close", "delete", "download", "edit", "event", "error", "fastForward", "favorite", "favoriteOff",
    "folder", "help", "home", "info", "locationOn", "lock", "lockOpen", "mail", "menu", "moreVert", "moreHoriz",
    "notificationsOff", "notifications", "pause", "payment", "person", "phone", "photo", "play", "print",
    "refresh", "rewind", "search", "send", "settings", "share", "shoppingCart", "skipNext", "skipPrevious",
    "star", "starHalf", "starOff", "stop", "upload", "visibility", "visibilityOff", "volumeDown", "volumeMute",
    "volumeOff", "volumeUp", "warning",
})

# Per-type field allowlist: {"required": {...}, "optional": {...}}. "id",
# "component", and "weight" are implicitly allowed on every type (weight
# mirrors the real catalog's CatalogComponentCommon — flex-grow within a
# Row/Column). Field names below match the real basic catalog exactly,
# component-for-component, EXCEPT Badge (see its own note). Any field not
# listed here is rejected outright.
COMPONENT_SCHEMA: dict[str, dict[str, set[str]]] = {
    "Text": {"required": {"text"}, "optional": {"variant"}},
    "Image": {"required": {"url"}, "optional": {"description", "fit", "variant"}},
    "Icon": {"required": {"name"}, "optional": set()},
    "Video": {"required": {"url"}, "optional": set()},
    "AudioPlayer": {"required": {"url"}, "optional": {"description"}},
    "Row": {"required": {"children"}, "optional": {"justify", "align"}},
    "Column": {"required": {"children"}, "optional": {"justify", "align"}},
    "List": {"required": {"children"}, "optional": {"direction", "align"}},
    "Card": {"required": {"child"}, "optional": set()},
    "Tabs": {"required": {"tabs"}, "optional": set()},
    "Modal": {"required": {"trigger", "content"}, "optional": set()},
    "Divider": {"required": set(), "optional": {"axis"}},
    "Button": {"required": {"child", "action"}, "optional": {"variant", "checked"}},
    "TextField": {"required": {"label"}, "optional": {"value", "variant", "validationRegexp", "checked"}},
    "CheckBox": {"required": {"label", "value"}, "optional": {"checked"}},
    "ChoicePicker": {
        "required": {"options", "value"},
        "optional": {"label", "variant", "displayStyle", "filterable", "checked"},
    },
    "Slider": {"required": {"value", "max"}, "optional": {"label", "min", "checked"}},
    "DateTimeInput": {
        "required": {"value"},
        "optional": {"enableDate", "enableTime", "min", "max", "label", "checked"},
    },
    # NOT in the real A2UI basic catalog — a local addition kept for compact
    # tag-shaped text (counts, priorities, statuses), predating this full-
    # parity pass and still used by board_tools.py's render_board_ui. Kept
    # deliberately rather than removed: working, in active use, no real-spec
    # equivalent to migrate it to (Text with a "caption" variant is close
    # but isn't visually a pill/tag).
    "Badge": {"required": {"text"}, "optional": set()},
}

INTERACTIVE_COMPONENTS = {"TextField", "CheckBox", "ChoicePicker", "Button", "Slider", "DateTimeInput"}

_TEXT_VARIANTS = {"h1", "h2", "h3", "h4", "h5", "caption", "body"}
_IMAGE_FITS = {"contain", "cover", "fill", "none", "scaleDown"}
_IMAGE_VARIANTS = {"icon", "avatar", "smallFeature", "mediumFeature", "largeFeature", "header"}
_ROW_COLUMN_JUSTIFY = {"center", "end", "spaceAround", "spaceBetween", "spaceEvenly", "start", "stretch"}
_ALIGN = {"start", "center", "end", "stretch"}
_LIST_DIRECTIONS = {"vertical", "horizontal"}
_BUTTON_VARIANTS = {"default", "primary", "borderless"}
_TEXTFIELD_VARIANTS = {"longText", "number", "shortText", "obscured"}
_CHOICEPICKER_VARIANTS = {"multipleSelection", "mutuallyExclusive"}
_CHOICEPICKER_DISPLAY_STYLES = {"checkbox", "chips"}


def _is_dynamic_string(value: object) -> bool:
    """A2UI's DynamicString: a literal string, or {"path": <str>}."""
    if isinstance(value, str):
        return True
    return isinstance(value, dict) and set(value) == {"path"} and isinstance(value["path"], str)


def _is_dynamic_number(value: object) -> bool:
    """A2UI's DynamicNumber: a literal number (not bool — bool is a subtype
    of int in Python, explicitly excluded), or {"path": <str>}."""
    if isinstance(value, bool):
        return False
    if isinstance(value, (int, float)):
        return True
    return isinstance(value, dict) and set(value) == {"path"} and isinstance(value["path"], str)


def _is_dynamic_boolean(value: object) -> bool:
    """A2UI's DynamicBoolean: a literal bool, or {"path": <str>}."""
    if isinstance(value, bool):
        return True
    return isinstance(value, dict) and set(value) == {"path"} and isinstance(value["path"], str)


def _is_dynamic_string_list(value: object) -> bool:
    """A2UI's DynamicStringList: a literal list of strings, or
    {"path": <str>} — used by ChoicePicker.value (the currently-selected
    values), bound against the surface's dataModel same as any other
    Dynamic* type."""
    if isinstance(value, list):
        return all(isinstance(v, str) for v in value)
    return isinstance(value, dict) and set(value) == {"path"} and isinstance(value["path"], str)


def _check_enum(comp_id: str, comp: dict[str, Any], field: str, allowed: set[str]) -> None:
    if field in comp and comp[field] not in allowed:
        raise ValueError(f"component {comp_id!r}.{field} must be one of {sorted(allowed)}")


def _is_base64_data_uri(url: str) -> bool:
    """Real, live-diagnosed bug: `url.startswith("data:")` alone let a model
    through with `data:image/svg+xml;utf8,<svg ...>` — raw, percent-encoded
    SVG markup rather than base64. That rendered perfectly in Chrome (a
    Chrome browser tab confirmed it, pixel-for-pixel) but the dashboard
    runs inside Tauri's WebKit-based WebView on macOS, a stricter, different
    engine for exactly this pattern (unescaped `<`/`>`/space/quote
    characters in a `;utf8,` data URI) — the actual root cause of a real
    "images don't work" report. `;base64,` is the one encoding every
    engine agrees on, so it's now required, not just a `data:` prefix."""
    if not url.startswith("data:") or "," not in url:
        return False
    header = url.split(",", 1)[0]
    return header.endswith(";base64")


def _validate_component_fields(comp_id: str, comp_type: str, comp: dict[str, Any], by_id: dict[str, dict]) -> None:
    if "weight" in comp and (not isinstance(comp["weight"], (int, float)) or isinstance(comp["weight"], bool)):
        raise ValueError(f"component {comp_id!r}.weight must be a number")
    if "checked" in comp and not _is_dynamic_boolean(comp["checked"]):
        raise ValueError(f"component {comp_id!r}.checked must be a boolean or {{'path': str}}")

    if comp_type in ("Text", "Badge"):
        if not _is_dynamic_string(comp["text"]):
            raise ValueError(f"component {comp_id!r}.text must be a string or {{'path': str}}")
        if comp_type == "Text":
            _check_enum(comp_id, comp, "variant", _TEXT_VARIANTS)
    elif comp_type == "Image":
        url = comp["url"]
        if not _is_dynamic_string(url):
            raise ValueError(f"component {comp_id!r}.url must be a string or {{'path': str}}")
        if isinstance(url, str) and not _is_base64_data_uri(url):
            raise ValueError(
                f"component {comp_id!r}: Image.url must be a base64 data: URI "
                "(e.g. 'data:image/png;base64,...') — no remote URLs, and non-base64 forms "
                "like 'data:image/svg+xml;utf8,<svg...>' are rejected (a real one rendered fine "
                "in Chrome but is a documented risk on WebKit, the dashboard's own engine)"
            )
        if "description" in comp and not _is_dynamic_string(comp["description"]):
            raise ValueError(f"component {comp_id!r}.description must be a string or {{'path': str}}")
        _check_enum(comp_id, comp, "fit", _IMAGE_FITS)
        _check_enum(comp_id, comp, "variant", _IMAGE_VARIANTS)
    elif comp_type == "Icon":
        name = comp["name"]
        if isinstance(name, str):
            if name not in ICON_NAMES:
                raise ValueError(
                    f"component {comp_id!r}.name {name!r} is not a known icon name; supported: {sorted(ICON_NAMES)}"
                )
        elif not (isinstance(name, dict) and set(name) == {"path"} and isinstance(name["path"], str)):
            raise ValueError(
                f"component {comp_id!r}.name must be a known icon name or {{'path': str}} — "
                "raw svgPath objects are not accepted"
            )
    elif comp_type in ("Video", "AudioPlayer"):
        url = comp["url"]
        if not _is_dynamic_string(url):
            raise ValueError(f"component {comp_id!r}.url must be a string or {{'path': str}}")
        if isinstance(url, str) and not _is_base64_data_uri(url):
            raise ValueError(
                f"component {comp_id!r}: {comp_type}.url must be a base64 data: URI "
                "(e.g. 'data:video/mp4;base64,...') — no remote URLs, and non-base64 forms are rejected"
            )
        if comp_type == "AudioPlayer" and "description" in comp and not _is_dynamic_string(comp["description"]):
            raise ValueError(f"component {comp_id!r}.description must be a string or {{'path': str}}")
    elif comp_type in ("Column", "Row", "List"):
        children = comp["children"]
        if not isinstance(children, list) or not children or not all(isinstance(c, str) for c in children):
            raise ValueError(f"component {comp_id!r}.children must be a non-empty list of component ids")
        for child_id in children:
            if child_id not in by_id:
                raise ValueError(f"component {comp_id!r} references unknown child id {child_id!r}")
        if comp_type == "List":
            _check_enum(comp_id, comp, "direction", _LIST_DIRECTIONS)
        else:
            _check_enum(comp_id, comp, "justify", _ROW_COLUMN_JUSTIFY)
        _check_enum(comp_id, comp, "align", _ALIGN)
    elif comp_type == "Card":
        child = comp["child"]
        if not isinstance(child, str) or child not in by_id:
            raise ValueError(f"component {comp_id!r}.child must reference a known component id")
    elif comp_type == "Tabs":
        tabs = comp["tabs"]
        if not isinstance(tabs, list) or not tabs:
            raise ValueError(f"component {comp_id!r}.tabs must be a non-empty list")
        for i, t in enumerate(tabs):
            if not isinstance(t, dict) or set(t) != {"title", "child"}:
                raise ValueError(f"component {comp_id!r}.tabs[{i}] must be exactly {{'title', 'child'}}")
            if not _is_dynamic_string(t["title"]):
                raise ValueError(f"component {comp_id!r}.tabs[{i}].title must be a string or {{'path': str}}")
            if not isinstance(t["child"], str) or t["child"] not in by_id:
                raise ValueError(f"component {comp_id!r}.tabs[{i}].child must reference a known component id")
    elif comp_type == "Modal":
        for field in ("trigger", "content"):
            ref = comp[field]
            if not isinstance(ref, str) or ref not in by_id:
                raise ValueError(f"component {comp_id!r}.{field} must reference a known component id")
    elif comp_type == "Divider":
        _check_enum(comp_id, comp, "axis", {"horizontal", "vertical"})
    elif comp_type == "Button":
        child = comp["child"]
        if not isinstance(child, str) or child not in by_id:
            raise ValueError(f"component {comp_id!r}.child must reference a known component id")
        _check_enum(comp_id, comp, "variant", _BUTTON_VARIANTS)
        action = comp["action"]
        # Deliberately strict, not just "has a name": this is the one field
        # in the whole vocabulary that could theoretically carry an
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
    elif comp_type == "TextField":
        if not _is_dynamic_string(comp["label"]):
            raise ValueError(f"component {comp_id!r}.label must be a string or {{'path': str}}")
        if "value" in comp and not _is_dynamic_string(comp["value"]):
            raise ValueError(f"component {comp_id!r}.value must be a string or {{'path': str}}")
        _check_enum(comp_id, comp, "variant", _TEXTFIELD_VARIANTS)
        if "validationRegexp" in comp and not isinstance(comp["validationRegexp"], str):
            raise ValueError(f"component {comp_id!r}.validationRegexp must be a string")
    elif comp_type == "CheckBox":
        if not _is_dynamic_string(comp["label"]):
            raise ValueError(f"component {comp_id!r}.label must be a string or {{'path': str}}")
        if not _is_dynamic_boolean(comp["value"]):
            raise ValueError(f"component {comp_id!r}.value must be a boolean or {{'path': str}}")
    elif comp_type == "ChoicePicker":
        if "label" in comp and not _is_dynamic_string(comp["label"]):
            raise ValueError(f"component {comp_id!r}.label must be a string or {{'path': str}}")
        options = comp["options"]
        if not isinstance(options, list) or not options:
            raise ValueError(f"component {comp_id!r}.options must be a non-empty list")
        for i, opt in enumerate(options):
            if not isinstance(opt, dict) or set(opt) != {"label", "value"}:
                raise ValueError(f"component {comp_id!r}.options[{i}] must be exactly {{'label', 'value'}}")
            if not _is_dynamic_string(opt["label"]):
                raise ValueError(f"component {comp_id!r}.options[{i}].label must be a string or {{'path': str}}")
            if not isinstance(opt["value"], str) or not opt["value"]:
                raise ValueError(f"component {comp_id!r}.options[{i}].value must be a non-empty string")
        if not _is_dynamic_string_list(comp["value"]):
            raise ValueError(f"component {comp_id!r}.value must be a list of strings or {{'path': str}}")
        _check_enum(comp_id, comp, "variant", _CHOICEPICKER_VARIANTS)
        _check_enum(comp_id, comp, "displayStyle", _CHOICEPICKER_DISPLAY_STYLES)
        if "filterable" in comp and not isinstance(comp["filterable"], bool):
            raise ValueError(f"component {comp_id!r}.filterable must be a boolean")
    elif comp_type == "Slider":
        if not _is_dynamic_number(comp["value"]):
            raise ValueError(f"component {comp_id!r}.value must be a number or {{'path': str}}")
        if not isinstance(comp["max"], (int, float)) or isinstance(comp["max"], bool):
            raise ValueError(f"component {comp_id!r}.max must be a number")
        if "min" in comp and (not isinstance(comp["min"], (int, float)) or isinstance(comp["min"], bool)):
            raise ValueError(f"component {comp_id!r}.min must be a number")
        if "label" in comp and not _is_dynamic_string(comp["label"]):
            raise ValueError(f"component {comp_id!r}.label must be a string or {{'path': str}}")
    elif comp_type == "DateTimeInput":
        if not _is_dynamic_string(comp["value"]):
            raise ValueError(f"component {comp_id!r}.value must be a string or {{'path': str}}")
        for field in ("enableDate", "enableTime"):
            if field in comp and not isinstance(comp[field], bool):
                raise ValueError(f"component {comp_id!r}.{field} must be a boolean")
        for field in ("min", "max", "label"):
            if field in comp and not _is_dynamic_string(comp[field]):
                raise ValueError(f"component {comp_id!r}.{field} must be a string or {{'path': str}}")


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

    if "dataModel" in surface:
        data_model = surface["dataModel"]
        if not isinstance(data_model, dict):
            raise ValueError("surface.dataModel must be a JSON object if present")
        for key, value in data_model.items():
            if not isinstance(key, str) or not key:
                raise ValueError("surface.dataModel keys must be non-empty strings")
            valid = (
                isinstance(value, (str, bool))
                or (isinstance(value, (int, float)) and not isinstance(value, bool))
                or (isinstance(value, list) and all(isinstance(v, str) for v in value))
            )
            if not valid:
                raise ValueError(
                    f"surface.dataModel[{key!r}] must be a string, boolean, number, or list of strings, "
                    f"got {type(value).__name__}"
                )

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
        allowed = schema["required"] | schema["optional"] | {"id", "component", "weight"}
        unknown = set(comp) - allowed
        if unknown:
            raise ValueError(f"component {comp_id!r} ({comp_type}) has unsupported field(s): {sorted(unknown)}")
        missing = schema["required"] - set(comp)
        if missing:
            raise ValueError(f"component {comp_id!r} ({comp_type}) is missing required field(s): {sorted(missing)}")
        _validate_component_fields(comp_id, comp_type, comp, by_id)

    _check_acyclic(by_id)


def _child_ids(comp_type: str, comp: dict) -> list[str]:
    """The child-component-id references a given component type can carry
    — every field already validated as "must reference a known component
    id" by `_validate_component_fields` above. Used only by the cycle
    check below."""
    if comp_type in ("Row", "Column", "List"):
        return [c for c in comp.get("children") or [] if isinstance(c, str)]
    if comp_type in ("Card", "Button"):
        child = comp.get("child")
        return [child] if isinstance(child, str) else []
    if comp_type == "Tabs":
        return [
            t["child"]
            for t in comp.get("tabs") or []
            if isinstance(t, dict) and isinstance(t.get("child"), str)
        ]
    if comp_type == "Modal":
        return [comp[f] for f in ("trigger", "content") if isinstance(comp.get(f), str)]
    return []


def _check_acyclic(by_id: dict[str, dict]) -> None:
    """A component tree is a DAG in general — the SAME leaf id may
    legitimately be referenced as a child from two different parents (e.g.
    one Text reused inside two different Rows) — so a plain "already seen"
    set would wrongly reject that. Only a true back-edge to an ancestor
    still on the current recursion stack (`visiting`) is a real cycle;
    `visited` marks nodes already fully processed so they're never
    re-walked. Recursion depth is bounded by MAX_COMPONENTS, well under
    Python's default recursion limit."""
    visiting: set[str] = set()
    visited: set[str] = set()

    def _dfs(comp_id: str) -> None:
        if comp_id in visited:
            return
        if comp_id in visiting:
            raise ValueError(f"surface.components contains a cycle reachable from {comp_id!r}")
        visiting.add(comp_id)
        comp = by_id[comp_id]
        for child_id in _child_ids(comp["component"], comp):
            if child_id in by_id:
                _dfs(child_id)
        visiting.discard(comp_id)
        visited.add(comp_id)

    _dfs("root")


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


async def dispatch_surface(surface: dict[str, Any], tool_call_id: str, rejection_prefix: str) -> Command:
    """Shared validate-then-dispatch tail: originally render_ui's own tool
    body, factored out so render_form (already an expand-then-validate
    caller) and board_tools.py's render_board_ui (a caller that builds a
    surface from real fetched data, not model-authored args) share the
    exact same validation/dispatch/Command-shape guarantees rather than
    each hand-rolling a copy. `rejection_prefix` names the calling tool in
    the rejection message (e.g. "render_ui rejected this surface") so a
    validation failure is traceable to its actual source."""
    try:
        validate_surface(surface)
    except ValueError as exc:
        return Command(
            update={
                "messages": [
                    ToolMessage(content=f"{rejection_prefix}: {exc}", tool_call_id=tool_call_id)
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
                    additional_kwargs={A2UI_SURFACE_KEY: [surface]},
                )
            ]
        }
    )


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
    a deliberate scope decision, revisit if that stops holding.

    **Full basic-catalog parity pass:** this docstring is necessarily
    longer than v1's 8-component version, since it documents all 18 real
    A2UI component types — a real, ongoing per-call token cost (CLAUDE.md's
    Cost section), traded for actually matching the real spec rather than
    an ad-hoc subset."""

    @tool
    async def render_ui(
        surface: dict[str, Any],
        tool_call_id: Annotated[str, InjectedToolCallId],
    ) -> Command:
        """Render a rich UI surface in the dashboard alongside your reply,
        for structured, comparative, or list-shaped content that would be
        awkward as prose. Don't use this for every reply — plain text is
        still correct for simple answers. Has no effect outside the
        dashboard (CLI/voice ignore it silently). For a simple form
        (labeled fields + a submit button), prefer render_form instead —
        much less structure to author by hand.

        `surface` is a JSON object: {"surfaceId": <unique string>,
        "dataModel"?: {<path>: <string|number|boolean|list[string]>, ...},
        "components": [<component>, ...]}. Exactly one component must have
        id "root". Every other component must be reachable from root via a
        Column/Row/List's "children" (a list of ids) or a Card's "child" /
        Modal's "trigger"/"content" / Tabs' per-tab "child" (a single id) —
        no orphans.

        Any field documented as a "string" below may instead be
        {"path": "/some/key"} to bind against `dataModel` (or leave it a
        literal). Same for "number"/"boolean"/"list[string]" fields.

        Supported component types (nothing outside this list is accepted):
        - Text: {"id","component":"Text","text","variant"?: h1|h2|h3|h4|h5|caption|body}
        - Badge: {"id","component":"Badge","text"} — compact tag/pill, NOT part of the real A2UI spec, a local addition for short labels
        - Image: {"id","component":"Image","url": <MUST be "data:<mime>;base64,<...>" — no remote URLs, and non-base64 data: URIs (e.g. "data:image/svg+xml;utf8,<svg...>") are REJECTED, they render inconsistently across engines>,"description"?,"fit"?: contain|cover|fill|none|scaleDown,"variant"?: icon|avatar|smallFeature|mediumFeature|largeFeature|header}
        - Icon: {"id","component":"Icon","name": <one of a fixed icon-name set, e.g. "add","close","search","star","warning" — ask if you need the full list>}
        - Video: {"id","component":"Video","url": <MUST be "data:<mime>;base64,<...>", same rule as Image>}
        - AudioPlayer: {"id","component":"AudioPlayer","url": <MUST be "data:<mime>;base64,<...>", same rule as Image>,"description"?}
        - Column/Row: {"id","component":"Column"|"Row","children": [<id>,...],"justify"?: start|center|end|spaceBetween|spaceAround|spaceEvenly|stretch,"align"?: start|center|end|stretch}
        - List: {"id","component":"List","children": [<id>,...],"direction"?: vertical|horizontal,"align"?}
        - Card: {"id","component":"Card","child": <id>}
        - Tabs: {"id","component":"Tabs","tabs": [{"title","child": <id>}, ...]} — one tab visible at a time, user switches
        - Modal: {"id","component":"Modal","trigger": <id, e.g. a Button>,"content": <id, shown when trigger is activated>}
        - Divider: {"id","component":"Divider","axis"?: horizontal|vertical}
        - Button: {"id","component":"Button","child": <id — usually a Text, e.g. the label>,"action": {"name": <string>},"variant"?: default|primary|borderless} — clicking it sends every interactive component's current value on this SAME surface back to you as a new user turn. "action" may ONLY contain "name".
        - TextField: {"id","component":"TextField","label","value"?,"variant"?: shortText|longText|number|obscured,"validationRegexp"?}
        - CheckBox: {"id","component":"CheckBox","label","value": <boolean, required>}
        - ChoicePicker: {"id","component":"ChoicePicker","options": [{"label","value": <string>}, ...],"value": <list[string], required>,"label"?,"variant"?: mutuallyExclusive|multipleSelection,"displayStyle"?: checkbox|chips,"filterable"?: bool}
        - Slider: {"id","component":"Slider","value": <number>,"max": <number>,"min"?: <number, default 0>,"label"?}
        - DateTimeInput: {"id","component":"DateTimeInput","value": <ISO 8601 string>,"enableDate"?: bool,"enableTime"?: bool,"min"?,"max"?,"label"?}

        Example — a small card with a title and two badges:
        {"surfaceId": "s1", "components": [
          {"id": "root", "component": "Card", "child": "col"},
          {"id": "col", "component": "Column", "children": ["title", "row"]},
          {"id": "title", "component": "Text", "text": "Today", "variant": "h4"},
          {"id": "row", "component": "Row", "children": ["b1", "b2"]},
          {"id": "b1", "component": "Badge", "text": "3 meetings"},
          {"id": "b2", "component": "Badge", "text": "1 unread"}]}

        Example — a small form with a bound label:
        {"surfaceId": "s2", "dataModel": {"/name": "Alex"}, "components": [
          {"id": "root", "component": "Column", "children": ["name", "go_label", "go"]},
          {"id": "name", "component": "TextField", "label": "Guest name", "value": {"path": "/name"}},
          {"id": "go_label", "component": "Text", "text": "RSVP"},
          {"id": "go", "component": "Button", "child": "go_label", "action": {"name": "rsvp"}}]}
        When the user fills this in and clicks RSVP, you will receive a new
        ordinary user message reporting the "rsvp" action and the value
        typed under "/name" — respond to it exactly like any other request
        (including, if it needs one, using whatever tool actually performs
        the action, whose own confirmation gate still applies as usual).

        This is otherwise DISPLAY ONLY. No component can perform an action
        by itself or substitute for a confirmation gate — a Button only
        ever reports data back to you as a new turn; if THAT turn needs a
        side-effectful action, use the normal gated tool for it as usual,
        and its own interrupt() gate still applies exactly as if render_ui
        had never been called.
        """
        return await dispatch_surface(surface, tool_call_id, "render_ui rejected this surface")

    return render_ui


# ---------------------------------------------------------------------------
# render_form — a small contract layer over render_ui's low-level vocabulary.
# ---------------------------------------------------------------------------
#
# render_ui makes the model hand-assemble a full component graph itself:
# invent an id for every node, wire every Column/Card's children list, get
# Button.action's closed shape exactly right. For the single most common
# interactive shape in practice — "a form with a few labeled fields and a
# submit button" — that's a lot of structural surface area for the model to
# get right on every call, re-derived from scratch each time even though the
# shape itself never varies. render_form gives the model a much smaller
# contract instead (title?, a flat field list, a submit label/action) and
# lets THIS module's own code do the structural assembly — same idea as
# nova-superagent-agent-main's `widget_signal` tool (see .gitignore's note on
# that repo), adapted to this project's stricter validate-then-reject
# posture: the expanded tree is still run through validate_surface() before
# dispatch, so render_form can never produce something render_ui itself
# would have rejected.
#
# render_form's OWN external contract (fields: [{label,path,input,...}]) is
# deliberately UNCHANGED by the full-catalog-parity pass — that contract was
# never meant to mirror the real spec's field names (it's a project-specific
# convenience layer, not part of A2UI itself). What changed is only the
# LOW-LEVEL shape it expands INTO (TextField.value={"path":...} instead of
# a flat "path" field, Button.child=<id> instead of "text").

# Maps a render_form field's "input" to the render_ui component type it
# expands into. Deliberately a small, closed set — anything else is a
# render_form-level rejection, not silently passed through.
_FORM_INPUT_TO_COMPONENT = {
    "text": "TextField",
    "checkbox": "CheckBox",
    "select": "ChoicePicker",
}


def _build_form_surface(
    surface_id: str,
    title: str | None,
    fields: list[dict[str, Any]],
    submit_label: str,
    submit_action: str,
) -> dict[str, Any]:
    """Expand render_form's flat contract into a full render_ui surface.
    Raises ValueError on a malformed field spec — callers turn that into a
    normal tool-result string, same as validate_surface's own callers."""
    if not isinstance(fields, list):
        raise ValueError("render_form fields must be a list")

    components: list[dict[str, Any]] = []
    data_model: dict[str, Any] = {}
    root_children: list[str] = []

    if title is not None:
        if not isinstance(title, str) or not title:
            raise ValueError("render_form title must be a non-empty string if given")
        components.append({"id": "title", "component": "Text", "text": title, "variant": "h4"})
        root_children.append("title")

    for i, field in enumerate(fields):
        if not isinstance(field, dict):
            raise ValueError(f"render_form field {i} must be an object")
        label = field.get("label")
        path = field.get("path")
        if not isinstance(label, str) or not label:
            raise ValueError(f"render_form field {i} needs a non-empty 'label'")
        if not isinstance(path, str) or not path:
            raise ValueError(f"render_form field {i} ({label!r}) needs a non-empty 'path'")
        input_type = field.get("input", "text")
        component_type = _FORM_INPUT_TO_COMPONENT.get(input_type)
        if component_type is None:
            raise ValueError(
                f"render_form field {i} ({label!r}) has unsupported input "
                f"{input_type!r}; supported: {sorted(_FORM_INPUT_TO_COMPONENT)}"
            )

        field_id = f"field_{i}"
        component: dict[str, Any] = {"id": field_id, "component": component_type, "label": label}
        if input_type == "select":
            options = field.get("options")
            if not isinstance(options, list) or not options or not all(
                isinstance(o, str) and o for o in options
            ):
                raise ValueError(f"render_form field {i} ({label!r}): 'select' needs a non-empty 'options' list")
            component["options"] = [{"label": o, "value": o} for o in options]
            if "variant" in field:
                component["variant"] = field["variant"]
        component["value"] = {"path": path}
        if "value" in field:
            # An initial literal seed value — can't live directly on
            # "value" (that key is now the path binding itself, matching
            # the real spec's DynamicString shape), so it goes into the
            # surface's dataModel at that same path instead.
            data_model[path] = field["value"]

        components.append(component)
        root_children.append(field_id)

    submit_label_id = "submit_label"
    components.append({"id": submit_label_id, "component": "Text", "text": submit_label})
    components.append(
        {"id": "submit", "component": "Button", "child": submit_label_id, "action": {"name": submit_action}}
    )
    root_children.append("submit")
    components.append({"id": "root", "component": "Column", "children": root_children})

    surface: dict[str, Any] = {"surfaceId": surface_id, "components": components}
    if data_model:
        surface["dataModel"] = data_model
    return surface


def build_render_form_tool() -> BaseTool:
    """Builds a fresh `render_form` tool instance — same per-agent factory
    pattern as build_render_ui_tool(). Wire it in alongside render_ui
    wherever render_ui already lives (see this module's docstring on the
    contract-layer rationale)."""

    @tool
    async def render_form(
        fields: list[dict[str, Any]],
        submit_label: str,
        submit_action: str,
        title: str | None,
        tool_call_id: Annotated[str, InjectedToolCallId],
    ) -> Command:
        """Render an interactive form — the common case of render_ui, with
        a much simpler contract. Prefer this over render_ui whenever what
        you need is "a few labeled fields plus a submit button"; use
        render_ui directly only for content render_form can't express
        (non-form cards/lists, or forms mixed with other content).

        Args:
            fields: A flat list of field specs, each:
                {"label": <string, shown to the user>,
                 "path": <string, a unique key this field's value is
                          reported back under>,
                 "input": "text" | "checkbox" | "select" (default "text"),
                 "options": <list[string], REQUIRED when input is "select">,
                 "value": <optional initial value — string for "text",
                           bool for "checkbox">}
            submit_label: Text on the submit button (e.g. "Save details").
            submit_action: A short name identifying this submission (e.g.
                "save_user_profile") — reported back to you verbatim.
            title: Optional heading shown above the fields.

        When the user fills this in and submits, you will receive a new
        ordinary user message reporting `submit_action` and the value
        typed under each field's `path` — respond to it exactly like any
        other request. This is otherwise DISPLAY ONLY, same as render_ui:
        no component here can perform an action by itself, and any
        side-effectful action still goes through its own normal gated
        tool and confirmation exactly as if render_form had never been
        called.
        """
        try:
            surface = _build_form_surface(
                surface_id=f"form-{uuid.uuid4().hex[:8]}",
                title=title,
                fields=fields,
                submit_label=submit_label,
                submit_action=submit_action,
            )
        except ValueError as exc:
            return Command(
                update={
                    "messages": [
                        ToolMessage(content=f"render_form rejected this form: {exc}", tool_call_id=tool_call_id)
                    ]
                }
            )
        return await dispatch_surface(surface, tool_call_id, "render_form rejected this form")

    return render_form
