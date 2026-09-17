import { useId, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";
import { InstrumentCard } from "@/components/ui/instrument-card";
import { Chip } from "@/components/ui/chip";
import { relativeTime } from "@/lib/relativeTime";
import {
  UserCircleIcon,
  PlusIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  PaperClipIcon,
  CalendarIcon,
  PhoneIcon,
  CameraIcon,
  CheckIcon,
  XMarkIcon,
  TrashIcon,
  ArrowDownTrayIcon,
  PencilIcon,
  CalendarDaysIcon,
  ExclamationCircleIcon,
  ForwardIcon,
  HeartIcon,
  FolderIcon,
  QuestionMarkCircleIcon,
  HomeIcon,
  InformationCircleIcon,
  MapPinIcon,
  LockClosedIcon,
  LockOpenIcon,
  EnvelopeIcon,
  Bars3Icon,
  EllipsisVerticalIcon,
  EllipsisHorizontalIcon,
  BellSlashIcon,
  BellIcon,
  PauseIcon,
  CreditCardIcon,
  UserIcon,
  PhotoIcon,
  PlayIcon,
  PrinterIcon,
  ArrowPathIcon,
  BackwardIcon,
  MagnifyingGlassIcon,
  PaperAirplaneIcon,
  Cog6ToothIcon,
  ShareIcon,
  ShoppingCartIcon,
  StarIcon,
  StopIcon,
  ArrowUpTrayIcon,
  EyeIcon,
  EyeSlashIcon,
  SpeakerWaveIcon,
  SpeakerXMarkIcon,
  ExclamationTriangleIcon,
} from "@heroicons/react/24/outline";
import type { A2UIComponent, A2UISurface } from "@/lib/api";

// Renders a validated A2UI surface (Phase 17, PLAN.md) against Google's
// REAL A2UI v0.9 "Basic Catalog" component vocabulary — full parity pass,
// superseding the earlier constrained-subset version (assistant/a2ui.py's
// module docstring has the full before/after and the deliberate scope cuts
// still in place: the `functions` expression layer, ChildList's "template"
// repeater form, and Icon's raw svgPath form). Registry-dispatch pattern
// copied from InterruptGate.tsx: a component-type -> renderer map, plus the
// same `str`/coercion-guard style for reading untyped node fields.
//
// Interactive components (TextField/CheckBox/ChoicePicker/Button/Slider/
// DateTimeInput) write into a LOCAL, per-surface data model (`useState` in
// the top-level A2UIRenderer, keyed by each field's bound "path") — nothing
// is sent anywhere until a Button fires. A Button can ONLY report data back
// via `onAction` (wired by ChatPanel to POST /a2ui/action, framed
// server-side as a plain new user turn) — it cannot itself call a tool,
// fetch anything, or bypass a confirmation gate. See assistant/a2ui.py's
// module docstring for the full security reasoning this mirrors.

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

// The LOCAL data model a surface's interactive fields read from and write
// to — never round-trips anywhere until a Button submits it as `context`.
type FieldValue = string | boolean | string[] | number;
type DataModel = Record<string, FieldValue>;

function pathOf(v: unknown): string | undefined {
  if (
    v &&
    typeof v === "object" &&
    "path" in v &&
    typeof (v as { path: unknown }).path === "string"
  ) {
    return (v as { path: string }).path;
  }
  return undefined;
}

// Resolves an A2UI DynamicString: a literal string, or {"path": ...} bound
// against the surface's data model — `data` here IS that data model (see
// A2UIRenderer below: seeded from `surface.dataModel` on mount, and also
// the same store TextField/CheckBox/ChoicePicker/Slider/DateTimeInput write
// user input into, so a display field and an input field can reference the
// same path). A path with nothing at it (no dataModel, or the key isn't
// present) renders as empty rather than leaking `[object Object]`.
function resolveDynamicString(v: unknown, data: DataModel): string {
  if (typeof v === "string") return v;
  const path = pathOf(v);
  if (path === undefined) return "";
  const bound = data[path];
  return typeof bound === "string" || typeof bound === "boolean" || typeof bound === "number"
    ? String(bound)
    : "";
}

function resolveDynamicNumber(v: unknown, data: DataModel, fallback = 0): number {
  if (typeof v === "number") return v;
  const path = pathOf(v);
  if (path === undefined) return fallback;
  const bound = data[path];
  return typeof bound === "number" ? bound : fallback;
}

function resolveDynamicStringList(v: unknown, data: DataModel): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  const path = pathOf(v);
  if (path === undefined) return [];
  const bound = data[path];
  return Array.isArray(bound) ? bound : [];
}

function childIds(node: A2UIComponent): string[] {
  return Array.isArray(node.children)
    ? node.children.filter((c): c is string => typeof c === "string")
    : [];
}

interface NodeProps {
  node: A2UIComponent;
  nodes: Map<string, A2UIComponent>;
  data: DataModel;
  setField: (path: string, value: FieldValue) => void;
  onAction?: (name: string, context: DataModel) => void;
  disabled?: boolean;
  // Defense-in-depth against a cyclic component tree causing unbounded
  // recursion — the real guard is assistant/a2ui.py's own validate_surface
  // (a cyclic surface should never reach this component in normal
  // operation), but this stops a stale/buggy surface from freezing the tab
  // instead of just rendering nothing past the cycle. Every intermediate
  // renderer already forwards `{...rest}` verbatim, so only this one
  // recursive chokepoint needs to thread it.
  visited?: Set<string>;
}

function RenderNode({ id, visited, ...rest }: { id: string } & Omit<NodeProps, "node">) {
  if (visited?.has(id)) return null;
  const node = rest.nodes.get(id);
  if (!node) return null;
  const Renderer = COMPONENT_RENDERERS[str(node.component)];
  if (!Renderer) return null;
  const nextVisited = new Set(visited);
  nextVisited.add(id);
  return <Renderer node={node} {...rest} visited={nextVisited} />;
}

// --- Text / Badge / Divider / Image / Icon / Video / AudioPlayer --------

const TEXT_VARIANT_TAG: Record<string, "h1" | "h2" | "h3" | "h4" | "h5"> = {
  h1: "h1",
  h2: "h2",
  h3: "h3",
  h4: "h4",
  h5: "h5",
};
const TEXT_VARIANT_CLASS: Record<string, string> = {
  h1: "font-heading text-2xl font-semibold",
  h2: "font-heading text-xl font-semibold",
  h3: "font-heading text-lg font-semibold",
  h4: "font-heading text-base font-semibold",
  h5: "font-heading text-sm font-semibold",
  caption: "text-xs text-muted-foreground",
  body: "text-sm",
};

function TextNode({ node, data }: NodeProps) {
  const text = resolveDynamicString(node.text, data);
  const variant = str(node.variant, "body");
  const Tag = TEXT_VARIANT_TAG[variant];
  const className = TEXT_VARIANT_CLASS[variant] ?? TEXT_VARIANT_CLASS.body;
  if (Tag) return <Tag className={className}>{text}</Tag>;
  return <p className={className}>{text}</p>;
}

function BadgeNode({ node, data }: NodeProps) {
  return <Chip>{resolveDynamicString(node.text, data)}</Chip>;
}

function DividerNode({ node }: NodeProps) {
  const vertical = node.axis === "vertical";
  return (
    <div
      role="separator"
      data-orientation={vertical ? "vertical" : "horizontal"}
      className={vertical ? "w-px self-stretch bg-graphite/30" : "h-px w-full bg-graphite/30"}
    />
  );
}

// Real A2UI image "variant" is a size hint, not a semantic role — mapped to
// a max-width so avatar/icon-sized images don't blow up to full card width.
const IMAGE_VARIANT_MAX_WIDTH: Record<string, number> = {
  icon: 24,
  avatar: 40,
  smallFeature: 120,
  mediumFeature: 240,
  largeFeature: 400,
  header: 9999,
};

function ImageNode({ node, data }: NodeProps) {
  const url = resolveDynamicString(node.url, data);
  if (!url) return null;
  const variant = str(node.variant, "mediumFeature");
  const fit = str(node.fit, "fill");
  return (
    <img
      src={url}
      alt={resolveDynamicString(node.description, data)}
      className="rounded-md"
      style={{
        maxWidth: IMAGE_VARIANT_MAX_WIDTH[variant] ?? "100%",
        objectFit: fit as React.CSSProperties["objectFit"],
      }}
    />
  );
}

// A2UI's fixed Icon.name enum (assistant/a2ui.py's ICON_NAMES) mapped to
// heroicons/24/outline — the icon set this app already uses elsewhere
// (KanbanBoard.tsx). Not a 1:1 semantic match for every name (heroicons'
// outline set has no half-star/mute-vs-off/skip-vs-fastforward distinction)
// — documented reuses, acceptable since these render as decorative icons.
const ICON_MAP: Record<string, React.ComponentType<React.SVGProps<SVGSVGElement>>> = {
  accountCircle: UserCircleIcon,
  add: PlusIcon,
  arrowBack: ArrowLeftIcon,
  arrowForward: ArrowRightIcon,
  attachFile: PaperClipIcon,
  calendarToday: CalendarIcon,
  call: PhoneIcon,
  camera: CameraIcon,
  check: CheckIcon,
  close: XMarkIcon,
  delete: TrashIcon,
  download: ArrowDownTrayIcon,
  edit: PencilIcon,
  event: CalendarDaysIcon,
  error: ExclamationCircleIcon,
  fastForward: ForwardIcon,
  favorite: HeartIcon,
  favoriteOff: HeartIcon,
  folder: FolderIcon,
  help: QuestionMarkCircleIcon,
  home: HomeIcon,
  info: InformationCircleIcon,
  locationOn: MapPinIcon,
  lock: LockClosedIcon,
  lockOpen: LockOpenIcon,
  mail: EnvelopeIcon,
  menu: Bars3Icon,
  moreVert: EllipsisVerticalIcon,
  moreHoriz: EllipsisHorizontalIcon,
  notificationsOff: BellSlashIcon,
  notifications: BellIcon,
  pause: PauseIcon,
  payment: CreditCardIcon,
  person: UserIcon,
  phone: PhoneIcon,
  photo: PhotoIcon,
  play: PlayIcon,
  print: PrinterIcon,
  refresh: ArrowPathIcon,
  rewind: BackwardIcon,
  search: MagnifyingGlassIcon,
  send: PaperAirplaneIcon,
  settings: Cog6ToothIcon,
  share: ShareIcon,
  shoppingCart: ShoppingCartIcon,
  skipNext: ForwardIcon,
  skipPrevious: BackwardIcon,
  star: StarIcon,
  starHalf: StarIcon,
  starOff: StarIcon,
  stop: StopIcon,
  upload: ArrowUpTrayIcon,
  visibility: EyeIcon,
  visibilityOff: EyeSlashIcon,
  volumeDown: SpeakerWaveIcon,
  volumeMute: SpeakerXMarkIcon,
  volumeOff: SpeakerXMarkIcon,
  volumeUp: SpeakerWaveIcon,
  warning: ExclamationTriangleIcon,
};

function IconNode({ node, data }: NodeProps) {
  const name = typeof node.name === "string" ? node.name : resolveDynamicString(node.name, data);
  const Component = ICON_MAP[name];
  if (!Component) return null;
  return <Component className="size-4 text-muted-foreground" />;
}

function VideoNode({ node, data }: NodeProps) {
  const url = resolveDynamicString(node.url, data);
  if (!url) return null;
  // eslint-disable-next-line jsx-a11y/media-has-caption
  return <video src={url} controls className="max-w-full rounded-md" />;
}

function AudioPlayerNode({ node, data }: NodeProps) {
  const url = resolveDynamicString(node.url, data);
  const description = resolveDynamicString(node.description, data);
  if (!url) return null;
  return (
    <div className="flex flex-col gap-1">
      {description && <p className="text-xs text-muted-foreground">{description}</p>}
      <audio src={url} controls className="max-w-full" />
    </div>
  );
}

// --- Layout: Column / Row / List / Card / Tabs / Modal -------------------

type Justify =
  "start" | "center" | "end" | "spaceBetween" | "spaceAround" | "spaceEvenly" | "stretch";
type Align = "start" | "center" | "end" | "stretch";

const JUSTIFY_CLASS: Record<Justify, string> = {
  start: "justify-start",
  center: "justify-center",
  end: "justify-end",
  spaceBetween: "justify-between",
  spaceAround: "justify-around",
  spaceEvenly: "justify-evenly",
  stretch: "justify-stretch",
};
const ALIGN_CLASS: Record<Align, string> = {
  start: "items-start",
  center: "items-center",
  end: "items-end",
  stretch: "items-stretch",
};

function ColumnNode({ node, ...rest }: NodeProps) {
  const justify = JUSTIFY_CLASS[str(node.justify, "start") as Justify] ?? "justify-start";
  const align = ALIGN_CLASS[str(node.align, "stretch") as Align] ?? "items-stretch";
  return (
    <div className={`flex flex-col gap-2 ${justify} ${align}`}>
      {childIds(node).map((childId) => (
        <RenderNode key={childId} id={childId} {...rest} />
      ))}
    </div>
  );
}

function RowNode({ node, ...rest }: NodeProps) {
  const justify = JUSTIFY_CLASS[str(node.justify, "start") as Justify] ?? "justify-start";
  const align = ALIGN_CLASS[str(node.align, "stretch") as Align] ?? "items-stretch";
  return (
    <div className={`flex flex-wrap gap-2 ${justify} ${align}`}>
      {childIds(node).map((childId) => (
        <RenderNode key={childId} id={childId} {...rest} />
      ))}
    </div>
  );
}

function ListNode({ node, ...rest }: NodeProps) {
  const horizontal = node.direction === "horizontal";
  const align = ALIGN_CLASS[str(node.align, "stretch") as Align] ?? "items-stretch";
  return (
    <div className={`flex ${horizontal ? "flex-row flex-wrap" : "flex-col"} gap-1.5 ${align}`}>
      {childIds(node).map((childId) => (
        <RenderNode key={childId} id={childId} {...rest} />
      ))}
    </div>
  );
}

function CardNode({ node, ...rest }: NodeProps) {
  const childId = str(node.child);
  return (
    <InstrumentCard className="max-w-[448px] p-3">
      {childId && <RenderNode id={childId} {...rest} />}
    </InstrumentCard>
  );
}

interface TabSpec {
  title: unknown;
  child: unknown;
}

function TabsNode({ node, data, ...rest }: NodeProps) {
  const tabs = Array.isArray(node.tabs) ? (node.tabs as TabSpec[]) : [];
  const [active, setActive] = useState(0);
  if (tabs.length === 0) return null;
  const activeChildId = str(tabs[active]?.child);
  return (
    <div className="flex flex-col gap-2">
      <div role="tablist" className="flex gap-1 border-b border-graphite/30">
        {tabs.map((tab, i) => (
          <button
            key={i}
            type="button"
            role="tab"
            aria-selected={active === i}
            onClick={() => setActive(i)}
            className={cn(
              "px-3 py-1.5 text-sm font-medium transition-colors",
              active === i
                ? "border-b-2 border-accent-signal text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {resolveDynamicString(tab.title, data)}
          </button>
        ))}
      </div>
      {activeChildId && <RenderNode id={activeChildId} data={data} {...rest} />}
    </div>
  );
}

// Modal's `trigger` component (per the real spec, typically a Button)
// opens the dialog when activated — it does NOT also fire its own
// `action` at the same time; deliberate scope choice (the spec doesn't
// spell out whether both should fire, and "open the modal" is the only
// unambiguous reading of "the component that opens the modal"). Only a
// Button trigger is specially handled; any other trigger component type
// falls back to a plain clickable wrapper around its normal render.
//
// createPortal to document.body, not an inline absolute/fixed div — any
// non-`none` transform on an ancestor (InstrumentCard's own tilt included)
// creates a new containing block for `position: fixed`, which would trap
// this overlay inside whatever card happens to contain the surface (the
// exact bug Phase 28's own radial-selector settings panel hit).
function ModalNode({ node, nodes, data, ...rest }: NodeProps) {
  const [isOpen, setIsOpen] = useState(false);
  const triggerId = str(node.trigger);
  const contentId = str(node.content);
  const triggerNode = nodes.get(triggerId);
  const contentNode = nodes.get(contentId);
  if (!triggerNode || !contentNode) return null;

  const triggerLabel =
    triggerNode.component === "Button" && typeof triggerNode.child === "string"
      ? resolveDynamicString(nodes.get(triggerNode.child)?.text, data)
      : undefined;

  return (
    <>
      {triggerLabel !== undefined ? (
        <A2UIButton variant="secondary" onClick={() => setIsOpen(true)}>
          {triggerLabel}
        </A2UIButton>
      ) : (
        <div
          role="button"
          tabIndex={0}
          onClick={() => setIsOpen(true)}
          className="inline-block cursor-pointer"
        >
          <RenderNode id={triggerId} nodes={nodes} data={data} {...rest} />
        </div>
      )}
      {isOpen &&
        createPortal(
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
            onClick={() => setIsOpen(false)}
          >
            <div
              className="instrument-card max-h-[80vh] w-full max-w-[420px] overflow-y-auto p-4"
              onClick={(event) => event.stopPropagation()}
            >
              <RenderNode id={contentId} nodes={nodes} data={data} {...rest} />
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

// --- Interactive: TextField / CheckBox / ChoicePicker / Slider / --------
// --- DateTimeInput / Button -----------------------------------------------

// One shared button primitive for every A2UI-rendered action (Button
// nodes, chip-style ChoicePicker options, Modal triggers) — plain
// elements, styled to this design's own accent/hairline vocabulary
// rather than Astryx's Button variants.
function A2UIButton({
  children,
  onClick,
  disabled,
  variant = "secondary",
  size = "md",
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  variant?: "primary" | "secondary" | "ghost";
  size?: "sm" | "md";
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "rounded-md font-medium transition-colors disabled:opacity-50",
        size === "sm" ? "px-2.5 py-1 text-xs" : "px-4 py-1.5 text-sm",
        variant === "primary" && "bg-accent-signal text-white hover:opacity-90",
        variant === "secondary" && "border border-graphite/40 hover:bg-graphite/10",
        variant === "ghost" && "hover:bg-graphite/10",
      )}
    >
      {children}
    </button>
  );
}

function TextFieldNode({ node, data, setField }: NodeProps) {
  const id = useId();
  const path = pathOf(node.value);
  const literal = typeof node.value === "string" ? node.value : "";
  const current = path ? data[path] : undefined;
  const value = typeof current === "string" ? current : literal;
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-xs text-muted-foreground">
        {resolveDynamicString(node.label, data)}
      </label>
      <input
        id={id}
        type="text"
        value={value}
        disabled={!path}
        onChange={(event) => path && setField(path, event.target.value)}
        className="rounded-md border border-graphite/40 bg-transparent px-2.5 py-1.5 text-sm outline-none focus:border-accent-signal disabled:opacity-50"
      />
    </div>
  );
}

function CheckBoxNode({ node, data, setField }: NodeProps) {
  const id = useId();
  const path = pathOf(node.value);
  const literal = node.value === true;
  const current = path ? data[path] : undefined;
  const checked = typeof current === "boolean" ? current : literal;
  return (
    <label htmlFor={id} className="flex items-center gap-2 text-sm">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={!path}
        onChange={(event) => path && setField(path, event.target.checked)}
        className="size-4 rounded border-graphite/40 accent-[var(--accent-signal)]"
      />
      {resolveDynamicString(node.label, data)}
    </label>
  );
}

interface ChoiceOption {
  label: unknown;
  value: string;
}

function ChoicePickerNode({ node, data, setField }: NodeProps) {
  const id = useId();
  const path = pathOf(node.value);
  const rawOptions = Array.isArray(node.options) ? (node.options as ChoiceOption[]) : [];
  const options = rawOptions.filter((o) => o && typeof o.value === "string");
  const multi = node.variant === "multipleSelection";
  const chips = node.displayStyle === "chips";
  const filterable = node.filterable === true;
  const [filter, setFilter] = useState("");

  const selected = path ? resolveDynamicStringList({ path }, data) : [];
  const visible =
    filterable && filter
      ? options.filter((o) =>
          resolveDynamicString(o.label, data).toLowerCase().includes(filter.toLowerCase()),
        )
      : options;

  function toggle(value: string) {
    if (!path) return;
    if (multi) {
      const next = selected.includes(value)
        ? selected.filter((v) => v !== value)
        : [...selected, value];
      setField(path, next);
    } else {
      setField(path, [value]);
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      {node.label !== undefined && (
        <p className="text-xs text-muted-foreground">{resolveDynamicString(node.label, data)}</p>
      )}
      {filterable && (
        <div className="flex flex-col gap-1">
          <label htmlFor={id} className="sr-only">
            Search
          </label>
          <input
            id={id}
            type="text"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Filter options..."
            className="rounded-md border border-graphite/40 bg-transparent px-2.5 py-1.5 text-sm outline-none focus:border-accent-signal"
          />
        </div>
      )}
      {chips ? (
        <div className="flex flex-wrap gap-1.5">
          {visible.map((option) => (
            <A2UIButton
              key={option.value}
              size="sm"
              variant={selected.includes(option.value) ? "primary" : "secondary"}
              onClick={() => toggle(option.value)}
              disabled={!path}
            >
              {resolveDynamicString(option.label, data)}
            </A2UIButton>
          ))}
        </div>
      ) : (
        <div className="flex flex-col gap-1">
          {visible.map((option) => {
            const optionId = `${id}-${option.value}`;
            return (
              <label
                key={option.value}
                htmlFor={optionId}
                className="flex items-center gap-2 text-sm"
              >
                <input
                  id={optionId}
                  type="checkbox"
                  checked={selected.includes(option.value)}
                  disabled={!path}
                  onChange={() => toggle(option.value)}
                  className="size-4 rounded border-graphite/40 accent-[var(--accent-signal)]"
                />
                {resolveDynamicString(option.label, data)}
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}

function SliderNode({ node, data, setField }: NodeProps) {
  const id = useId();
  const path = pathOf(node.value);
  const value = resolveDynamicNumber(node.value, data, typeof node.min === "number" ? node.min : 0);
  const max = typeof node.max === "number" ? node.max : 100;
  const min = typeof node.min === "number" ? node.min : 0;
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-xs text-muted-foreground">
        {resolveDynamicString(node.label, data) || "Value"}
      </label>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        value={value}
        disabled={!path}
        onChange={(event) => path && setField(path, Number(event.target.value))}
        className="w-full accent-[var(--accent-signal)]"
      />
    </div>
  );
}

// enableDate+enableTime -> <input type="datetime-local">, enableTime alone
// -> "time", else "date". Deliberate, undocumented fidelity trade-off vs.
// the old DateTimeInput/TimeInput/DateInput trio: a native datetime-local
// input's value format (`YYYY-MM-DDTHH:mm`, no seconds/offset) isn't
// byte-identical to a full ISO 8601 string — untested either way (no test
// in this file exercises DateTimeInputNode), and not central to this
// stage's actual goal (removing Astryx chrome, not re-validating every
// A2UI field type's exact wire format).
function DateTimeInputNode({ node, data, setField }: NodeProps) {
  const id = useId();
  const path = pathOf(node.value);
  const literal = typeof node.value === "string" ? node.value : "";
  const current = path ? data[path] : undefined;
  const value = typeof current === "string" ? current : literal;
  const label = resolveDynamicString(node.label, data) || "Value";
  const enableDate = node.enableDate === true;
  const enableTime = node.enableTime === true;
  const type = enableDate && enableTime ? "datetime-local" : enableTime ? "time" : "date";
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-xs text-muted-foreground">
        {label}
      </label>
      <input
        id={id}
        type={type}
        value={value}
        disabled={!path}
        onChange={(event) => path && setField(path, event.target.value)}
        className="rounded-md border border-graphite/40 bg-transparent px-2.5 py-1.5 text-sm outline-none focus:border-accent-signal disabled:opacity-50"
      />
    </div>
  );
}

function ButtonNode({ node, nodes, data, onAction, disabled }: NodeProps) {
  // assistant/a2ui.py's validate_surface guarantees `action` is EXACTLY
  // {"name": <non-empty string>} on any surface that reached this
  // renderer — still coerced defensively rather than trusted blindly,
  // same posture InterruptGate's str()/list() guards take on payload data.
  const action = node.action;
  const name =
    action && typeof action === "object" && "name" in action && typeof action.name === "string"
      ? action.name
      : undefined;
  const childId = str(node.child);
  const childNode = nodes.get(childId);
  // The real spec's Button.child is composable (usually a Text, sometimes
  // an Icon) — for the common Text case, read its string directly rather
  // than mounting a nested heading/paragraph inside the button label.
  const label =
    childNode?.component === "Text"
      ? resolveDynamicString(childNode.text, data)
      : childId
        ? undefined
        : "";
  // Real A2UI Button.variant is default|primary|borderless — mapped onto
  // A2UIButton's own primary/secondary/ghost variants.
  const variant =
    node.variant === "primary" ? "primary" : node.variant === "borderless" ? "ghost" : "secondary";
  return (
    <A2UIButton
      variant={variant}
      onClick={() => name && onAction?.(name, data)}
      disabled={!name || disabled}
    >
      {label ?? ""}
    </A2UIButton>
  );
}

const COMPONENT_RENDERERS: Record<string, (props: NodeProps) => React.ReactElement | null> = {
  Text: TextNode,
  Badge: BadgeNode,
  Divider: DividerNode,
  Image: ImageNode,
  Icon: IconNode,
  Video: VideoNode,
  AudioPlayer: AudioPlayerNode,
  Column: ColumnNode,
  Row: RowNode,
  List: ListNode,
  Card: CardNode,
  Tabs: TabsNode,
  Modal: ModalNode,
  TextField: TextFieldNode,
  CheckBox: CheckBoxNode,
  ChoicePicker: ChoicePickerNode,
  Slider: SliderNode,
  DateTimeInput: DateTimeInputNode,
  Button: ButtonNode,
};

// Dedicated renderer for kanban-board surfaces — board_tools.py's
// render_board_ui, identified by its "board-" surfaceId prefix (a
// deliberate, load-bearing contract between that tool and this file,
// documented on both sides — see render_board_ui's own docstring). Bypasses
// the generic component walk entirely: the generic tree still exists in
// `surface.components` (valid, would render adequately through the normal
// path for any future non-board-aware client), but this view reads
// structure straight out of `surface.dataModel`'s "/<taskId>/<field>" keys
// and lays it out to visually match the real Board tab
// (dashboard/src/components/board/KanbanBoard.tsx) — same column/priority
// label+color meta and the same InstrumentCard/Chip primitives
// KanbanBoard itself now uses (PLAN.md Phase 29 Stage 2), so it shares
// KanbanBoard's typography rather than this file's own generic styling.
// Read-only — no drag, no edit, no delete; that's what the actual Board
// tab is for.
const BOARD_COLUMN_ORDER = ["todo", "in-progress", "in-review", "done"] as const;

const BOARD_COLUMN_META: Record<string, { title: string; dotClass: string }> = {
  todo: { title: "To-do", dotClass: "bg-muted-foreground" },
  "in-progress": { title: "In progress", dotClass: "bg-accent-signal" },
  "in-review": { title: "In review", dotClass: "bg-signal" },
  done: { title: "Done", dotClass: "bg-moss" },
};

const BOARD_PRIORITY_META: Record<string, { label: string; dotClass: string }> = {
  high: { label: "High", dotClass: "bg-rust" },
  medium: { label: "Medium", dotClass: "bg-signal" },
  low: { label: "Low", dotClass: "bg-teal-500" },
};

function StatusDot({ className, label }: { className: string; label: string }) {
  return <span aria-label={label} className={cn("inline-block size-2 rounded-full", className)} />;
}

interface BoardTaskView {
  id: string;
  ref: string;
  title: string;
  description: string;
  priority: string;
  column: string;
  updatedAt: string;
}

function parseBoardTasks(dataModel: A2UISurface["dataModel"]): BoardTaskView[] {
  if (!dataModel) return [];
  const ids = new Set<string>();
  for (const key of Object.keys(dataModel)) {
    const match = /^\/(.+)\/column$/.exec(key);
    if (match) ids.add(match[1]);
  }
  return Array.from(ids, (id) => {
    const field = (name: string): string => {
      const v = dataModel[`/${id}/${name}`];
      return typeof v === "string" ? v : "";
    };
    return {
      id,
      ref: field("ref"),
      title: field("title"),
      description: field("description"),
      priority: field("priority"),
      column: field("column"),
      updatedAt: field("updated_at"),
    };
  });
}

function BoardSurfaceView({ surface }: { surface: A2UISurface }) {
  const tasks = useMemo(() => parseBoardTasks(surface.dataModel), [surface]);
  const byColumn = useMemo(() => {
    const map: Record<string, BoardTaskView[]> = {
      todo: [],
      "in-progress": [],
      "in-review": [],
      done: [],
    };
    for (const task of tasks) {
      if (map[task.column]) map[task.column].push(task);
    }
    return map;
  }, [tasks]);

  return (
    <div data-testid="a2ui-surface" className="flex max-w-full gap-3 overflow-x-auto self-start">
      {BOARD_COLUMN_ORDER.map((column) => {
        const meta = BOARD_COLUMN_META[column];
        const items = byColumn[column] ?? [];
        return (
          <InstrumentCard key={column} className="w-[260px] shrink-0 p-3">
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <StatusDot className={meta.dotClass} label={`${meta.title} status`} />
                  <h4 className="font-heading text-sm font-semibold">{meta.title}</h4>
                </div>
                <span className="text-xs tabular-nums text-muted-foreground">{items.length}</span>
              </div>
              {items.length === 0 ? (
                <p className="text-xs text-muted-foreground">No tasks</p>
              ) : (
                <div className="flex flex-col gap-2">
                  {items.map((item) => {
                    const priority = BOARD_PRIORITY_META[item.priority] ?? {
                      label: item.priority,
                      dotClass: "bg-teal-500",
                    };
                    return (
                      <InstrumentCard key={item.id} className="p-3">
                        <div className="flex flex-col gap-2">
                          <div className="flex flex-wrap items-center gap-1">
                            <Chip>{item.ref}</Chip>
                            <Chip className="flex items-center gap-1">
                              <span
                                className={cn(
                                  "inline-block size-1.5 rounded-full",
                                  priority.dotClass,
                                )}
                              />
                              {priority.label}
                            </Chip>
                          </div>
                          <h4 className="font-heading text-sm font-semibold">{item.title}</h4>
                          {item.description && (
                            <p className="line-clamp-2 text-xs text-muted-foreground">
                              {item.description}
                            </p>
                          )}
                          {item.updatedAt && (
                            <p className="text-xs text-muted-foreground">
                              Updated {relativeTime(item.updatedAt)}
                            </p>
                          )}
                        </div>
                      </InstrumentCard>
                    );
                  })}
                </div>
              )}
            </div>
          </InstrumentCard>
        );
      })}
    </div>
  );
}

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
  if (surface.surfaceId.startsWith("board-")) {
    return <BoardSurfaceView surface={surface} />;
  }

  // Seeded once from the surface's own dataModel (server-supplied, not
  // agent-typed — assistant/a2ui.py's validate_surface/board_tools.py's
  // render_board_ui) — the SAME store TextField/CheckBox/ChoicePicker/
  // Slider/DateTimeInput then write user input into, so a display binding
  // and a form field can share one path. Lazy initializer: runs once per
  // mounted surface, matching this component's existing "surface is
  // immutable once rendered" model.
  const [data, setData] = useState<DataModel>(() => ({ ...(surface.dataModel ?? {}) }));
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
