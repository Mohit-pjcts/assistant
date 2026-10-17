// Web forms through Cua's browser tools (src/webform.ts): the parser against REAL snapshots captured from Chrome (tests/fixtures,
// 13 Oct 2026, a replica of a Google Form), and the fill / navigate logic against a small simulated browser that reproduces what
// was measured of Cua: a ref dies as soon as a newer snapshot is taken, refs are re-ranked by distance from the viewport once the
// page scrolls, trusted clicks are refused on macOS, and a second browser on a saved profile is refused.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { RawCall } from "../src/driver.ts";
import { AgentBrowser, matchOption, norm, parseForm, parseOutline, type Snapshot } from "../src/webform.ts";

const fixture = (name: string): Snapshot => JSON.parse(readFileSync(join(import.meta.dir, "fixtures", `${name}.json`), "utf8"));

// ---------- the parser, on real captures ----------

test("outline lines: a quoted name, an optional ': value' (a filled field) and optional [states]", () => {
  const n = parseOutline([
    '- heading "Society Registration"',
    '- textbox "Full name *": Mohit Reddy [editable="plaintext",focused=true,required=true]',
    '- radio "Yes" [checked="true"]',
    '  - generic [editable="plaintext"]',
    '- textbox "Say \\"hi\\"" [required=false]',
    '- textbox "Notes": a [b] c [required=false]',
  ].join("\n"));
  expect(n.map((x) => [x.role, x.name, x.value])).toEqual([
    ["heading", "Society Registration", undefined], ["textbox", "Full name *", "Mohit Reddy"], ["radio", "Yes", undefined],
    ["generic", "", undefined], ["textbox", 'Say "hi"', undefined], ["textbox", "Notes", "a [b] c"],
  ]);
});

test("a fresh page: every question with its kind, options, required flag; the dropdown's list is not known until it is opened", () => {
  const { view, buttons } = parseForm(fixture("webform-fresh"));
  expect(view.title).toBe("Society Registration");
  expect(view.buttons).toEqual(["Next"]);
  expect(buttons).toHaveLength(1);
  const by = (label: string) => view.fields.find((f) => norm(f.label).startsWith(norm(label)))!;
  expect(by("Full name")).toMatchObject({ kind: "text", required: true, value: "" });
  expect(by("Year of study")).toMatchObject({ kind: "choice", required: true, options: ["First year", "Second year", "Third year", "Fourth year or above"], value: "" });
  expect(by("Your programme")).toMatchObject({ kind: "dropdown", required: true, value: "" });
  expect(by("Your programme").options).toBeUndefined();
  expect(by("Courses you are taking")).toMatchObject({ kind: "multi", required: false, value: [] });
  expect(by("Courses you are taking").options).toHaveLength(8);
  expect(by("Do you have any dietary").options).toEqual(["Yes", "No"]);
  expect(view.fields.filter((f) => /^Optional question/.test(f.label))).toHaveLength(22);
  expect(by("Tell us a bit").kind).toBe("text");
});

test("an opened dropdown lists its choices (they are options inside its listbox)", () => {
  const { items } = parseForm(fixture("webform-dropdown-open"));
  const dd = items.find((i) => i.field.kind === "dropdown")!;
  expect(dd.opts.map((o) => o.text)).toEqual(["Choose", "BEng (Computer Science)", "BSc (Data Science)", "BA&BEng (AI and Data Science)", "BBA (Business Analytics)", "Other"]);
  expect(dd.opts.every((o) => !!o.ref)).toBe(true);
  expect(dd.field.options).toEqual(["BEng (Computer Science)", "BSc (Data Science)", "BA&BEng (AI and Data Science)", "BBA (Business Analytics)", "Other"]);
});

test("after the page scrolled, refs come in a different order (live: the Yes/No answer read back as blank): every option still has its ref and its state", () => {
  const { items } = parseForm(fixture("webform-scrolled"));
  const diet = items.find((i) => /dietary/i.test(i.field.label))!;
  expect(diet.opts.map((o) => [o.text, o.on, !!o.ref])).toEqual([["Yes", false, true], ["No", true, true]]);
  expect(diet.field.value).toBe("No");
  const year = items.find((i) => /Year of study/i.test(i.field.label))!;
  expect(year.opts.every((o) => !!o.ref)).toBe(true);
  expect(items.find((i) => i.field.label === "Optional question 22")!.field.value).toBe("far down");
  // refs are never reused between two options
  const all = items.flatMap((i) => [i.ref, ...i.opts.map((o) => o.ref)]).filter(Boolean);
  expect(new Set(all).size).toBe(all.length);
});

// a hand-made scrolled capture with TWO identical Yes/No questions, one on screen (low ref numbers) and one far below (high numbers)
const ref = (n: number, role: string, name: string, visibility: string, states: Record<string, unknown> = {}) => ({ ref: `p1:${n}`, role, name, states, actions: role === "statictext" ? [] : ["click", "pointer"], value: null, visibility });
test("two questions with the same Yes / No options: each option is bound by walking the outline, preferring the same visibility class and the next-higher ref", () => {
  const snap: Snapshot = {
    page: { title: "t", url: "u" },
    outline: [
      '- statictext "Member already?"', '- radiogroup "Member already?"', '  - radio "Yes" [checked="false"]', '  - radio "No" [checked="true"]',
      '- statictext "Receive emails?"', '- radiogroup "Receive emails?"', '  - radio "Yes" [checked="true"]', '  - radio "No" [checked="false"]',
    ].join("\n"),
    // the second question is the one on screen: it is ranked first
    refs: [
      ref(1, "statictext", "Receive emails?", "in_viewport"), ref(2, "radio", "Yes", "in_viewport", { checked: "true" }), ref(3, "radio", "No", "in_viewport", { checked: "false" }),
      ref(50, "statictext", "Member already?", "offscreen"), ref(51, "radio", "Yes", "offscreen", { checked: "false" }), ref(52, "radio", "No", "offscreen", { checked: "true" }),
    ] as any,
  };
  const { items } = parseForm(snap);
  const member = items.find((i) => i.field.label === "Member already?")!;
  const emails = items.find((i) => i.field.label === "Receive emails?")!;
  expect(member.opts.map((o) => [o.text, o.ref, o.on])).toEqual([["Yes", "p1:51", false], ["No", "p1:52", true]]);
  expect(emails.opts.map((o) => [o.text, o.ref, o.on])).toEqual([["Yes", "p1:2", true], ["No", "p1:3", false]]);
  expect(member.field.value).toBe("No");
  expect(emails.field.value).toBe("Yes");
});

test("a finished form has no questions and reports its confirmation text", () => {
  const { view } = parseForm({ page: { title: "Thanks", url: "u" }, outline: '- heading "Your response has been recorded."', refs: [] });
  expect(view.fields).toEqual([]);
  expect(view.confirmation).toBe("Your response has been recorded.");
});

test("choosing an option by name: exact (case, marks and '*' ignored), else the one that contains it, else nothing, and several is reported, never guessed", () => {
  const opts = [{ text: "First year" }, { text: "Second year" }, { text: "Fourth year or above" }];
  expect(matchOption(opts, "second YEAR").hit?.text).toBe("Second year");
  expect(matchOption(opts, "Fourth").hit?.text).toBe("Fourth year or above");
  expect(matchOption(opts, "Fifth year").hit).toBeUndefined();
  expect(matchOption(opts, "year").ambiguous?.length).toBe(3);
  expect(matchOption([{ text: "‎Yes" }, { text: "No" }], "yes").hit?.text).toBe("‎Yes");
});

// ---------- a simulated browser ----------

type Q =
  | { kind: "text"; label: string; value: string }
  | { kind: "radio"; label: string; options: string[]; value: string }
  | { kind: "checks"; label: string; options: string[]; value: string[] }
  | { kind: "drop"; label: string; options: string[]; value: string; open: boolean };
interface SimNode { role: string; name: string; value?: string; states: Record<string, unknown>; actions: string[]; apply?: () => void; domIndex: number }

class SimBrowser {
  page: "form" | "page2" | "done" = "form";
  qs: Q[] = [
    { kind: "text", label: "Full name *", value: "" },
    { kind: "radio", label: "Member already? *", options: ["Yes", "No"], value: "" },
    { kind: "drop", label: "Programme *", options: ["BEng", "BSc", "BA&BEng (AI and Data Science)"], value: "", open: false },
    { kind: "checks", label: "Courses", options: ["COMP2119", "COMP2501", "MATH2014"], value: [] },
    { kind: "radio", label: "Receive emails? *", options: ["Yes", "No"], value: "" },
    ...Array.from({ length: 16 }, (_, i) => ({ kind: "text", label: `Filler ${i + 1}`, value: "" }) as Q),
    { kind: "text", label: "About you", value: "" },
  ];
  else = "";
  seq = 0;
  focused?: string;
  scrolled = false;
  calls: string[] = [];
  clicks: string[] = [];
  trusted = false; // refuse trusted clicks like macOS does
  failNext: Record<string, string> = {}; // tool -> error text to return once
  launched = 0;
  refuseLaunch = false;
  attachedPid?: number;
  private live = new Map<string, SimNode>();

  private nodes(): { outline: string[]; nodes: SimNode[] } {
    const outline: string[] = []; const nodes: SimNode[] = []; let d = 0;
    const add = (n: Omit<SimNode, "domIndex">, line: string) => { nodes.push({ ...n, domIndex: d++ }); outline.push(line); };
    if (this.page === "done") { outline.push('- heading "Your response has been recorded."'); return { outline, nodes }; }
    const list: Q[] = this.page === "form" ? this.qs : [{ kind: "text", label: "Anything else?", value: this.else }];
    outline.push('- heading "Sim Form"');
    for (const q of list) {
      add({ role: "statictext", name: q.label, states: {}, actions: [] }, `- statictext "${q.label}"`);
      if (q.kind === "text") {
        add({ role: "textbox", name: q.label, value: q.value, states: { editable: "plaintext", required: /\*/.test(q.label) }, actions: ["type", "pointer"],
          apply: undefined }, `- textbox "${q.label}"${q.value ? `: ${q.value}` : ""} [editable="plaintext"]`);
      } else if (q.kind === "radio") {
        outline.push(`- radiogroup "${q.label}" [required=false]`);
        for (const o of q.options) add({ role: "radio", name: o, states: { checked: String(q.value === o) }, actions: ["click", "pointer"], apply: () => { q.value = o; } }, `  - radio "${o}" [checked="${q.value === o}"]`);
      } else if (q.kind === "checks") {
        outline.push(`- group "${q.label}"`);
        for (const o of q.options) add({ role: "checkbox", name: o, states: { checked: String(q.value.includes(o)) }, actions: ["click", "pointer"], apply: () => { q.value = q.value.includes(o) ? q.value.filter((x) => x !== o) : [...q.value, o]; } }, `  - checkbox "${o}" [checked="${q.value.includes(o)}"]`);
      } else {
        add({ role: "listbox", name: q.label, states: {}, actions: ["click", "pointer"], apply: () => { q.open = !q.open; } }, `- listbox "${q.label}"`);
        add({ role: "option", name: q.value || "Choose", states: { selected: true }, actions: ["click", "pointer"] }, `  - option "${q.value || "Choose"}" [selected=true]`);
        if (q.open) for (const o of q.options) add({ role: "option", name: o, states: { selected: false }, actions: ["click", "pointer"], apply: () => { q.value = o; q.open = false; } }, `  - option "${o}" [selected=false]`);
      }
    }
    const buttons = this.page === "form" ? [["Next", () => { this.page = "page2"; this.scrolled = false; }]] : [["Back", () => { this.page = "form"; }], ["Submit", () => { this.page = "done"; }]];
    for (const [name, fn] of buttons as [string, () => void][]) add({ role: "button", name, states: {}, actions: ["click", "pointer"], apply: fn }, `- button "${name}" [focusable=true]`);
    return { outline, nodes };
  }

  snapshot() {
    this.seq++;
    const { outline, nodes } = this.nodes();
    // once the page has scrolled to the bottom: the typed-into field first, the last nodes "in viewport", their neighbours "near", the rest after
    const interactive = nodes.length;
    const cls = (n: SimNode) => (!this.scrolled ? (n.domIndex < 12 ? 0 : n.domIndex < 30 ? 1 : 2) : n.domIndex >= interactive - 8 ? 0 : n.domIndex >= interactive - 20 ? 1 : 2);
    const order = [...nodes].sort((a, b) => (a.name === this.focused ? -1 : 0) - (b.name === this.focused ? -1 : 0) || cls(a) - cls(b) || a.domIndex - b.domIndex);
    this.live.clear();
    const refs = order.map((n, k) => {
      const id = `p${this.seq}:${k}`;
      this.live.set(id, n);
      return { ref: id, role: n.role, name: n.name, value: n.value ?? null, states: n.states, actions: n.actions, visibility: ["in_viewport", "near_viewport", "offscreen"][cls(n)] };
    });
    return { status: "ok", page: { title: "Sim", url: "http://sim/form" }, outline: outline.join("\n"), refs, snapshot: { id: `p${this.seq}`, complete: true } };
  }

  /** the Cua CLI as the module calls it */
  cua = async (tool: string, args: any): Promise<RawCall> => {
    this.calls.push(tool);
    const done = (json: any): RawCall => ({ json, raw: JSON.stringify(json), exit: 0, ms: 1, cli: tool });
    if (this.failNext[tool]) { const t = this.failNext[tool]!; delete this.failNext[tool]; return { json: undefined, raw: t, exit: 1, ms: 1, cli: tool }; }
    switch (tool) {
      case "start_session": return done({ active: true });
      case "end_session": return done({ active: false });
      case "bring_to_front": return done({ status: "ok" });
      case "browser_prepare":
        if (args.pid) { this.attachedPid = args.pid; return done({ status: "ok", prepared_pid: args.pid }); }
        if (this.refuseLaunch) return done({ refusal: { code: "browser_endpoint_owner_mismatch" }, status: "refused" });
        this.launched++; return done({ status: "ok", prepared_pid: 4242 });
      case "list_windows": return done({ windows: [{ pid: this.attachedPid ?? 4242, window_id: 7, bounds: { height: 900 } }] });
      case "get_browser_state":
        if (args.pid) return done({ target_id: "bt-1", tabs: [{ tab_id: "tab-1", active: true }] });
        return done(this.snapshot());
      case "browser_navigate": this.page = "form"; this.scrolled = false; return done({ status: "ok" });
      case "browser_type": {
        const n = this.live.get(args.ref);
        if (!n) return done({ error: { code: "browser_ref_stale", hint: "ref is stale" } });
        const q = this.qs.find((x) => x.kind === "text" && x.label === n.name);
        if (q && q.kind === "text") q.value = args.text; else if (n.name === "Anything else?") this.else = args.text;
        this.focused = n.name; this.scrolled = this.qs.findIndex((x) => x.label === n.name) > 8;
        return done({ status: "ok" });
      }
      case "browser_click": {
        if (args.input_route !== "dom_event") return done({ error: { code: "browser_input_trust_unavailable", hint: "use dom_event" } });
        const n = this.live.get(args.ref);
        if (!n) return done({ error: { code: "browser_ref_stale", hint: "ref is stale" } });
        this.clicks.push(`${n.role}:${n.name}`);
        n.apply?.();
        return done({ status: "ok" });
      }
      default: return done({ error: { code: "unknown_tool" } });
    }
  };
}

const browserOn = (sim: SimBrowser, extra: object = {}) => new AgentBrowser({ session: "T", cua: sim.cua as any, findPid: async () => undefined, noWait: true, ...extra });

test("open: launches the agent browser once and reads every question; the dropdown is opened and closed to learn its choices", async () => {
  const sim = new SimBrowser();
  const view = await browserOn(sim).open("http://sim/form");
  expect(sim.launched).toBe(1);
  expect(view.fields.map((f) => f.label).slice(0, 5)).toEqual(["Full name *", "Member already? *", "Programme *", "Courses", "Receive emails? *"]);
  expect(view.fields.find((f) => f.kind === "dropdown")!.options).toEqual(["BEng", "BSc", "BA&BEng (AI and Data Science)"]);
  expect((sim.qs[2] as any).open).toBe(false); // closed again
  expect(view.buttons).toEqual(["Next"]);
});

test("fill: text, two identical Yes/No questions, a dropdown, several ticks and an off-screen field all land, and each is read back from the page", async () => {
  const sim = new SimBrowser();
  const b = browserOn(sim);
  await b.open("http://sim/form");
  const { results } = await b.fill([
    { field: "Full name", value: "Mohit Reddy Vuyyuru" },
    { field: "Member already?", value: "No" },
    { field: "Receive emails?", value: "Yes" },
    { field: "Programme", value: "BA&BEng (AI and Data Science)" },
    { field: "Courses", value: ["COMP2119", "MATH2014"] },
    { field: "About you", value: "I study AI at HKU." },
  ]);
  expect(results.map((r) => [r.field, r.status])).toEqual([["Full name", "filled"], ["Member already?", "filled"], ["Receive emails?", "filled"], ["Programme", "filled"], ["Courses", "filled"], ["About you", "filled"]]);
  const v = (l: string) => sim.qs.find((q) => q.label.startsWith(l)) as any;
  expect(v("Full name").value).toBe("Mohit Reddy Vuyyuru");
  expect(v("Member").value).toBe("No");
  expect(v("Receive").value).toBe("Yes"); // the OTHER Yes/No question was not touched by the first
  expect(v("Programme").value).toBe("BA&BEng (AI and Data Science)");
  expect(v("Courses").value).toEqual(["COMP2119", "MATH2014"]);
  expect(v("About").value).toBe("I study AI at HKU.");
  expect(results.find((r) => r.field === "Member already?")!.now).toBe("No"); // read back after the page scrolled
  expect(results.find((r) => r.field === "Courses")!.now).toEqual(["COMP2119", "MATH2014"]);
  expect(results.find((r) => r.field === "Full name")!.now).toBe("Mohit Reddy Vuyyuru");
});

test("fill: what cannot be done is reported with the choices, never guessed or silently skipped", async () => {
  const sim = new SimBrowser();
  const b = browserOn(sim);
  await b.open("http://sim/form");
  const { results } = await b.fill([
    { field: "Shoe size", value: "42" },
    { field: "Member already?", value: "Maybe" },
    { field: "Programme", value: "MBA" },
    { field: "Filler", value: "x" }, // matches 16 questions
  ]);
  expect(results[0]).toMatchObject({ status: "not_found" });
  expect(results[0]!.options).toContain("Full name *");
  expect(results[1]).toMatchObject({ status: "no_option", options: ["Yes", "No"] });
  expect(results[2]).toMatchObject({ status: "no_option", options: ["BEng", "BSc", "BA&BEng (AI and Data Science)"] });
  expect(results[3]!.status).toBe("ambiguous");
  expect((sim.qs[1] as any).value).toBe(""); // nothing was clicked for a wrong option
  expect((sim.qs[2] as any).open).toBe(false); // and the dropdown was closed again
});

test("fill: an option that is already chosen or ticked is not clicked again (a second click would untick it)", async () => {
  const sim = new SimBrowser();
  const b = browserOn(sim);
  await b.open("http://sim/form");
  await b.fill([{ field: "Courses", value: ["COMP2119"] }]);
  sim.clicks.length = 0;
  const { results } = await b.fill([{ field: "Courses", value: ["COMP2119", "COMP2501"] }]);
  expect(sim.clicks).toEqual(["checkbox:COMP2501"]);
  expect((sim.qs[3] as any).value).toEqual(["COMP2119", "COMP2501"]);
  expect(results[0]!.status).toBe("filled");
});

test("every click is a background (dom_event) click: the trusted route would bring the browser window forward", async () => {
  const sim = new SimBrowser();
  const b = browserOn(sim);
  await b.open("http://sim/form");
  const { results } = await b.fill([{ field: "Member already?", value: "Yes" }]);
  expect(results[0]!.status).toBe("filled"); // the simulator refuses any click without input_route: "dom_event"
});

test("press: Next moves to the second page, Submit finishes with the confirmation text; an unknown button says which exist", async () => {
  const sim = new SimBrowser();
  const b = browserOn(sim);
  await b.open("http://sim/form");
  expect(b.press("launch")).rejects.toThrow(/no "launch" button.*Next/);
  const p2 = await b.press("next");
  expect(p2.fields.map((f) => f.label)).toEqual(["Anything else?"]);
  expect(p2.buttons).toEqual(["Back", "Submit"]);
  await b.fill([{ field: "Anything else", value: "No." }]);
  expect(sim.else).toBe("No.");
  const done = await b.press("submit");
  expect(done.confirmation).toBe("Your response has been recorded.");
  expect(done.fields).toEqual([]);
});

test("refs die with the next snapshot: a long answer list works because every field is read fresh just before it is acted on", async () => {
  const sim = new SimBrowser();
  const b = browserOn(sim);
  await b.open("http://sim/form");
  const answers = Array.from({ length: 16 }, (_, i) => ({ field: `Filler ${i + 1}`, value: `answer ${i + 1}` }));
  const { results } = await b.fill(answers);
  expect(results.every((r) => r.status === "filled")).toBe(true);
  expect(sim.qs.filter((q) => /^Filler/.test(q.label)).every((q: any, i) => q.value === `answer ${i + 1}`)).toBe(true);
});

test("a browser of the same saved profile that is already running (a crash, an earlier run) is attached to, not an error", async () => {
  const sim = new SimBrowser();
  sim.refuseLaunch = true;
  const b = new AgentBrowser({ session: "T", cua: sim.cua as any, findPid: async () => 777, noWait: true });
  const view = await b.open("http://sim/form");
  expect(sim.attachedPid).toBe(777);
  expect(sim.launched).toBe(0);
  expect(view.fields.length).toBeGreaterThan(5);
});

test("no browser to launch and none running: the error says so", async () => {
  const sim = new SimBrowser();
  sim.refuseLaunch = true;
  expect(browserOn(sim).open("http://sim/form")).rejects.toThrow(/could not start the agent browser/);
});

test("if the session ended meanwhile (idle timeout), the browser is relaunched and the call retried once", async () => {
  const sim = new SimBrowser();
  const b = browserOn(sim);
  await b.open("http://sim/form");
  expect(sim.launched).toBe(1);
  sim.failNext["get_browser_state"] = "session has ended; tool call was rejected";
  const view = await b.view();
  expect(sim.launched).toBe(2);
  expect(view.fields.length).toBeGreaterThan(5);
});

test("front: opens an address if given, brings the window forward, and says where it is", async () => {
  const sim = new SimBrowser();
  const b = browserOn(sim);
  const where = await b.front("http://sim/form");
  expect(sim.calls).toContain("bring_to_front");
  expect(where.url).toBe("http://sim/form");
});

test("close: ends the session", async () => {
  const sim = new SimBrowser();
  const b = browserOn(sim);
  await b.open("http://sim/form");
  await b.close();
  expect(sim.calls.at(-1)).toBe("end_session");
});
