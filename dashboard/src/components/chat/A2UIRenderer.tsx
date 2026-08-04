import { useMemo, useState } from "react";
import { Card } from "@astryxdesign/core/Card";
import { Badge } from "@astryxdesign/core/Badge";
import { Divider } from "@astryxdesign/core/Divider";
import { Button } from "@astryxdesign/core/Button";
import { TextInput } from "@astryxdesign/core/TextInput";
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { Text as AstryxText, Heading } from "@astryxdesign/core/Text";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Timestamp } from "@astryxdesign/core/Timestamp";
import { Icon as AstryxIcon } from "@astryxdesign/core/Icon";
import { Slider as AstryxSlider } from "@astryxdesign/core/Slider";
import { DateTimeInput, type ISODateTimeString } from "@astryxdesign/core/DateTimeInput";
import { DateInput } from "@astryxdesign/core/DateInput";
import type { ISODateString } from "@astryxdesign/core/Calendar";
import { TimeInput, type ISOTimeString } from "@astryxdesign/core/TimeInput";
import { TabList, Tab } from "@astryxdesign/core/TabList";
import { Dialog } from "@astryxdesign/core/Dialog";
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
  if (v && typeof v === "object" && "path" in v && typeof (v as { path: unknown }).path === "string") {
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
  return typeof bound === "string" || typeof bound === "boolean" || typeof bound === "number" ? String(bound) : "";
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
}

function RenderNode({ id, ...rest }: { id: string } & Omit<NodeProps, "node">) {
  const node = rest.nodes.get(id);
  if (!node) return null;
  const Renderer = COMPONENT_RENDERERS[str(node.component)];
  if (!Renderer) return null;
  return <Renderer node={node} {...rest} />;
}

// --- Text / Badge / Divider / Image / Icon / Video / AudioPlayer --------

const TEXT_VARIANT_LEVEL: Record<string, 1 | 2 | 3 | 4 | 5> = { h1: 1, h2: 2, h3: 3, h4: 4, h5: 5 };

function TextNode({ node, data }: NodeProps) {
  const text = resolveDynamicString(node.text, data);
  const variant = str(node.variant, "body");
  const level = TEXT_VARIANT_LEVEL[variant];
  if (level) return <Heading level={level}>{text}</Heading>;
  return (
    <AstryxText type={variant === "caption" ? "supporting" : "body"} color={variant === "caption" ? "secondary" : undefined}>
      {text}
    </AstryxText>
  );
}

function BadgeNode({ node, data }: NodeProps) {
  return <Badge variant="neutral" label={resolveDynamicString(node.text, data)} />;
}

function DividerNode({ node }: NodeProps) {
  return <Divider orientation={node.axis === "vertical" ? "vertical" : "horizontal"} />;
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
      style={{ maxWidth: IMAGE_VARIANT_MAX_WIDTH[variant] ?? "100%", objectFit: fit as React.CSSProperties["objectFit"] }}
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
  return <AstryxIcon icon={Component} size="md" color="secondary" />;
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
    <VStack gap={1}>
      {description && (
        <AstryxText type="supporting" color="secondary">
          {description}
        </AstryxText>
      )}
      <audio src={url} controls className="max-w-full" />
    </VStack>
  );
}

// --- Layout: Column / Row / List / Card / Tabs / Modal -------------------

type Justify = "start" | "center" | "end" | "spaceBetween" | "spaceAround" | "spaceEvenly" | "stretch";
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
    <Card maxWidth={448} padding={3}>
      {childId && <RenderNode id={childId} {...rest} />}
    </Card>
  );
}

interface TabSpec {
  title: unknown;
  child: unknown;
}

function TabsNode({ node, data, ...rest }: NodeProps) {
  const tabs = Array.isArray(node.tabs) ? (node.tabs as TabSpec[]) : [];
  const [active, setActive] = useState(() => (tabs.length > 0 ? String(0) : ""));
  if (tabs.length === 0) return null;
  const activeIndex = Number(active);
  const activeChildId = str(tabs[activeIndex]?.child);
  return (
    <VStack gap={2}>
      <TabList value={active} onChange={setActive}>
        {tabs.map((tab, i) => (
          <Tab key={i} value={String(i)} label={resolveDynamicString(tab.title, data)} />
        ))}
      </TabList>
      {activeChildId && <RenderNode id={activeChildId} data={data} {...rest} />}
    </VStack>
  );
}

// Modal's `trigger` component (per the real spec, typically a Button)
// opens the dialog when activated — it does NOT also fire its own
// `action` at the same time; deliberate scope choice (the spec doesn't
// spell out whether both should fire, and "open the modal" is the only
// unambiguous reading of "the component that opens the modal"). Only a
// Button trigger is specially handled; any other trigger component type
// falls back to a plain clickable wrapper around its normal render.
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
        <Button type="button" label={triggerLabel} onClick={() => setIsOpen(true)} />
      ) : (
        <div role="button" tabIndex={0} onClick={() => setIsOpen(true)} className="cursor-pointer inline-block">
          <RenderNode id={triggerId} nodes={nodes} data={data} {...rest} />
        </div>
      )}
      <Dialog isOpen={isOpen} onOpenChange={setIsOpen} purpose="info" width={420}>
        <div className="p-4">
          <RenderNode id={contentId} nodes={nodes} data={data} {...rest} />
        </div>
      </Dialog>
    </>
  );
}

// --- Interactive: TextField / CheckBox / ChoicePicker / Slider / --------
// --- DateTimeInput / Button -----------------------------------------------

function TextFieldNode({ node, data, setField }: NodeProps) {
  const path = pathOf(node.value);
  const literal = typeof node.value === "string" ? node.value : "";
  const current = path ? data[path] : undefined;
  const value = typeof current === "string" ? current : literal;
  return (
    <TextInput
      label={resolveDynamicString(node.label, data)}
      value={value}
      isDisabled={!path}
      onChange={(next) => path && setField(path, next)}
    />
  );
}

function CheckBoxNode({ node, data, setField }: NodeProps) {
  const path = pathOf(node.value);
  const literal = node.value === true;
  const current = path ? data[path] : undefined;
  const checked = typeof current === "boolean" ? current : literal;
  return (
    <CheckboxInput
      label={resolveDynamicString(node.label, data)}
      value={checked}
      isDisabled={!path}
      onChange={(next) => path && setField(path, next)}
    />
  );
}

interface ChoiceOption {
  label: unknown;
  value: string;
}

function ChoicePickerNode({ node, data, setField }: NodeProps) {
  const path = pathOf(node.value);
  const rawOptions = Array.isArray(node.options) ? (node.options as ChoiceOption[]) : [];
  const options = rawOptions.filter((o) => o && typeof o.value === "string");
  const multi = node.variant === "multipleSelection";
  const chips = node.displayStyle === "chips";
  const filterable = node.filterable === true;
  const [filter, setFilter] = useState("");

  const selected = path ? resolveDynamicStringList({ path }, data) : [];
  const visible = filterable && filter
    ? options.filter((o) => resolveDynamicString(o.label, data).toLowerCase().includes(filter.toLowerCase()))
    : options;

  function toggle(value: string) {
    if (!path) return;
    if (multi) {
      const next = selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value];
      setField(path, next);
    } else {
      setField(path, [value]);
    }
  }

  return (
    <VStack gap={1.5}>
      {node.label !== undefined && (
        <AstryxText type="supporting" color="secondary">
          {resolveDynamicString(node.label, data)}
        </AstryxText>
      )}
      {filterable && (
        <TextInput label="Search" isLabelHidden value={filter} onChange={setFilter} placeholder="Filter options..." />
      )}
      {chips ? (
        <HStack gap={1.5} wrap="wrap">
          {visible.map((option) => (
            <Button
              key={option.value}
              type="button"
              size="sm"
              variant={selected.includes(option.value) ? "primary" : "secondary"}
              label={resolveDynamicString(option.label, data)}
              onClick={() => toggle(option.value)}
              isDisabled={!path}
            />
          ))}
        </HStack>
      ) : (
        <VStack gap={1}>
          {visible.map((option) => (
            <CheckboxInput
              key={option.value}
              label={resolveDynamicString(option.label, data)}
              value={selected.includes(option.value)}
              isDisabled={!path}
              onChange={() => toggle(option.value)}
            />
          ))}
        </VStack>
      )}
    </VStack>
  );
}

function SliderNode({ node, data, setField }: NodeProps) {
  const path = pathOf(node.value);
  const value = resolveDynamicNumber(node.value, data, typeof node.min === "number" ? node.min : 0);
  const max = typeof node.max === "number" ? node.max : 100;
  const min = typeof node.min === "number" ? node.min : 0;
  return (
    <AstryxSlider
      label={resolveDynamicString(node.label, data) || "Value"}
      value={value}
      min={min}
      max={max}
      isDisabled={!path}
      onChange={(next: number) => path && setField(path, next)}
    />
  );
}

function DateTimeInputNode({ node, data, setField }: NodeProps) {
  const path = pathOf(node.value);
  const literal = typeof node.value === "string" ? node.value : "";
  const current = path ? data[path] : undefined;
  const value = typeof current === "string" ? current : literal;
  const label = resolveDynamicString(node.label, data) || "Value";
  const enableDate = node.enableDate === true;
  const enableTime = node.enableTime === true;

  if (enableDate && enableTime) {
    return (
      <DateTimeInput
        label={label}
        value={(value || undefined) as ISODateTimeString | undefined}
        isDisabled={!path}
        onChange={(next) => path && setField(path, next ?? "")}
      />
    );
  }
  if (enableTime) {
    return (
      <TimeInput
        label={label}
        value={(value || undefined) as ISOTimeString | undefined}
        isDisabled={!path}
        onChange={(next) => path && setField(path, next ?? "")}
      />
    );
  }
  return (
    <DateInput
      label={label}
      value={(value || undefined) as ISODateString | undefined}
      isDisabled={!path}
      onChange={(next) => path && setField(path, next ?? "")}
    />
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
  // than mounting a nested <Heading>/<AstryxText> inside the button label.
  const label =
    childNode?.component === "Text"
      ? resolveDynamicString(childNode.text, data)
      : childId
        ? undefined
        : "";
  // Real A2UI Button.variant is default|primary|borderless — mapped onto
  // this app's actual Button variants (primary/secondary/ghost/destructive).
  const variant = node.variant === "primary" ? "primary" : node.variant === "borderless" ? "ghost" : "secondary";
  return (
    <Button
      type="button"
      variant={variant}
      label={label ?? ""}
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
// label+color meta, same Astryx Text/Heading/Badge/StatusDot components
// KanbanBoard itself uses, so it shares KanbanBoard's (and the chat
// panel's) typography rather than this file's own generic styling.
// Read-only — no drag, no edit, no delete; that's what the actual Board
// tab is for.
const BOARD_COLUMN_ORDER = ["todo", "in-progress", "in-review", "done"] as const;

const BOARD_COLUMN_META: Record<string, { title: string; variant: "neutral" | "accent" | "warning" | "success" }> = {
  todo: { title: "To-do", variant: "neutral" },
  "in-progress": { title: "In progress", variant: "accent" },
  "in-review": { title: "In review", variant: "warning" },
  done: { title: "Done", variant: "success" },
};

const BOARD_PRIORITY_META: Record<string, { label: string; variant: "error" | "warning" | "teal" }> = {
  high: { label: "High", variant: "error" },
  medium: { label: "Medium", variant: "warning" },
  low: { label: "Low", variant: "teal" },
};

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
    const map: Record<string, BoardTaskView[]> = { todo: [], "in-progress": [], "in-review": [], done: [] };
    for (const task of tasks) {
      if (map[task.column]) map[task.column].push(task);
    }
    return map;
  }, [tasks]);

  return (
    <div data-testid="a2ui-surface" className="flex gap-3 overflow-x-auto max-w-full self-start">
      {BOARD_COLUMN_ORDER.map((column) => {
        const meta = BOARD_COLUMN_META[column];
        const items = byColumn[column] ?? [];
        return (
          <Card key={column} variant="muted" padding={3} style={{ flexShrink: 0, width: 260 }}>
            <VStack gap={2}>
              <HStack gap={2} vAlign="center" hAlign="between">
                <HStack gap={2} vAlign="center">
                  <StatusDot variant={meta.variant} label={`${meta.title} status`} />
                  <Heading level={4}>{meta.title}</Heading>
                </HStack>
                <AstryxText type="supporting" color="secondary" hasTabularNumbers>
                  {items.length}
                </AstryxText>
              </HStack>
              {items.length === 0 ? (
                <AstryxText type="supporting" color="secondary">
                  No tasks
                </AstryxText>
              ) : (
                <VStack gap={2}>
                  {items.map((item) => {
                    const priority = BOARD_PRIORITY_META[item.priority] ?? {
                      label: item.priority,
                      variant: "teal" as const,
                    };
                    return (
                      <Card key={item.id} padding={3}>
                        <VStack gap={2}>
                          <HStack gap={1} vAlign="center" wrap="wrap">
                            <Badge label={item.ref} variant="neutral" />
                            <Badge label={priority.label} variant={priority.variant} />
                          </HStack>
                          <Heading level={4}>{item.title}</Heading>
                          {item.description && (
                            <AstryxText type="supporting" color="secondary" maxLines={2}>
                              {item.description}
                            </AstryxText>
                          )}
                          {item.updatedAt && (
                            <AstryxText type="supporting" color="secondary">
                              Updated <Timestamp value={item.updatedAt} format="relative" />
                            </AstryxText>
                          )}
                        </VStack>
                      </Card>
                    );
                  })}
                </VStack>
              )}
            </VStack>
          </Card>
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
