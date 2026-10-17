// Web forms (Google Forms, Microsoft Forms, any page with questions) through Cua's browser tools, not the accessibility tree.
//
// Why a separate route (measured, 13 Oct 2026, against a replica of a Google Form in Brave/Chrome):
//  - the page's accessibility tree through the user's own Brave left a custom dropdown unreachable (twice, 10-11 steps each), and
//    typing into a field was refused ("keyboard_ambiguity": the user's Brave has a second window), fell back to foreground
//    keystrokes that never arrived, and the task still said "done";
//  - Cua's browser_* tools talk to the page itself (DevTools): every question is an element with a name, a type and a ref, a
//    field is typed into (and its value read back) with no keyboard focus involved, and a choice is a click on the option's ref.
//    The same form filled completely, off-screen questions included, in about a second per field.
//
// The agent works in its OWN browser window with a saved profile ("oni-agent", kept by Cua under
// ~/Library/Application Support/CuaDriver/BrowserProfiles): the user signs into Google / Microsoft there once and the login stays.
// It is deliberately not the user's everyday Brave profile: attaching to that needs a daemon-wide "existing-profile" grant that
// would let anything local drive every logged-in site, which is the user's decision to make, not a default.
//
// What Oni gets: read the questions (label, kind, options, required, current answer), fill answers by field, click Next /
// Back / Submit. Oni decides every answer (from the vault, or by asking the user); this module only does what it is told and reads
// every answer back to say whether it really landed.
import { cua as realCua, type RawCall } from "./driver.ts";

export type CuaFn = (tool: string, args: object, timeoutMs?: number) => Promise<RawCall>;

interface Ref { ref: string; role: string; name?: string | null; value?: unknown; states?: Record<string, unknown>; actions?: string[]; visibility?: string }
export interface Snapshot { page?: { title?: string; url?: string }; outline?: string; refs?: Ref[]; status?: string; error?: { code?: string; hint?: string } }

export type FieldKind = "text" | "choice" | "multi" | "dropdown";
export interface FormField {
  id: string;
  label: string;
  kind: FieldKind;
  required: boolean;
  /** the choices; undefined for a dropdown whose list has not been opened yet */
  options?: string[];
  /** the current answer: text, the chosen option, or the ticked options */
  value?: string | string[];
}
export interface FormView { title: string; url: string; fields: FormField[]; buttons: string[]; confirmation?: string }
export interface FieldAnswer { field: string; value: string | string[] }
export interface FieldResult { field: string; label?: string; status: "filled" | "not_found" | "no_option" | "failed" | "ambiguous"; detail?: string; options?: string[]; now?: string | string[] }

interface Opt { text: string; ref: string; on: boolean }
interface Internal { field: FormField; ref?: string; opts: Opt[] }
export interface Parsed { view: FormView; items: Internal[]; buttons: { text: string; ref: string }[] }

const ACTION_ROLES = new Set(["textbox", "checkbox", "radio", "option", "button", "listbox", "combobox", "searchbox"]);
/** the button names that move through or finish a form: shown to the caller, found again by name */
const NAV_BUTTON = /^(next|back|previous|continue|submit|send|clear form|finish|done)\b/i;
const DONE_TEXT = /(your response has been recorded|has been recorded|response (was )?submitted|thanks? (you )?for (your )?(submitting|response|filling)|thank you|submitted successfully)/i;

export const norm = (s: string | undefined | null): string =>
  String(s ?? "").normalize("NFKC").toLowerCase().replace(/[‎‏‪-‮]/g, "").replace(/[*:·•]+/g, " ").replace(/\s+/g, " ").trim();
const clean = (s: string | undefined | null): string => String(s ?? "").replace(/[‎‏‪-‮]/g, "").replace(/\s+/g, " ").trim();

interface Node { role: string; name: string; states: string; value?: string }
/**
 * `- textbox "Full name *": Mohit Reddy [editable="plaintext",required=true]`: a role, an optional quoted name, an optional
 * `: value` (a filled field shows what it holds there), an optional `[states]`. (Live: before the value part was read, a field
 * that had just been typed into dropped out of the page.)
 */
export function parseOutline(outline: string): Node[] {
  const nodes: Node[] = [];
  for (const line of outline.split("\n")) {
    const head = line.match(/^\s*- ([a-z]+)(.*)$/);
    if (!head) continue;
    let rest = head[2]!;
    let name = "";
    const q = rest.match(/^ "((?:[^"\\]|\\.)*)"/);
    if (q) { name = q[1]!.replace(/\\(.)/g, "$1"); rest = rest.slice(q[0].length); }
    let states = "";
    const st = rest.match(/\s\[([^\]]*)\]\s*$/);
    if (st) { states = st[1]!; rest = rest.slice(0, st.index); }
    const value = rest.startsWith(":") ? rest.slice(1).trim() : undefined;
    nodes.push({ role: head[1]!, name, states, value });
  }
  return nodes;
}

/** one snapshot of a page -> its questions. Pure: no browser calls. */
export function parseForm(snap: Snapshot): Parsed {
  const nodes = parseOutline(snap.outline ?? "");
  // The outline is in document order but carries no refs. The refs are NOT in document order once the page has scrolled (Cua
  // ranks them by distance from the viewport: a field that was just typed into, then what is on screen, then what is near,
  // then the rest, each in document order; measured 13 Oct), so a node is matched to a ref by role and name, and where several
  // refs share them (two "Yes / No" questions, an "Other" in every list) the pick follows the walk: the same visibility
  // class as the node before it, with the next-higher ref number. That is document order inside a class.
  const num = (r: Ref) => Number(String(r.ref).split(":")[1]);
  const unused = new Map<string, Ref[]>();
  for (const r of snap.refs ?? []) {
    if (!r.name) continue;
    const key = `${r.role}|${clean(r.name)}`;
    (unused.get(key) ?? unused.set(key, []).get(key)!).push(r);
  }
  let last: { k: number; cls?: string } | undefined;
  const take = (role: string, name: string): Ref | undefined => {
    const cands = unused.get(`${role}|${clean(name)}`);
    if (!cands?.length) return undefined;
    let pool = cands;
    if (cands.length > 1 && last) {
      const sameClass = cands.filter((c) => c.visibility === last!.cls && num(c) > last!.k);
      const later = cands.filter((c) => num(c) > last!.k);
      pool = sameClass.length ? sameClass : later.length ? later : cands;
    }
    const hit = [...pool].sort((x, y) => num(x) - num(y))[0]!;
    cands.splice(cands.indexOf(hit), 1);
    last = { k: num(hit), cls: hit.visibility };
    return hit;
  };
  const bound: { node: Node; ref?: Ref }[] = nodes.map((node) => ({ node, ref: node.name ? take(node.role, node.name) : undefined }));

  const items: Internal[] = [];
  const buttons: { text: string; ref: string }[] = [];
  let lastText = "";
  let title = "";
  let group: { kind: "choice" | "multi" | "dropdown"; item: Internal } | undefined;
  const push = (field: Omit<FormField, "id">, ref?: string): Internal => {
    const item: Internal = { field: { id: `q${items.length + 1}`, ...field }, ref, opts: [] };
    items.push(item);
    return item;
  };
  const checked = (r?: Ref) => String(r?.states?.checked ?? "") === "true";

  for (const { node, ref } of bound) {
    const name = clean(node.name);
    switch (node.role) {
      case "heading": if (!title) title = name; lastText = name; break;
      case "statictext": {
        // an option's own label is printed again after it: not a question
        if (group && group.item.opts.some((o) => norm(o.text) === norm(name))) break;
        lastText = name;
        break;
      }
      case "radiogroup": group = { kind: "choice", item: push({ label: name, kind: "choice", required: /\*\s*$/.test(name) || /required=true/.test(node.states), options: [] }) }; break;
      case "group": group = { kind: "multi", item: push({ label: name, kind: "multi", required: /\*\s*$/.test(name), options: [] }) }; break;
      case "listbox":
      case "combobox": {
        const item = push({ label: name || lastText, kind: "dropdown", required: /\*\s*$/.test(name || lastText) || /required=true/.test(node.states) }, ref?.ref);
        group = { kind: "dropdown", item };
        break;
      }
      case "radio":
      case "checkbox": {
        const kind = node.role === "radio" ? "choice" : "multi";
        if (!group || group.item.field.kind !== kind) {
          // a lone choice/tick box (no group around it): the nearest text above is its question
          group = { kind, item: push({ label: lastText || name, kind, required: /\*\s*$/.test(lastText), options: [] }) };
        }
        if (ref) group.item.opts.push({ text: name, ref: ref.ref, on: checked(ref) });
        break;
      }
      case "option": {
        if (group?.kind === "dropdown" && ref) group.item.opts.push({ text: name, ref: ref.ref, on: String(ref.states?.selected ?? "") === "true" });
        break;
      }
      case "textbox":
      case "searchbox": {
        group = undefined;
        const value = typeof ref?.value === "string" ? ref.value : node.value ?? "";
        push({ label: name || lastText, kind: "text", required: /required=true/.test(node.states) || /\*\s*$/.test(name || lastText), value }, ref?.ref);
        break;
      }
      case "button": {
        group = undefined;
        if (ref && NAV_BUTTON.test(name)) buttons.push({ text: name, ref: ref.ref });
        break;
      }
      default: break;
    }
  }

  for (const it of items) {
    const f = it.field;
    if (f.kind === "choice") { f.options = it.opts.map((o) => o.text); f.value = it.opts.find((o) => o.on)?.text ?? ""; }
    else if (f.kind === "multi") { f.options = it.opts.map((o) => o.text); f.value = it.opts.filter((o) => o.on).map((o) => o.text); }
    else if (f.kind === "dropdown") {
      const sel = it.opts.find((o) => o.on);
      f.value = sel && !/^choose$/i.test(sel.text) ? sel.text : "";
      f.options = it.opts.length > 1 ? it.opts.filter((o) => !/^choose$/i.test(o.text)).map((o) => o.text) : undefined;
    }
  }
  const fields = items.map((i) => i.field).filter((f) => f.label || (f.options?.length ?? 0) > 0);
  const confirmation = fields.length === 0 ? nodes.find((n) => n.role === "heading" && DONE_TEXT.test(n.name))?.name ?? nodes.find((n) => n.role === "statictext" && DONE_TEXT.test(n.name))?.name : undefined;
  return { view: { title: title || snap.page?.title || "", url: snap.page?.url ?? "", fields, buttons: buttons.map((b) => b.text), confirmation }, items: items.filter((i) => fields.includes(i.field)), buttons };
}

/** the one option of `options` that `want` names: exact (case/marks ignored), else the only one containing it or contained in it */
export function matchOption<T extends { text: string }>(options: T[], want: string): { hit?: T; ambiguous?: T[] } {
  const w = norm(want);
  if (!w) return {};
  const exact = options.filter((o) => norm(o.text) === w);
  if (exact.length === 1) return { hit: exact[0] };
  if (exact.length > 1) return { ambiguous: exact };
  const loose = options.filter((o) => norm(o.text).includes(w) || (norm(o.text).length >= 3 && w.includes(norm(o.text))));
  if (loose.length === 1) return { hit: loose[0] };
  if (loose.length > 1) return { ambiguous: loose };
  return {};
}

function findField(items: Internal[], key: string): { item?: Internal; ambiguous?: Internal[] } {
  const byId = items.find((i) => i.field.id === key.trim().toLowerCase());
  if (byId) return { item: byId };
  const { hit, ambiguous } = matchOption(items.map((i) => ({ text: i.field.label, i })), key);
  return { item: hit?.i, ambiguous: ambiguous?.map((a) => a.i) };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const errOf = (rc: RawCall): string | undefined => {
  const e = (rc.json as any)?.error;
  if (e) return `${e.code ?? "error"}: ${String(e.hint ?? e.message ?? "").slice(0, 200)}`;
  if (rc.json === undefined) return `no answer: ${rc.raw.slice(0, 160)}`;
  return undefined;
};

/** the running main browser process of a saved profile (left by a crash, an earlier run, a session that outlived Stage), if any */
async function runningBrowserPid(profile: string): Promise<number | undefined> {
  const ps = Bun.spawn(["ps", "-ax", "-o", "pid=,command="], { stdout: "pipe", stderr: "ignore" });
  const out = await new Response(ps.stdout).text();
  const pids = out.split("\n")
    .filter((l) => l.includes(`BrowserProfiles/${profile}`) && !l.includes("--type="))
    .map((l) => Number(l.trim().split(/\s+/)[0]))
    .filter((n) => Number.isInteger(n) && n > 0);
  return pids.sort((a, b) => a - b)[0];
}

export interface BrowserOptions { session?: string; profile?: string; cua?: CuaFn; findPid?: (profile: string) => Promise<number | undefined>; /** tests: do not wait for pages to settle */ noWait?: boolean }

/** The agent's own browser window: launched on first use, rebound if it goes away, one operation at a time. */
export class AgentBrowser {
  readonly session: string;
  readonly profile: string;
  private run: CuaFn;
  private findPid: (profile: string) => Promise<number | undefined>;
  private pause: (ms: number) => Promise<void>;
  private pid?: number;
  private base?: { session: string; target_id: string; tab_id: string };
  private chain: Promise<unknown> = Promise.resolve();

  constructor(o: BrowserOptions = {}) {
    this.session = o.session ?? "Forms";
    this.profile = o.profile ?? "oni-agent";
    this.run = o.cua ?? realCua;
    this.findPid = o.findPid ?? runningBrowserPid;
    this.pause = o.noWait ? async () => {} : sleep;
  }

  /** serialise: two overlapping calls would fight over one page */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => undefined);
    return next;
  }

  private async launch(): Promise<void> {
    await this.run("start_session", { session: this.session });
    let prep = await this.run("browser_prepare", { session: this.session, allow_launch: true, profile: { mode: "isolated_named", name: this.profile } }, 60_000);
    let pid = (prep.json as any)?.prepared_pid as number | undefined;
    if (!pid) {
      // Cua refuses a second browser on a profile that is already open ("endpoint owner mismatch"): the one running is ours
      // (a crash, an earlier run, a session that outlived Stage), so attach to it instead of failing
      const old = await this.findPid(this.profile);
      if (old) {
        prep = await this.run("browser_prepare", { session: this.session, pid: old }, 30_000);
        pid = ((prep.json as any)?.prepared_pid as number | undefined) ?? ((prep.json as any)?.status === "ok" ? old : undefined);
      }
    }
    if (!pid) throw new Error(`could not start the agent browser: ${errOf(prep) ?? JSON.stringify(prep.json).slice(0, 200)}`);
    this.pid = pid;
    await this.bind();
  }

  /** find the browser's window and bind a tab to this session */
  private async bind(): Promise<void> {
    let winId: number | undefined;
    for (let i = 0; i < 25 && winId === undefined; i++) {
      const w = await this.run("list_windows", {}, 8000);
      const mine = ((w.json as any)?.windows ?? []).filter((x: any) => x.pid === this.pid);
      if (mine.length) winId = mine.sort((a: any, b: any) => (b.bounds?.height ?? 0) - (a.bounds?.height ?? 0))[0].window_id;
      else await this.pause(400);
    }
    if (winId === undefined) throw new Error("the agent browser has no window");
    const st = await this.run("get_browser_state", { session: this.session, pid: this.pid, window_id: winId }, 20_000);
    const j = st.json as any;
    const tab = (j?.tabs ?? []).find((t: any) => t.active) ?? j?.tabs?.[0];
    if (!j?.target_id || !tab) throw new Error(`could not attach to the agent browser: ${errOf(st) ?? "no tab"}`);
    this.base = { session: this.session, target_id: j.target_id, tab_id: tab.tab_id };
  }

  private async ensure(): Promise<void> {
    if (this.base) return;
    await this.launch();
  }

  /** a call on the bound tab; if the tab, target or session has gone (idle timeout, closed window) launch/rebind once and retry */
  private async call(tool: string, args: object, timeoutMs = 30_000): Promise<RawCall> {
    await this.ensure();
    let rc = await this.run(tool, { ...this.base!, ...args }, timeoutMs);
    const e = errOf(rc) ?? "";
    if (/session has ended|stale|target|tab|not_found|no such|detached|closed/i.test(e) && !/trust_unavailable/.test(e)) {
      this.base = undefined; this.pid = undefined;
      await this.ensure();
      rc = await this.run(tool, { ...this.base!, ...args }, timeoutMs);
    }
    return rc;
  }

  private async snapshot(): Promise<Snapshot> {
    const rc = await this.call("get_browser_state", { snapshot_format: "semantic_v2" });
    const e = errOf(rc);
    if (e) throw new Error(`could not read the page: ${e}`);
    return rc.json as Snapshot;
  }

  private async click(ref: string): Promise<string | undefined> {
    // a synthetic click on the element: fully background (a trusted click would bring the browser window forward on macOS)
    return errOf(await this.call("browser_click", { ref, input_route: "dom_event" }));
  }

  /** read the page; dropdowns are opened once so their choices are known, then closed again */
  private async read(discover = true): Promise<Parsed> {
    let p = parseForm(await this.snapshot());
    if (discover) {
      for (const it of p.items.filter((i) => i.field.kind === "dropdown" && i.ref && !i.field.options)) {
        const err = await this.click(it.ref!);
        if (err) continue;
        await this.pause(250);
        const opened = parseForm(await this.snapshot());
        const same = opened.items.find((x) => x.field.kind === "dropdown" && norm(x.field.label) === norm(it.field.label));
        const opts = (same?.opts ?? []).filter((o) => !/^choose$/i.test(o.text)).map((o) => o.text);
        if (opts.length) it.field.options = opts;
        if (same?.ref) await this.click(same.ref); // close it again
        await this.pause(150);
      }
      p = { ...p, view: { ...p.view, fields: p.items.map((i) => i.field) } };
    }
    return p;
  }

  open(url: string): Promise<FormView> {
    return this.serial(async () => {
      await this.ensure();
      const nav = await this.call("browser_navigate", { url }, 40_000);
      const e = errOf(nav);
      if (e) throw new Error(`could not open ${url}: ${e}`);
      await this.pause(1500);
      return (await this.read()).view;
    });
  }

  view(): Promise<FormView> {
    return this.serial(async () => (await this.read()).view);
  }

  fill(answers: FieldAnswer[]): Promise<{ results: FieldResult[]; view: FormView }> {
    return this.serial(async () => {
      const results: FieldResult[] = [];
      for (const a of answers) {
        // a fresh read before every field: an answer can change the page (a follow-up question appears), and refs of an
        // older snapshot are no longer valid
        const parsed = await this.read(false);
        const { item, ambiguous } = findField(parsed.items, a.field);
        if (!item) {
          results.push({ field: a.field, status: ambiguous ? "ambiguous" : "not_found", detail: ambiguous ? `matches ${ambiguous.map((i) => i.field.label).join(" | ")}` : `no question matching "${a.field}"`, options: parsed.view.fields.map((f) => f.label) });
          continue;
        }
        results.push(await this.fillOne(item, a, parsed));
      }
      const view = (await this.read(false)).view;
      // read every answer back from the page itself
      for (const r of results) {
        if (r.status !== "filled") continue;
        const f = view.fields.find((x) => norm(x.label) === norm(r.label));
        if (f) r.now = f.value;
      }
      return { results, view };
    });
  }

  private async fillOne(item: Internal, a: FieldAnswer, parsed: Parsed): Promise<FieldResult> {
    const f = item.field;
    const base = { field: a.field, label: f.label };
    const want = Array.isArray(a.value) ? a.value.map(String) : [String(a.value)];
    try {
      if (f.kind === "text") {
        if (!item.ref) return { ...base, status: "failed", detail: "the field has no handle" };
        const err = errOf(await this.call("browser_type", { ref: item.ref, text: want.join("\n") , replace: true }, 40_000));
        if (err) return { ...base, status: "failed", detail: err };
        const after = (await this.read(false)).items.find((i) => norm(i.field.label) === norm(f.label));
        const got = String(after?.field.value ?? "");
        return got.trim() === want.join("\n").trim() ? { ...base, status: "filled" } : { ...base, status: "failed", detail: `the field holds "${got.slice(0, 60)}"`, now: got };
      }
      if (f.kind === "choice" || f.kind === "multi") {
        const missing: string[] = [];
        for (const w of f.kind === "choice" ? want.slice(0, 1) : want) {
          const { hit, ambiguous } = matchOption(item.opts, w);
          if (!hit) { missing.push(ambiguous ? `"${w}" matches several (${ambiguous.map((o) => o.text).join(" | ")})` : `"${w}"`); continue; }
          if (hit.on) continue; // already chosen / ticked
          const err = await this.click(hit.ref);
          if (err) return { ...base, status: "failed", detail: err };
          // a choice can change the page: look again before the next option
          if (f.kind === "multi" && want.length > 1) {
            const again = (await this.read(false)).items.find((i) => norm(i.field.label) === norm(f.label));
            if (again) item.opts = again.opts;
          }
        }
        if (missing.length) return { ...base, status: "no_option", detail: `no option ${missing.join(", ")}`, options: f.options };
        return { ...base, status: "filled" };
      }
      // dropdown: open it, pick the option from the list that appears, check the result
      if (!item.ref) return { ...base, status: "failed", detail: "the dropdown has no handle" };
      const open = await this.click(item.ref);
      if (open) return { ...base, status: "failed", detail: open };
      await this.pause(300);
      const opened = parseForm(await this.snapshot());
      const same = opened.items.find((x) => x.field.kind === "dropdown" && norm(x.field.label) === norm(f.label));
      const { hit, ambiguous } = matchOption((same?.opts ?? []).filter((o) => !/^choose$/i.test(o.text)), want[0]!);
      if (!hit) {
        if (same?.ref) await this.click(same.ref);
        const options = (same?.opts ?? []).filter((o) => !/^choose$/i.test(o.text)).map((o) => o.text);
        return { ...base, status: "no_option", detail: ambiguous ? `"${want[0]}" matches several (${ambiguous.map((o) => o.text).join(" | ")})` : `no option "${want[0]}"`, options };
      }
      const err = await this.click(hit.ref);
      if (err) return { ...base, status: "failed", detail: err };
      await this.pause(250);
      return { ...base, status: "filled" };
    } catch (e: any) {
      return { ...base, status: "failed", detail: String(e?.message ?? e).slice(0, 200) };
    }
  }

  /** click a navigation button by name ("next", "back", "submit", or its exact text) and read the page that follows */
  press(button: string): Promise<FormView> {
    return this.serial(async () => {
      const parsed = await this.read(false);
      const want = norm(button);
      const synonyms: Record<string, RegExp> = { next: /^(next|continue)\b/i, submit: /^(submit|send|finish|done)\b/i, back: /^(back|previous)\b/i };
      const re = synonyms[want];
      const hit = parsed.buttons.find((b) => (re ? re.test(b.text) : norm(b.text) === want));
      if (!hit) throw new Error(`no "${button}" button on this page (buttons: ${parsed.buttons.map((b) => b.text).join(", ") || "none"})`);
      const err = await this.click(hit.ref);
      if (err) throw new Error(`could not press ${hit.text}: ${err}`);
      await this.pause(1500);
      return (await this.read()).view;
    });
  }

  /** bring the agent's window forward, for the one-time sign-in */
  front(url?: string): Promise<{ title: string; url: string }> {
    return this.serial(async () => {
      await this.ensure();
      if (url) {
        const nav = await this.call("browser_navigate", { url }, 40_000);
        const e = errOf(nav);
        if (e) throw new Error(`could not open ${url}: ${e}`);
      }
      await this.run("bring_to_front", { pid: this.pid, session: this.session }, 15_000);
      const snap = await this.snapshot();
      return { title: snap.page?.title ?? "", url: snap.page?.url ?? "" };
    });
  }

  close(): Promise<void> {
    return this.serial(async () => {
      await this.run("end_session", { session: this.session }, 15_000);
      this.base = undefined; this.pid = undefined;
    });
  }
}
