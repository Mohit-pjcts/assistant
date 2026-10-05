// Generic perception for ANY app window: accessibility elements -> (a) a short numbered list of things the agent can act
// on, (b) the text on screen. No screenshots, no OCR, no model: this is pure code and costs nothing.
import type { AxElement, Item, Observation } from "./contracts.ts";

export const CAP = 40;

export const ACTIONABLE = new Set([
  "AXButton", "AXTextField", "AXTextArea", "AXSearchField", "AXComboBox", "AXCheckBox", "AXRadioButton",
  "AXPopUpButton", "AXMenuButton", "AXLink", "AXCell", "AXRow", "AXTab", "AXDisclosureTriangle", "AXSlider", "AXIncrementor",
  "AXImage", // Finder's file and folder icons (only those that can be opened are kept, see below)
]);
export const TEXT_INPUT = new Set(["AXTextField", "AXTextArea", "AXSearchField", "AXComboBox"]);

/**
 * plain text that can be pressed: SwiftUI apps (Clock's "Choose a City" results) make their list rows text with a press
 * action and no button or cell around them, so without these the agent can't see the thing to click. Kept out: text
 * with no press action (just words on screen), and long text (a paragraph is something to read, not a row to press).
 */
/**
 * names for list rows that carry no label of their own: the first text inside each one. System Settings' sidebar (and
 * many outline/table lists) is rows like that, with the name ("General", "About") in a text element inside; without a
 * name the row was dropped, so the agent couldn't open a settings pane at all.
 */
export function namesOfRows(els: AxElement[]): Map<number, string> {
  const byIndex = new Map(els.map((e) => [e.index, e]));
  const names = new Map<number, string>();
  for (const e of els) {
    const text = (e.label || e.value || "").replace(/\s+/g, " ").trim();
    if (e.role !== "AXStaticText" || !text) continue;
    let up = e.parent;
    for (let hops = 0; hops < 4 && up !== undefined; hops++) {
      const parent = byIndex.get(up);
      if (!parent) break;
      if (parent.role === "AXRow" || parent.role === "AXCell") {
        if (!names.has(parent.index)) names.set(parent.index, text.slice(0, 80));
        break;
      }
      up = parent.parent;
    }
  }
  return names;
}

export function pressableText(e: AxElement): boolean {
  const text = e.label || e.value || "";
  return (e.role === "AXStaticText" || e.role === "AXHeading") && e.actions.includes("AXPress") && !!text && text.length <= 80;
}

export const ROLE_WORDS: Record<string, string> = {
  AXButton: "button", AXTextField: "text field", AXTextArea: "text area", AXSearchField: "search field",
  AXComboBox: "combo box", AXCheckBox: "checkbox", AXRadioButton: "radio button", AXPopUpButton: "drop-down",
  AXMenuButton: "menu button", AXLink: "link", AXCell: "row", AXRow: "row", AXTab: "tab", AXDisclosureTriangle: "disclosure",
  AXSlider: "slider", AXIncrementor: "stepper", AXImage: "file",
  AXStaticText: "pressable text", AXHeading: "pressable heading", // only pressable ones become items (pressableText)
};

const junkLabel = (s: string | undefined) => !s || !s.trim() || /^_NS:\d+$/.test(s.trim()) || /^_SC_/.test(s.trim());
/** internal class names leaking as labels, e.g. "ICMNoteListCell": better to describe the row by its text */
const classLike = (s: string) => /^[A-Z]{2,}[A-Za-z]+(Cell|View|Row|Item)[A-Za-z]*$/.test(s.trim());

/** elements of the window itself (the app's menu bar is excluded: menus are not driven by clicks here) */
export function windowElements(obs: Observation): AxElement[] {
  const byIndex = new Map(obs.elements.map((e) => [e.index, e] as const));
  const memo = new Map<number, boolean>();
  const inWindow = (e: AxElement): boolean => {
    const m = memo.get(e.index);
    if (m !== undefined) return m;
    let r: boolean;
    if (e.role === "AXMenuBar") r = false;
    else if (e.role === "AXWindow") r = true;
    else if (e.parent === undefined) r = false;
    else {
      const p = byIndex.get(e.parent);
      r = p ? inWindow(p) : false;
    }
    memo.set(e.index, r);
    return r;
  };
  return obs.elements.filter((e) => e.role !== "AXWindow" && inWindow(e));
}

/** what a single-line field shows when it is EMPTY: its prompt, not something anyone wrote */
export const PLACEHOLDER = /^(search|find|filter|type here|enter|add|new)\b/i;

/** a field's label or value compared as a prompt: case, spacing and one trailing "..." / "…" don't count */
const promptKey = (s: string | undefined) => (s ?? "").normalize("NFKC").toLowerCase().replace(/\s+/g, " ").replace(/\s*(?:\.{3}|…)\s*$/, "").trim();

/** whether `e` sits inside a web page (some ancestor is its AXWebArea); a browser's own toolbar does not */
export function inWebPage(els: AxElement[], e: AxElement, byIndex: Map<number, AxElement> = new Map(els.map((x) => [x.index, x] as const))): boolean {
  for (let up = e.parent, hops = 0; up !== undefined && hops < 64; hops++) {
    const parent = byIndex.get(up);
    if (!parent) return false;
    if (parent.role === "AXWebArea") return true;
    up = parent.parent;
  }
  return false;
}

/**
 * Whether a text field's "value" is just its own prompt, so it holds nothing. Web text boxes expose their placeholder as
 * their value (live: Instagram's message box is an AXTextArea labelled "Message..." that holds "Message..."), so a value
 * equal to the label (case, spacing and a trailing "..." / "…" aside, at most 60 characters) is the prompt, in ANY
 * role. Some apps mirror a field's real CONTENT into its label instead (a note in Notes: the same equality, real text),
 * so outside a web page only a prompt-shaped one counts: one ending in "..." / "…", or, in a single-line field, the
 * placeholder words of PLACEHOLDER ("Search"). Never in a text area on its words alone.
 */
export function isPlaceholder(role: string, label: string | undefined, value: string | undefined, inWeb: boolean): boolean {
  const v = (value ?? "").trim();
  if (!v || v.length > 60 || promptKey(v) !== promptKey(label)) return false;
  return inWeb || /(?:\.{3}|…)$/.test(v) || (role !== "AXTextArea" && PLACEHOLDER.test(v));
}

/** a text field of the window that shows only its own prompt (see isPlaceholder) */
export function showsPrompt(els: AxElement[], e: AxElement, byIndex?: Map<number, AxElement>): boolean {
  if (!TEXT_INPUT.has(e.role) || !e.value || promptKey(e.value) !== promptKey(e.label)) return false; // the cheap checks first
  return isPlaceholder(e.role, e.label, e.value, inWebPage(els, e, byIndex));
}

function stateOf(e: AxElement, holdsNothing: boolean): Item["state"] {
  if (TEXT_INPUT.has(e.role)) return !holdsNothing && e.value && e.value.trim() !== "" ? "filled" : "empty";
  if (e.role === "AXCheckBox" || e.role === "AXRadioButton") return e.value === "1" ? "selected" : "unselected";
  return "n/a";
}

const words = (s: string) => s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

const BIDI = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/** text from Cua's markdown tree (it includes static text that the element list leaves out); menu bar skipped */
export function screenFromMarkdown(md: string, max = 600): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let skipIndent = -1;
  let webIndent = -1; // the indent of the web page the lines below belong to (a field in a page shows its prompt as its value)
  for (const raw of md.split("\n")) {
    const indent = raw.length - raw.trimStart().length;
    const line = raw.trim();
    if (!line.startsWith("- ")) continue;
    if (skipIndent >= 0 && indent > skipIndent) continue;
    skipIndent = -1;
    if (webIndent >= 0 && indent <= webIndent) webIndent = -1;
    if (/\bAXMenuBar\b/.test(line)) { skipIndent = indent; continue; }
    if (webIndent < 0 && /\bAXWebArea\b/.test(line)) webIndent = indent;
    const m = line.match(/^- (?:\[\d+\] )?AX(StaticText|Heading|TextField|TextArea|Cell|Link|Button|GenericElement)\b(?: \(([^)]*)\))?(?: = "(.*)")?/);
    if (!m) continue;
    const role = m[1]!;
    // SwiftUI apps (Maps, Weather, Stocks) put their information in generic elements: "29 min, 11:56 ETA · 35 km"
    // (a text field that shows only its own prompt holds nothing: its "value" is not text on the screen)
    const texts = role === "StaticText" || role === "Heading" || role === "GenericElement" ? [m[3], m[2]]
      : role === "TextField" || role === "TextArea" ? [isPlaceholder(`AX${role}`, m[2], m[3], webIndent >= 0 && indent > webIndent) ? undefined : m[3]] : [];
    for (const s of texts) {
      const t = (s ?? "").replace(BIDI, "").replace(/\s+/g, " ").trim();
      if (!t || seen.has(t) || /^_NS:/.test(t)) continue;
      seen.add(t);
      out.push(t.length > 160 ? t.slice(0, 157) + "..." : t);
    }
    if (out.length >= max) break;
  }
  return out;
}

/** text visible in the window (static text and values), deduplicated, for reading answers and judging progress */
export function screenText(els: AxElement[], max = 600): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const e of els) {
    // a text field that shows only its own prompt holds nothing: its "value" is not text on the screen
    for (const s of e.role === "AXStaticText" || e.role === "AXHeading" || e.role === "AXGenericElement" ? [e.value, e.label] : TEXT_INPUT.has(e.role) && !showsPrompt(els, e) ? [e.value] : []) {
      const t = (s ?? "").replace(/\s+/g, " ").trim();
      if (!t || seen.has(t) || /^_NS:/.test(t)) continue;
      seen.add(t);
      out.push(t.length > 160 ? t.slice(0, 157) + "..." : t);
    }
    if (out.length >= max) break;
  }
  return out;
}

export interface Perceived { items: Item[]; screen: string[]; dropped: number }

/** items ranked: things whose words appear in the goal first, then text inputs, then the rest in reading order */
export function perceive(obs: Observation, goal = "", cap = CAP, focus = ""): Perceived {
  const els = windowElements(obs);
  const goalWords = new Set(words(goal));
  const focusWords = new Set(words(focus));
  const focusNorm = focus.trim().toLowerCase();
  const cands: { e: AxElement; label: string; score: number; order: number }[] = [];
  const seen = new Set<string>();
  const rowNames = namesOfRows(els);
  els.forEach((e, order) => {
    if (!e.token || !(ACTIONABLE.has(e.role) || pressableText(e))) return;
    if (e.role === "AXImage" && !e.actions.includes("AXOpen")) return; // decorative images
    let label = junkLabel(e.label) ? "" : e.label!.trim();
    if (label && classLike(label)) label = e.value?.trim() ? `${ROLE_WORDS[e.role] ?? e.role} "${e.value.trim().slice(0, 50)}"` : "";
    if (!label && TEXT_INPUT.has(e.role)) label = e.value?.trim() ? `${ROLE_WORDS[e.role]} containing "${e.value.trim().slice(0, 40)}"` : `${ROLE_WORDS[e.role]} (no label)`;
    if (!label && (e.role === "AXRow" || e.role === "AXCell")) label = rowNames.get(e.index) ?? "";
    if (!label) return;
    const id = `${e.role}:${label}`;
    if (seen.has(id)) return;
    seen.add(id);
    const lw = words(label);
    const overlap = lw.filter((w) => goalWords.has(w)).length;
    // the plan's next target is what the agent needs right now: make sure it survives the cap
    const focusHit = focusNorm && label.toLowerCase() === focusNorm ? 1000 : lw.filter((w) => focusWords.has(w)).length * 30;
    const score = focusHit + overlap * 10 + (TEXT_INPUT.has(e.role) ? 3 : 0);
    cands.push({ e, label, score, order });
  });
  const kept = [...cands].sort((a, b) => b.score - a.score || a.order - b.order).slice(0, cap);
  kept.sort((a, b) => a.order - b.order); // present in reading order
  const byIndex = new Map(els.map((x) => [x.index, x] as const));
  const items: Item[] = kept.map((c, i) => {
    // a field that shows only its own prompt holds nothing: empty, whatever its "value" says (see isPlaceholder)
    const holdsNothing = showsPrompt(els, c.e, byIndex);
    return {
      i, id: `${c.e.role}:${c.label}`, text: c.label, role: c.e.role, token: c.e.token, value: holdsNothing ? "" : c.e.value, state: stateOf(c.e, holdsNothing), actions: c.e.actions,
      ...(holdsNothing ? { placeholder: true } : {}),
    };
  });
  let screen = obs.markdown ? screenFromMarkdown(obs.markdown) : screenText(els);
  // multi-line field contents (a document, a note) don't survive the markdown rendering: add them in full
  const seenLines = new Set(screen);
  const extra: string[] = [];
  for (const e of els) {
    if (!TEXT_INPUT.has(e.role) || !e.value || showsPrompt(els, e, byIndex)) continue;
    for (const line of e.value.split(/\n+/)) {
      const t = line.replace(BIDI, "").trim();
      if (t && !seenLines.has(t)) { seenLines.add(t); extra.push(t.length > 160 ? t.slice(0, 157) + "..." : t); }
    }
  }
  // the window title is evidence too (a video page is titled "... - YouTube", a document by its file name)
  screen = [...(obs.window.title ? [`window title: ${obs.window.title}`] : []), ...screen, ...extra.slice(0, 200)];
  return { items, screen, dropped: cands.length - kept.length };
}

/** a cheap fingerprint of the window, used to detect "nothing changed" */
export function signature(p: Perceived): string {
  return p.items.map((i) => `${i.id}=${i.value ?? ""}`).join("|") + "#" + p.screen.join("|");
}

/** the n lines most useful for a goal: the first few (titles, displays) plus the ones sharing the most words with it */
/** what an answer to the question LOOKS like ("what time" -> 8:00 p.m.), for lines that share no words with it */
const ANSWER_SHAPES: [RegExp, RegExp][] = [
  [/\bwhat time\b|\bwhen does\b|\bopening hours\b|\bopen until\b|\bstarts?\b|\bcloses?\b/i, /\b\d{1,2}(:\d{2})?\s*(a\.?m\.?|p\.?m\.?)|\b\d{1,2}:\d{2}\b|\bo'clock\b|\(\d{2}:\d{2}\)/i],
  [/\bhow much\b|\bprice\b|\bcost\b|\bfee\b|\bin (hong kong |us |hk )?dollars\b|\bexchange\b/i, /[$¥€£]|\bHK\$|\b(HKD|USD|JPY|EUR|GBP|dollars?|yen)\b/i],
  [/\bhow (long|far)\b|\bduration\b|\bflight time\b|\bdistance\b/i, /\b\d+(\.\d+)?\s*(h|hr|hrs|hours?|min|mins|minutes?|km|kilomet(re|er)s?|miles?)\b/i],
  [/\bhow (tall|high)\b|\bheight\b|\belevation\b/i, /\b\d[\d,.]*\s*(m|metres?|meters?|ft|feet)\b/i],
  [/\bwhen\b|\byear\b|\bfounded\b|\bborn\b|\bbuilt\b/i, /\b(1[5-9]|20)\d{2}\b/],
  [/\bpopulation\b|\bhow many\b/i, /\b\d[\d,.]*\s*(million|billion|thousand|people|residents)?\b/i],
  [/\bweather\b|\btemperature\b/i, /°|\bdegrees?\b/i],
];

/** web pages split sentences across text runs: "… starts every night at" + "8:00 p.m. sharp" -> one line */
export function joinFragments(screen: string[]): string[] {
  const out: string[] = [];
  for (const line of screen) {
    const prev = out[out.length - 1];
    if (prev && /\b(at|is|are|was|from|of|by|to|around|about|approximately|until|costs?|takes?)$|[:–-]$/i.test(prev) && /^[\d$¥€£(]|^(HK\$|US\$)/.test(line) && line.length < 120) {
      out[out.length - 1] = `${prev} ${line}`;
    } else out.push(line);
  }
  return out;
}

export function relevantLines(screen: string[], goal: string, n = 40, head = 12): string[] {
  if (screen.length <= n) return screen;
  const g = new Set(words(goal).filter((w) => w.length > 2));
  const shapes = ANSWER_SHAPES.filter(([q]) => q.test(goal)).map(([, a]) => a);
  const scored = screen.map((line, i) => ({
    line, i,
    s: words(line).filter((w) => g.has(w)).length + (/\d{3,4}/.test(line) ? 0.5 : 0) + (shapes.some((a) => a.test(line)) ? 3 : 0),
  }));
  const pick = new Set<number>(scored.slice(0, head).map((x) => x.i));
  for (const x of [...scored].sort((a, b) => b.s - a.s)) {
    if (pick.size >= n) break;
    if (x.s > 0) pick.add(x.i);
  }
  return scored.filter((x) => pick.has(x.i)).map((x) => x.line);
}
