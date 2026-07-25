import { useMemo, useState } from "react";
import { Card } from "@astryxdesign/core/Card";
import { Badge } from "@astryxdesign/core/Badge";
import { Divider } from "@astryxdesign/core/Divider";
import { Button } from "@astryxdesign/core/Button";
import { TextInput } from "@astryxdesign/core/TextInput";
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import type { A2UIComponent, A2UISurface } from "@/lib/api";

// Renders a validated A2UI surface (Phase 17, PLAN.md) — a small,
// constrained subset of Google's A2UI v0.9 component vocabulary
// (assistant/a2ui.py enforces the same vocabulary server-side before a
// surface ever reaches here). Registry-dispatch pattern copied directly
// from InterruptGate.tsx: a component-type -> renderer map, plus the same
// `str`/coercion-guard style for reading untyped node fields.
//
// Part B (interactive components): TextField/CheckBox/ChoicePicker write
// into a LOCAL, per-surface data model (`useState` in the top-level
// A2UIRenderer, keyed by each field's "path") — nothing is sent anywhere
// until a Button fires. A Button can ONLY report data back via `onAction`
// (wired by ChatPanel to POST /a2ui/action, framed server-side as a plain
// new user turn) — it cannot itself call a tool, fetch anything, or
// bypass a confirmation gate. See assistant/a2ui.py's module docstring for
// the full security reasoning this mirrors.

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

// v1 has no server-resolved data model to bind a {"path": ...} value
// against yet (assistant/a2ui.py's `_is_dynamic_string` accepts the shape
// structurally, for forward-compat, but doesn't resolve it) — render an
// empty string rather than leaking the raw `[object Object]` coercion.
function resolveDynamicString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function childIds(node: A2UIComponent): string[] {
  return Array.isArray(node.children)
    ? node.children.filter((c): c is string => typeof c === "string")
    : [];
}

// The LOCAL data model a surface's interactive fields read from and write
// to — never round-trips anywhere until a Button submits it as `context`.
type FieldValue = string | boolean | string[];
type DataModel = Record<string, FieldValue>;

interface NodeProps {
  node: A2UIComponent;
  nodes: Map<string, A2UIComponent>;
  data: DataModel;
  setField: (path: string, value: FieldValue) => void;
  onAction?: (name: string, context: DataModel) => void;
  disabled?: boolean;
}

function RenderNode({ id, ...rest }: { id: string } & Omit<NodeProps, "node">) {
  const node = rest.nodes.get(id);
  if (!node) return null;
  const Renderer = COMPONENT_RENDERERS[str(node.component)];
  if (!Renderer) return null;
  return <Renderer node={node} {...rest} />;
}

function TextNode({ node }: NodeProps) {
  return <p className="text-sm">{resolveDynamicString(node.text)}</p>;
}

function BadgeNode({ node }: NodeProps) {
  return <Badge variant="neutral" label={resolveDynamicString(node.text)} />;
}

function DividerNode({ node }: NodeProps) {
  return <Divider orientation={node.axis === "vertical" ? "vertical" : "horizontal"} />;
}

function ImageNode({ node }: NodeProps) {
  const url = resolveDynamicString(node.url);
  if (!url) return null;
  return <img src={url} alt={str(node.alt)} className="max-w-full rounded-md" />;
}

function ColumnNode({ node, ...rest }: NodeProps) {
  return (
    <div className="flex flex-col gap-2">
      {childIds(node).map((childId) => (
        <RenderNode key={childId} id={childId} {...rest} />
      ))}
    </div>
  );
}

function RowNode({ node, ...rest }: NodeProps) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {childIds(node).map((childId) => (
        <RenderNode key={childId} id={childId} {...rest} />
      ))}
    </div>
  );
}

function ListNode({ node, ...rest }: NodeProps) {
  return (
    <div className="flex flex-col gap-1.5">
      {childIds(node).map((childId) => (
        <RenderNode key={childId} id={childId} {...rest} />
      ))}
    </div>
  );
}

function CardNode({ node, ...rest }: NodeProps) {
  const childId = str(node.child);
  return (
    <Card maxWidth={448} padding={3}>
      {childId && <RenderNode id={childId} {...rest} />}
    </Card>
  );
}

function TextFieldNode({ node, data, setField }: NodeProps) {
  const path = str(node.path);
  const current = data[path];
  const value = typeof current === "string" ? current : str(node.value);
  return (
    <TextInput
      label={resolveDynamicString(node.label)}
      value={value}
      onChange={(next) => setField(path, next)}
    />
  );
}

function CheckBoxNode({ node, data, setField }: NodeProps) {
  const path = str(node.path);
  const current = data[path];
  const checked = typeof current === "boolean" ? current : node.value === true;
  return (
    <CheckboxInput
      label={resolveDynamicString(node.label)}
      value={checked}
      onChange={(next) => setField(path, next)}
    />
  );
}

function ChoicePickerNode({ node, data, setField }: NodeProps) {
  const path = str(node.path);
  const options = Array.isArray(node.options)
    ? node.options.filter((o): o is string => typeof o === "string")
    : [];
  const multi = node.variant === "multiSelect";
  const current = data[path];
  const selected: string[] = multi
    ? Array.isArray(current)
      ? current
      : []
    : typeof current === "string"
      ? [current]
      : [];

  function toggle(option: string) {
    if (multi) {
      const next = selected.includes(option)
        ? selected.filter((o) => o !== option)
        : [...selected, option];
      setField(path, next);
    } else {
      setField(path, option);
    }
  }

  return (
    <div className="flex flex-col gap-1.5 text-sm">
      <span className="text-xs font-medium text-muted-foreground">
        {resolveDynamicString(node.label)}
      </span>
      <div className="flex flex-wrap gap-1.5">
        {options.map((option) => (
          <Button
            key={option}
            type="button"
            size="sm"
            variant={selected.includes(option) ? "primary" : "secondary"}
            label={option}
            onClick={() => toggle(option)}
          />
        ))}
      </div>
    </div>
  );
}

function ButtonNode({ node, data, onAction, disabled }: NodeProps) {
  // assistant/a2ui.py's validate_surface guarantees `action` is EXACTLY
  // {"name": <non-empty string>} on any surface that reached this
  // renderer — still coerced defensively rather than trusted blindly,
  // same posture InterruptGate's str()/list() guards take on payload data.
  const action = node.action;
  const name =
    action && typeof action === "object" && "name" in action && typeof action.name === "string"
      ? action.name
      : undefined;
  return (
    <Button
      type="button"
      label={resolveDynamicString(node.text)}
      onClick={() => name && onAction?.(name, data)}
      isDisabled={!name || disabled}
    />
  );
}

const COMPONENT_RENDERERS: Record<string, (props: NodeProps) => React.ReactElement | null> = {
  Text: TextNode,
  Badge: BadgeNode,
  Divider: DividerNode,
  Image: ImageNode,
  Column: ColumnNode,
  Row: RowNode,
  List: ListNode,
  Card: CardNode,
  TextField: TextFieldNode,
  CheckBox: CheckBoxNode,
  ChoicePicker: ChoicePickerNode,
  Button: ButtonNode,
};

interface A2UIRendererProps {
  surface: A2UISurface;
  // Presentational only — mirrors InterruptGate's onApprove/onDecline
  // split: this component never fetches anything itself. `context` is
  // this surface's full local data model at the moment the Button fired.
  // Omitted (e.g. when rendering a past turn's already-resolved surface)
  // simply makes every Button on the surface inert.
  onAction?: (surfaceId: string, name: string, context: DataModel) => void;
  // While a turn is already in flight (or a gate is pending), Buttons on
  // any rendered surface are disabled — same reasoning InterruptGate's own
  // `disabled` prop exists for: no overlapping submissions.
  disabled?: boolean;
}

export function A2UIRenderer({ surface, onAction, disabled }: A2UIRendererProps) {
  const [data, setData] = useState<DataModel>({});
  const nodes = useMemo(() => {
    const map = new Map<string, A2UIComponent>();
    for (const component of surface.components ?? []) {
      if (typeof component.id === "string") map.set(component.id, component);
    }
    return map;
  }, [surface]);

  function setField(path: string, value: FieldValue) {
    setData((prev) => ({ ...prev, [path]: value }));
  }

  if (!nodes.has("root")) return null;
  return (
    <div data-testid="a2ui-surface" className="max-w-[80%] self-start">
      <RenderNode
        id="root"
        nodes={nodes}
        data={data}
        setField={setField}
        disabled={disabled}
        onAction={
          onAction ? (name, context) => onAction(surface.surfaceId, name, context) : undefined
        }
      />
    </div>
  );
}
