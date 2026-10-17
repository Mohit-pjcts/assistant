// Regressions for what live runs on real apps found (STEPS.md 156): each case is a shape that once made an agent fail
// or act wrongly on this Mac, pinned down offline.
import { expect, test } from "bun:test";
import { homedir } from "node:os";
import type { AxElement, Observation } from "../src/contracts.ts";
import { CLAUSE_JOIN, calcChain, calculatorPlan, compilePlan, explicitText, goalValues, remindersPlan, unquoted, weatherPlan, webPlan, withoutAppSuffix, writePlan } from "../src/compile.ts";
import { folderIn, sameFolder } from "../src/fsops.ts";
import { overlapShare } from "../src/loop.ts";
import { mergeSameApp, splitAtAppBoundaries } from "../src/manager.ts";
import { groundedIn } from "../src/jevhelper.ts";
import { isPlaceholder, namesOfRows, perceive, pressableText } from "../src/perceive.ts";
import { clickForbidden } from "../src/safety.ts";

const el = (index: number, role: string, extra: Partial<AxElement> = {}): AxElement => ({ index, role, depth: 0, actions: [], ...extra });

test("a list row with no label of its own is named by the text inside it (System Settings' sidebar)", () => {
  const els = [
    el(1, "AXOutline"),
    el(2, "AXRow", { parent: 1 }),
    el(3, "AXCell", { parent: 2 }),
    el(4, "AXStaticText", { parent: 3, value: "General" }),
    el(5, "AXRow", { parent: 1 }),
    el(6, "AXStaticText", { parent: 5, label: "About" }),
  ];
  const names = namesOfRows(els);
  expect(names.get(3)).toBe("General"); // the nearest row-like parent takes the name
  expect(names.get(5)).toBe("About");
  expect(names.has(1)).toBe(false);
});

test("pressable text counts as a control (Clock's search results), plain text does not", () => {
  expect(pressableText(el(1, "AXStaticText", { value: "Tokyo", actions: ["AXPress"] }))).toBe(true);
  expect(pressableText(el(2, "AXHeading", { label: "Paris", actions: ["AXPress"] }))).toBe(true);
  expect(pressableText(el(3, "AXStaticText", { value: "Tokyo" }))).toBe(false);
  expect(pressableText(el(4, "AXStaticText", { value: "x".repeat(81), actions: ["AXPress"] }))).toBe(false);
  expect(pressableText(el(5, "AXButton", { label: "OK", actions: ["AXPress"] }))).toBe(false);
});

test("a field that moved a few pixels is still the same field (Dictionary's unlabeled search box)", () => {
  const a = { x: 100, y: 50, w: 300, h: 24 };
  expect(overlapShare(a, { x: 102, y: 51, w: 300, h: 24 })).toBeGreaterThan(0.9);
  expect(overlapShare(a, { x: 100, y: 200, w: 300, h: 24 })).toBe(0);
  expect(overlapShare(a, { x: 0, y: 0, w: 0, h: 0 })).toBe(0);
});

test("two jobs for two apps joined by a comma or 'and' become two tasks; one job stays one", () => {
  const names = ["Calculator", "Weather", "TextEdit", "Finder"];
  expect(splitAtAppBoundaries("compute 76x49 in Calculator, check the weather in Tokyo in Weather", names)).toEqual([
    "compute 76x49 in Calculator",
    "check the weather in Tokyo in Weather",
  ]);
  expect(splitAtAppBoundaries("compute 76x49 in Calculator and write a reminder in TextEdit", names)).toHaveLength(2);
  expect(splitAtAppBoundaries("write hello, world in TextEdit", names)).toEqual(["write hello, world in TextEdit"]);
  // a lead-in naming the app is not a job of its own: cutting here once lost the folder and sorted the wrong one
  expect(splitAtAppBoundaries("In Finder, organise the files in ~/Desktop/stuff", names)).toHaveLength(1);
});

test("a trailing 'in <app>' names the app, not the content (Weather once searched for 'Tokyo in Weather')", () => {
  expect(withoutAppSuffix("Weather", "check the weather in Tokyo in Weather")).toBe("check the weather in Tokyo");
  expect(withoutAppSuffix("Weather", "check the weather in Tokyo in the Weather app.")).toBe("check the weather in Tokyo.");
  expect(withoutAppSuffix("Weather", "check the weather in Tokyo")).toBe("check the weather in Tokyo");
});

test("a folder named by path is found, and the same folder is recognised however it is written", () => {
  expect(folderIn("In Finder, organise the files in ~/Desktop/stuff, by kind")).toBe("~/Desktop/stuff");
  expect(folderIn("sort my downloads")).toBeUndefined();
  expect(sameFolder("~/Desktop", `${homedir()}/Desktop/`)).toBe(true);
  expect(sameFolder("~/Desktop", "~/Documents")).toBe(false);
});

test("App Store's bare 'Get' is an install and is refused unless asked; other 'Get…' labels are ordinary", () => {
  expect(clickForbidden("Get", "look up Xcode in the App Store and tell me the developer")).not.toBeNull();
  expect(clickForbidden("Get", "install Xcode from the App Store")).toBeNull();
  expect(clickForbidden("Get Info", "show the file's size")).toBeNull();
  expect(clickForbidden("Get Directions", "directions to the airport")).toBeNull();
});

test("a chained or bracketed sum compiles to Calculator presses, worked left to right; a precedence trap does not", () => {
  expect(calcChain("compute (17 + 25) times 3")).toEqual({ first: "17", rest: [["Add", "25"], ["Multiply", "3"]] });
  expect(calcChain("250 + 175 - 80")).toEqual({ first: "250", rest: [["Add", "175"], ["Subtract", "80"]] });
  expect(calcChain("compute 76x49")).toEqual({ first: "76", rest: [["Multiply", "49"]] });
  expect(calcChain("2 + 3 times 4")).toBeNull(); // 14, not 20
  expect(calcChain("2 times (3 + 4)")).toBeNull(); // a group that isn't first
  expect(calcChain("open Calculator")).toBeNull();
  const keys = "All Clear,0,1,2,3,4,5,6,7,8,9,Add,Subtract,Multiply,Divide,Equals,Point".split(",").map((text, i) => ({ id: i, text, role: "AXButton" }));
  expect(calculatorPlan("compute (17 + 25) times 3", keys as any)!.map((s) => s.target).join(" ")).toBe("All Clear 1 7 Add 2 5 Equals Multiply 3 Equals");
});

test("an LLM answer to a question counts only when it is read off the screen, not from what the model knows", () => {
  const items = [{ id: 0, text: "Get, In-App Purchases", role: "AXButton" }] as any;
  // live: App Store showed only the search box and Get buttons; the tie-break still answered "Apple makes Xcode"
  expect(groundedIn("Apple makes Xcode", "search for Xcode Then: tell me who makes it", ["Xcode", "Mac Apps", "Discover"], items)).toBe(false);
  expect(groundedIn("Apple makes Xcode", "search for Xcode Then: tell me who makes it", ["Xcode", "Apple", "Developer Tools"], items)).toBe(true);
  expect(groundedIn("It was founded in 1911.", "when was HKU founded", ["The University of Hong Kong was founded in 1911"], [])).toBe(true);
  expect(groundedIn("4,736", "compute 128 times 37", ["128×37", "4,736"], [])).toBe(true);
  expect(groundedIn("7,500,700 people", "population of Hong Kong", ["Hong Kong", "Population 7.4 million"], [])).toBe(false);
});

test("'add a reminder called X' compiles to Add Reminder (in code), then typing X", () => {
  const items = [{ id: 0, text: "Add Reminder", role: "AXButton" }, { id: 1, text: "Today, 5 reminders", role: "AXButton" }] as any;
  expect(remindersPlan("in Reminders, add a reminder called Stage test reminder", items)).toEqual([{ action: "click", target: "Add Reminder" }, { action: "type", text: "Stage test reminder" }]);
  expect(remindersPlan("add a reminder to buy milk", items)![1]!.text).toBe("buy milk");
  expect(remindersPlan("show my reminders for today", items)).toBeNull();
  expect(remindersPlan("add a reminder called X", [])).toBeNull(); // no Add Reminder button on screen: don't guess
});

test("'in Brave, search for X Then: tell me Y' searches the web for X", () => {
  expect(webPlan("in Brave, search for the population of Hong Kong Then: tell me the number")![0]!.text).toBe("https://www.google.com/search?q=the%20population%20of%20Hong%20Kong");
  expect(webPlan("what is the population of Hong Kong")![0]!.text).toContain("q=what%20is%20the%20population");
});

const wiki = (goal: string) => webPlan(goal)?.[0]?.text;
const wikiUrl = (topic: string) => `https://en.wikipedia.org/w/index.php?search=${topic}`;

test("Wikipedia goals find the topic whatever leads in and whatever is asked after (live, Oni's 'Go to the Wikipedia page for X and tell me …' searched for the whole sentence)", () => {
  // the goal as Oni sent it through the real supervisor
  expect(wiki("Go to the Wikipedia page for the University of Hong Kong and tell me the year it was founded/established.")).toBe(wikiUrl("the%20University%20of%20Hong%20Kong"));
  expect(wiki("Go to the Wikipedia page for the University of Hong Kong and tell me the year it was founded")).toBe(wikiUrl("the%20University%20of%20Hong%20Kong"));
  expect(wiki("open the Wikipedia article on Alan Turing and tell me when he was born")).toBe(wikiUrl("Alan%20Turing"));
  expect(wiki("look up Hong Kong on Wikipedia and tell me its population")).toBe(wikiUrl("Hong%20Kong"));
  expect(wiki("find the Wikipedia entry about Rust (programming language)")).toBe(wikiUrl("Rust%20(programming%20language)"));
  // the lead-in, and the way the question follows the topic, can vary
  for (const goal of [
    "visit the Wikipedia page of the University of Hong Kong and then tell me the year it was founded",
    "Go to the Wikipedia page for the University of Hong Kong, then tell me the year it was founded",
    "Go to the Wikipedia page for the University of Hong Kong. Tell me the year it was founded.",
    "Go to the Wikipedia page for the University of Hong Kong Then: tell me the year it was founded",
    "Go to the page for the University of Hong Kong on Wikipedia and tell me the year it was founded",
    "look up the University of Hong Kong in Wikipedia and tell me the year it was founded",
    "Search Wikipedia for the University of Hong Kong and tell me the year it was founded",
    "Open Wikipedia and search for the University of Hong Kong, then tell me the year it was founded",
    "Go to Wikipedia and look up the University of Hong Kong and tell me the year it was founded", // worked before: still does
    "look up the University of Hong Kong on Wikipedia and tell me the year it was founded", // and this
  ]) expect([goal, wiki(goal)]).toEqual([goal, wikiUrl("the%20University%20of%20Hong%20Kong")]);
  // a quoted title is the title
  expect(wiki('Go to the Wikipedia page for "Rust (programming language)" and tell me who created it')).toBe(wikiUrl("Rust%20(programming%20language)"));
  // words of the topic's own that look like a lead-in or a question are not: "Find", "Tell Me", "and"
  expect(wiki("Go to the Wikipedia page for Find a Grave and tell me when it was founded")).toBe(wikiUrl("Find%20a%20Grave"));
  expect(wiki("look up Tell Me Why on Wikipedia and tell me who wrote it")).toBe(wikiUrl("Tell%20Me%20Why"));
  expect(wiki("look up Pride and Prejudice on Wikipedia and tell me who wrote it")).toBe(wikiUrl("Pride%20and%20Prejudice"));
  expect(wiki("Go to the Wikipedia page for Don't Tell Me (Madonna song) and tell me the year")).toBe(wikiUrl("Don't%20Tell%20Me%20(Madonna%20song)"));
});

const city = (goal: string) => weatherPlan(goal)?.[0]?.text ?? null;

test("Weather: the city also comes from 'search for X' and the other verbs (live, 'search for Tokyo and tell me …' compiled to nothing and jev wandered)", () => {
  // the two goals as Oni sent them through the real supervisor
  expect(city("search for Tokyo and tell me the current temperature shown")).toBe("Tokyo");
  expect(city("search for Hong Kong and tell me today's forecast, including the high temperature in Celsius")).toBe("Hong Kong"); // it used to find the city "Celsius"
  // each verb
  for (const goal of ["search Tokyo", "search for Tokyo", "Search for Tokyo.", "look up Tokyo", "find Tokyo", "show Tokyo", "show me Tokyo", "switch to Tokyo", "check Tokyo", "check Tokyo's weather", "show me Tokyo's forecast"]) {
    expect([goal, city(goal)]).toEqual([goal, "Tokyo"]);
  }
  // the capitalised words right after the verb, up to "and", "then", a comma, a full stop or the end
  expect(city("search for Hong Kong and tell me the high")).toBe("Hong Kong");
  expect(city("search for New York City")).toBe("New York City");
  expect(city("look up Hong Kong, then tell me the temperature")).toBe("Hong Kong");
  expect(city("find San Francisco.")).toBe("San Francisco");
  expect(city("show me Hong Kong's forecast")).toBe("Hong Kong");
  expect(city("search for St. Louis and tell me the temperature")).toBe("St. Louis"); // the dot of an abbreviation is not a full stop
  expect(city("search for São Paulo and tell me the temperature")).toBe("São Paulo");
  expect(city("search for Stratford-upon-Avon")).toBe("Stratford-upon-Avon");
  expect(city("search for The Hague and tell me the temperature")).toBe("The Hague");
  // compiled for the Weather app, whatever is said about the app itself
  expect(compilePlan("Weather", "search for Tokyo and tell me the current temperature shown", [])).toEqual([{ action: "pick_city", text: "Tokyo" }]);
  expect(compilePlan("Weather", "search for Tokyo in Weather", [])).toEqual([{ action: "pick_city", text: "Tokyo" }]);
});

test("Weather: a generic word, a unit or a time is not a city", () => {
  for (const goal of [
    "search for the weather", "look up the forecast", "check the weather", "show me the temperature", "find out the weather", "what is the weather",
    "check Weather", "search for Celsius", "show me Monday's forecast", "search for today",
    "check the weather for today", "check the weather in the morning", "check the weather for the next three days",
  ]) expect([goal, city(goal)]).toEqual([goal, null]);
});

test("Weather: 'weather in X' keeps priority, and no longer swallows what follows the city or takes a unit for it", () => {
  expect(city("check the weather in Hong Kong")).toBe("Hong Kong");
  expect(city("in Weather check the weather in Hong Kong")).toBe("Hong Kong");
  expect(city("what is the temperature in Tokyo right now")).toBe("Tokyo");
  expect(city("check the weather in tokyo")).toBe("tokyo"); // typed in lower case: as before
  expect(city("check the weather in St. Louis")).toBe("St. Louis");
  expect(city("forecast for Hong Kong this week")).toBe("Hong Kong");
  expect(city("search for Tokyo and check the weather in Paris")).toBe("Paris"); // the older pattern comes first
  // these used to return "Tokyo and tell me the temperature", "Tokyo and tell me the temperature in Celsius", "New York for", "Celsius in Tokyo"
  expect(city("check the weather in Tokyo and tell me the temperature")).toBe("Tokyo");
  expect(city("check the weather in Tokyo and tell me the temperature in Celsius")).toBe("Tokyo");
  expect(city("check the weather in New York for tomorrow")).toBe("New York");
  expect(city("what is the temperature in Celsius in Tokyo")).toBe("Tokyo");
  expect(city("check the weather in São Paulo")).toBe("São Paulo"); // accented names too
});

// Oni now writes the goals itself (STEPS.md 157) and hands the agent the exact text to type, apostrophes and all.

test("an apostrophe inside a word is not a quote: the text Oni hands over is typed as written", () => {
  // an apostrophe counted as a quote returned "ll call Mum" for this goal
  expect(explicitText("create a new note that says: I'll call Mum's phone")).toBe("I'll call Mum's phone");
  expect(writePlan("create a new note that says: I'll call Mum's phone", [])![0]!.text).toBe("I'll call Mum's phone");
  // no marker with a colon: a quote still needs a word boundary on both sides
  expect(explicitText("it's 5 o'clock, write a note saying hello there.")).toBe("hello there");
  expect(explicitText("write 'I'll be late' to the doc")).toBe("I'll be late"); // a quoted span may hold apostrophes
  expect(explicitText("tell Sam 'it's ready' and 'thanks'")).toBe("it's ready");
  expect(explicitText("write rock 'n' roll songs")).toBeNull(); // 'n' is no quote either, so nothing is given
});

test("text after 'that says:' (or saying: / which says: / with the text: / the words: / exactly:) is everything after the colon, exactly", () => {
  for (const marker of ["that says", "which says", "saying", "with the text", "the words", "exactly", "That Says"]) {
    expect(explicitText(`type ${marker}: don't stop`)).toBe("don't stop");
  }
  // all of it: later full stops, "in Notes", colons and line breaks are part of the text
  expect(explicitText("create a note that says: buy milk, eggs. in Notes")).toBe("buy milk, eggs. in Notes");
  expect(explicitText("create a note that says:\nline one\nline two: still the text\n'quoted' line")).toBe("line one\nline two: still the text\n'quoted' line");
  expect(explicitText('create a note called "Shopping" that says: milk, eggs')).toBe("milk, eggs"); // the quoted title is not the text
  expect(explicitText("create a note that says:")).toBeNull(); // nothing after the colon: nothing to type
  // one pair of quotes around the WHOLE text only marks where it starts and ends
  expect(explicitText(`that says: "I'll call Mum's phone"`)).toBe("I'll call Mum's phone");
  expect(explicitText("that says: 'I'll call Mum's phone'")).toBe("I'll call Mum's phone");
  expect(explicitText('that says: "Hello" she said')).toBe('"Hello" she said'); // not wholly quoted: kept as written
  expect(explicitText('the words: "a" and "b"')).toBe('"a" and "b"'); // two spans, not one quoted text
});

test("quoted text: a double-quoted span, or a single-quoted one only at word boundaries; the older forms still work", () => {
  expect(explicitText('type "hello world" in TextEdit')).toBe("hello world");
  expect(explicitText("type “hello world” in TextEdit")).toBe("hello world");
  expect(explicitText('type "a" now')).toBe("a");
  expect(explicitText("write 'The demo starts at 3pm'")).toBe("The demo starts at 3pm");
  expect(explicitText("write (‘Demo at 3pm’) please")).toBe("Demo at 3pm"); // an opening bracket and a closing one are boundaries too
  expect(explicitText("type 'a' and then 'bc'")).toBe("bc"); // a one-letter span is no span (as before), and two never join into one
  expect(explicitText("write a note with the text hello there in Notes")).toBe("hello there"); // the older marker, no colon
  expect(explicitText("write a packing list for a hike")).toBeNull();
  expect(explicitText("create a note titled 'Groceries' with milk, eggs and bread")).toBe("Groceries\n• milk\n• eggs\n• bread"); // a titled list still comes first
});

test("in a merged goal, text after a marker WITH a colon ends at its own clause: ' Then: ' is what mergeSameApp writes", () => {
  expect(explicitText("create a note that says: hi Then: delete the draft")).toBe("hi"); // it used to type "hi Then: delete the draft"
  expect(explicitText('create a note that says: "hi" Then: delete the draft')).toBe("hi");
  expect(explicitText("create a note that says:\nline one\nline two Then: delete the draft")).toBe("line one\nline two"); // several lines, then the join
  expect(explicitText("open the note Then: create a note that says: hi")).toBe("hi"); // the marker is in a later clause
  expect(explicitText("create a note that says: milk Then: create a note that says: eggs")).toBe("milk"); // the first clause's text
  expect(explicitText("create a note that says: Then: delete the draft")).toBeNull(); // nothing before the join: no text
  // from the goal mergeSameApp really builds, the plan types exactly the first clause's text
  const goal = mergeSameApp([{ app: "Notes", goal: "create a note that says: I'll call Mum's phone" }, { app: "notes", goal: "delete the draft" }])[0]!.goal;
  expect(goal).toBe("create a note that says: I'll call Mum's phone Then: delete the draft");
  expect(writePlan(goal, [])![0]!.text).toBe("I'll call Mum's phone");
});

test("in a merged goal, text after the older marker WITHOUT a colon ends there too, and keeps its own ends", () => {
  expect(explicitText("write a note saying hi Then: delete the draft")).toBe("hi");
  expect(explicitText("write a note that says hi Then: delete the draft")).toBe("hi");
  expect(explicitText("write a note saying hi. Then: delete the draft")).toBe("hi"); // the full stop still goes
  expect(explicitText("write a note saying hi in TextEdit Then: delete it")).toBe("hi"); // and "in TextEdit"
  expect(explicitText("open the note Then: write a note saying hi")).toBe("hi"); // the marker is in a later clause
  expect(explicitText("write a note saying hi\nthere")).toBeNull(); // as before, this form is one line
  expect(explicitText("write a note saying hi\nthe words bye")).toBe("bye"); // the first marker gave nothing: the next one is tried
});

test("only the exact ' Then: ' join ends a text: Oni's own lowercase 'then:' or a line starting with 'Then:' stays in it", () => {
  expect(explicitText("create a note that says: buy milk then: bake")).toBe("buy milk then: bake");
  expect(explicitText("create a note that says: Mix\nThen: bake")).toBe("Mix\nThen: bake");
  expect(explicitText("write a note saying then: later")).toBe("then: later");
});

test("explicitText and unquoted() end the text in the same place: what is typed is exactly what the checks stop reading as orders", () => {
  for (const marker of ["that says", "which says", "saying", "with the text", "the words", "exactly"]) {
    const goal = `create a note ${marker}: buy milk, eggs${CLAUSE_JOIN}delete the draft`;
    expect([marker, explicitText(goal)]).toEqual([marker, "buy milk, eggs"]);
    expect([marker, unquoted(goal)]).toEqual([marker, `create a note ${marker}: , ${CLAUSE_JOIN}delete the draft`]);
  }
  // and with a trailing instruction before the join: it is neither typed nor hidden from the checks
  const asked = `create a note that says: Done. and tell me it worked${CLAUSE_JOIN}delete the draft`;
  expect(explicitText(asked)).toBe("Done.");
  expect(unquoted(asked)).toBe(`create a note that says: ,  and tell me it worked${CLAUSE_JOIN}delete the draft`);
});

test("a trailing instruction is not typed: the text ends at the last sentence break before a lowercase 'and tell me' (live, the agent typed '… and tell me that the document was created.')", () => {
  const live = "Create a new document that says: The University of Hong Kong was founded in 1911. That is 115 years before 2026. and tell me that the document was created.";
  expect(explicitText(live)).toBe("The University of Hong Kong was founded in 1911. That is 115 years before 2026."); // the punctuation stays
  expect(writePlan(live, [])![0]!.text).toBe("The University of Hong Kong was founded in 1911. That is 115 years before 2026.");
  // the forms that carry on from the sentence before, which is how an instruction gets appended
  for (const ask of ["and tell me it worked", "and then tell me it worked", "then tell me it worked"]) {
    expect([ask, explicitText(`create a note that says: Done. ${ask}`)]).toEqual([ask, "Done."]);
  }
  for (const end of ["!", "?"]) expect(explicitText(`create a note that says: Done${end} and tell me it worked`)).toBe(`Done${end}`);
  expect(explicitText('create a note that says: "The year is 1911." and tell me it worked.')).toBe("The year is 1911."); // a closing quote follows the break
  expect(explicitText("create a note that says: 'The year is 1911.' and tell me it worked.")).toBe("The year is 1911.");
  expect(explicitText("create a note that says:\nLine one.\nLine two. and tell me it worked")).toBe("Line one.\nLine two."); // several lines
  expect(explicitText("create a note that says: A. tell me x. and tell me y.")).toBe("A. tell me x."); // only the LAST break starts the instruction
});

test("a message's own 'Tell me …' stays: only a lowercase 'and tell me' / 'and then tell me' / 'then tell me' after a sentence break is cut", () => {
  for (const text of [
    // a message Oni writes for someone: its second sentence is part of it
    "Running late. Tell me where you are.",
    "I'm sorry. Tell me when you're free.",
    // case matters, and so does the "and" / "then" that carries on from the sentence before
    "Done. And tell me it worked",
    "Done. Then tell me it worked",
    "Done. tell me it worked",
    "Done. AND TELL ME it worked",
    // no sentence break right before it
    "please tell me when you're home",
    "hello, and tell me it worked", // a comma is not a sentence break
    "Hello. Please tell me when you're home.", // "tell me" is not what follows the break
    "Tell me when you're home", // nothing before it
    "Done.and tell me", // no space after the break
    "Done. and telling me things", // another word
    // and text with no trailing instruction at all
    "The University of Hong Kong was founded in 1911. That is 115 years before 2026.",
    "I'll call Mum's phone",
  ]) expect([text, explicitText(`create a note that says: ${text}`)]).toEqual([text, text]);
});

// Oni's Instagram DM task (a real user task through the real supervisor): three bugs found in the run logs.

const pageObs = (els: AxElement[], markdown?: string): Observation => ({ agent: "t", window: { pid: 1, windowId: 1, app: "Brave Browser", title: "Instagram" }, elements: els, truncated: false, ms: 1, markdown });

test("a text box that shows its prompt as its value holds nothing (live: Instagram's message box, an AXTextArea 'Message...' holding 'Message...', was read as someone else's text)", () => {
  const field = (p: ReturnType<typeof perceive>, label: string) => p.items.find((i) => i.text === label)!;
  // in a web page, whatever the role and the words: the accessible name is never the box's content
  const page = perceive(pageObs([
    el(0, "AXWindow", { label: "Instagram" }),
    el(1, "AXWebArea", { parent: 0, label: "Instagram" }),
    el(2, "AXTextArea", { parent: 1, token: "msg", label: "Message...", value: "Message...", actions: ["AXPress"] }),
    el(3, "AXTextField", { parent: 1, token: "srch", label: "Search", value: "Search", actions: ["AXPress"] }),
    el(4, "AXTextArea", { parent: 1, token: "ask", label: "Ask anything", value: "Ask anything", actions: ["AXPress"] }),
  ]));
  for (const label of ["Message...", "Search", "Ask anything"]) expect([label, field(page, label).state, field(page, label).value, field(page, label).placeholder]).toEqual([label, "empty", "", true]);
  expect(page.screen.join("\n")).not.toContain("Message..."); // and it is not text on the screen either
  expect(page.screen.join("\n")).not.toContain("Ask anything");
  // outside a page the shape has to look like a prompt: it ends in "..." / "…" (any role), or is a single-line field's placeholder word
  const native = perceive(pageObs([
    el(0, "AXWindow", { label: "App" }),
    el(1, "AXTextArea", { parent: 0, token: "a", label: "Message...", value: "Message...", actions: [] }),
    el(2, "AXTextArea", { parent: 0, token: "b", label: "Add a comment…", value: " add a comment... ", actions: [] }),
    el(3, "AXSearchField", { parent: 0, token: "c", label: "Search", value: "Search", actions: [] }),
  ]));
  expect(native.items.map((i) => [i.text, i.state])).toEqual([["Message...", "empty"], ["Add a comment…", "empty"], ["Search", "empty"]]);
  // the text of a native note can be mirrored into its label (Notes): that is real content and stays protected
  const note = perceive(pageObs([el(0, "AXWindow", { label: "Notes" }), el(1, "AXTextArea", { parent: 0, token: "n", label: "My private note", value: "My private note", actions: [] })]));
  expect([note.items[0]!.state, note.items[0]!.value, note.items[0]!.placeholder]).toEqual(["filled", "My private note", undefined]);
});

test("a text box with real content is not a prompt: a value that differs from its label, or long text equal to it", () => {
  const web = (label: string, value: string) => perceive(pageObs([
    el(0, "AXWindow", { label: "Instagram" }),
    el(1, "AXWebArea", { parent: 0, label: "Instagram" }),
    el(2, "AXTextArea", { parent: 1, token: "msg", label, value, actions: [] }),
  ])).items[0]!;
  expect([web("Message...", "see you at five").state, web("Message...", "see you at five").value]).toEqual(["filled", "see you at five"]);
  expect(web("x".repeat(60), "x".repeat(60)).state).toBe("empty"); // up to 60 characters it can be a prompt
  expect(web("x".repeat(61), "x".repeat(61)).state).toBe("filled"); // longer is real text
  expect(web("Message...", "").state).toBe("empty");
  // the comparison ignores case, spacing and one trailing "..." / "…"
  expect(isPlaceholder("AXTextArea", "Message...", "message", true)).toBe(true);
  expect(isPlaceholder("AXTextArea", "Message…", "  Message...  ", false)).toBe(true);
  expect(isPlaceholder("AXTextArea", "Message...", "Message to Sam", true)).toBe(false);
  expect(isPlaceholder("AXTextArea", "Ask anything", "Ask anything", false)).toBe(false); // outside a page, no "..." and a text area: not on its words alone
  expect(isPlaceholder("AXTextField", "Search", "Search", false)).toBe(true); // the placeholder words of a single-line field, as before
});

test("the screen text from Cua's markdown leaves a page box's prompt out, and keeps what is really typed", () => {
  const md = [
    '- [0] AXWindow "Instagram"',
    '  - [1] AXWebArea "Instagram"',
    '    - [2] AXTextArea (Message...) = "Message..."',
    '    - [3] AXTextArea (Ask anything) = "Ask anything"',
    '    - [4] AXTextArea (Comment) = "great photo"',
    '    - AXStaticText = "Rishabh Jain"',
    '  - [5] AXTextField (My note) = "My note"',
  ].join("\n");
  const screen = perceive(pageObs([el(0, "AXWindow", { label: "Instagram" })], md)).screen;
  expect(screen).toEqual(["window title: Instagram", "great photo", "Rishabh Jain", "My note"]); // "My note" is outside the page: real content
});

test("targets are people or conversations, never an app's sections, an app or an address (live: 'Direct Messages' was taken for the person to message)", () => {
  const targets = (g: string) => goalValues(g).targets;
  // Oni's goals as they went to Backstage
  expect(targets("Open instagram.com, go to Direct Messages, open the conversation with Rishabh, and send a message that says: hi")).toEqual(["Rishabh"]);
  expect(targets("Go to https://www.instagram.com/direct/inbox/, click on the conversation with Rishabh Jain to open it, click into the message text box at the bottom, type, and send a message that says: hi")).toEqual(["Rishabh Jain"]);
  expect(targets("Go to Instagram Direct Messages, then message Rishabh Jain")).toEqual(["Rishabh Jain"]);
  // places in an app and apps, singular or plural, any case
  for (const place of ["Direct Messages", "Direct Message", "Messages", "DMs", "DM", "Inbox", "Chats", "Chat", "Requests", "Notifications", "Home", "Search", "Settings", "Explore", "Feed", "Channels", "Contacts", "People", "Friends", "Groups"]) {
    expect([place, targets(`go to ${place}`)]).toEqual([place, []]);
    expect([`"${place.toLowerCase()}"`, targets(`go to "${place.toLowerCase()}"`)]).toEqual([`"${place.toLowerCase()}"`, []]);
  }
  for (const app of ["Instagram", "WhatsApp", "Messenger", "Discord", "Slack", "Telegram", "Signal", "Facebook", "Twitter", "X", "LinkedIn", "Gmail", "Mail", "Messages"]) {
    expect([app, targets(`go to ${app}`)]).toEqual([app, []]);
    expect([app, targets(`go to ${app} and message Sam`)]).toEqual([app, ["Sam"]]);
  }
  // anything URL-like
  for (const url of ["https://www.instagram.com/direct/inbox/", "instagram.com", "www.instagram.com", "instagram.com/direct/inbox"]) expect([url, targets(`go to "${url}" then message Priya`)]).toEqual([url, ["Priya"]]);
  // people, and the shapes that always worked
  expect(targets('Open WhatsApp, message Sohan "hi"')).toEqual(["Sohan"]);
  expect(targets("reply to Sam's text")).toEqual(["Sam"]);
  expect(targets("open the chat with Mum")).toEqual(["Mum"]);
  expect(targets("message +852 9123 4567")).toEqual(["+852 9123 4567"]);
  // clicking a conversation reaches its person; clicking a button named like one does not
  expect(targets("click on the chat called Team Alpha")).toEqual(["Team Alpha"]);
  expect(targets("go to Settings and click Sign In")).toEqual([]);
  expect(targets("click Calculate")).toEqual([]);
});

test("sending something to a person makes the person a target, in either order ('send a message to X', 'send X a message'), so the right-conversation check runs", () => {
  const targets = (g: string) => goalValues(g).targets;
  // the three Oni writes most
  expect(targets("send a message to Rishabh that says: hi")).toEqual(["Rishabh"]);
  expect(targets("send Rishabh Jain a message that says: hi")).toEqual(["Rishabh Jain"]);
  expect(targets("send it to Mum")).toEqual(["Mum"]);
  // the thing, then "to": each kind of message, with the small words people put around it
  for (const g of [
    "send a text to Mum", "send a DM to Mum", "send a note to Mum", "send a reply to Mum", "send the message to Mum", "send a quick message to Mum",
    "send a short text message to Mum", "send a direct message to Mum", "write a message to Mum", "write a text to Mum", "drop a message to Mum",
    "drop a line to Mum", "drop a note to Mum", "send this to Mum", "send that to Mum", "send them to Mum", "send a message to the chat with Mum",
  ]) expect([g, targets(g)]).toEqual([g, ["Mum"]]);
  // the person, then the thing
  for (const g of [
    "send Mum a message", "send Mum a text", "send Mum a DM", "send Mum a note", "send Mum a reply", "send Mum the message that says: hi", "send Mum a quick text",
    "write Mum a message", "write Mum a text", "drop Mum a message", "drop Mum a line", "send Mum a message on Instagram that says: hi",
  ]) expect([g, targets(g)]).toEqual([g, ["Mum"]]);
  // a goal that opens with the verb has its capital on the verb, which used to be taken in with the name
  expect(targets("Send Rishabh Jain a message that says: hi")).toEqual(["Rishabh Jain"]);
  expect(targets("Write Mum a message")).toEqual(["Mum"]);
  expect(targets("Go to Direct Messages. Send Rishabh Jain a message that says: hi")).toEqual(["Rishabh Jain"]);
  expect(targets("Open instagram.com Then: Send Rishabh Jain a message that says: hi")).toEqual(["Rishabh Jain"]);
  // quoted, a number, a group
  expect(targets('send a message to "Rishabh Jain" that says: hi')).toEqual(["Rishabh Jain"]);
  expect(targets('send "Rishabh Jain" a message')).toEqual(["Rishabh Jain"]);
  expect(targets("send a message to +852 9123 4567 that says: hi")).toEqual(["+852 9123 4567"]);
  expect(targets("send a message to the group called Team Alpha")).toEqual(["Team Alpha"]);
  // the same filtering as every other target: an app, a place in an app or an address is not who to send to
  for (const place of ["Instagram", "WhatsApp", "Direct Messages", "Inbox", "instagram.com", "https://www.instagram.com/direct/inbox/"]) {
    expect([place, targets(`send a message to ${place}`)]).toEqual([place, []]);
    expect([place, targets(`send ${place} a message`)]).toEqual([place, []]);
  }
  expect(targets("send feedback to Instagram")).toEqual([]);
  expect(targets("send it to Instagram")).toEqual([]);
  // nothing that is sent to a person: no target
  expect(targets("send the file")).toEqual([]);
  expect(targets("send a message")).toEqual([]);
  expect(targets("Send Feedback")).toEqual([]);
  // "write a note to Mum" is a note in the Notes app, not a message to anyone
  expect(targets("write a note to Mum")).toEqual([]);
  expect(targets("In Notes, write a note to Mum that says: hi")).toEqual([]);
  // a name inside a longer word is not the person ("Sam" in "Samuel")
  expect(targets("send a message to Samuel that says: hi Sam")).toEqual(["Samuel"]);
});

test("a name in the text a goal hands over to type is never a target (it is in the message, not who it goes to)", () => {
  const targets = (g: string) => goalValues(g).targets;
  expect(targets("send a message to Rishabh that says: call Mum")).toEqual(["Rishabh"]); // "call Mum" used to make Mum a target too
  expect(targets("send a message to Rishabh that says: send it to Mum")).toEqual(["Rishabh"]);
  expect(targets("send a message to Rishabh that says: send Mum a message")).toEqual(["Rishabh"]);
  expect(targets('send a message to Rishabh that says: "open the chat with Priya"')).toEqual(["Rishabh"]);
  expect(targets("send a message to Rishabh Jain saying: text Mum when you land")).toEqual(["Rishabh Jain"]);
  // nobody to send it to but the name inside the text: no target at all
  expect(targets("send a message that says: call Mum")).toEqual([]);
  expect(targets("send a message that says: send Mum a message")).toEqual([]);
  // the text ends at the clause join, so a later mention of the same name is the goal again and still counts
  expect(targets("send a message that says: call Mum Then: open the chat with Mum")).toEqual(["Mum"]);
  // a person right before the clause join is the person ("Then" is not part of the name)
  expect(targets("open the chat with Rishabh Jain Then: send a message that says: hi")).toEqual(["Rishabh Jain"]);
  expect(targets("message Sohan Then: tell me what she said")).toEqual(["Sohan"]);
  expect(targets("send a message to Rishabh Then: read the reply")).toEqual(["Rishabh"]);
  expect(goalValues("send Rishabh Jain a message that says: hi Then: read the reply").names).toEqual(["Rishabh Jain"]);
});

test("a sentence that starts with a capitalised verb of reaching still gives the person ('Message Sohan …', 'Call Mum', 'Chat with Ana …'), so the right-conversation check runs", () => {
  const targets = (g: string) => goalValues(g).targets;
  // the capital belongs to the sentence, not to the name: the verb used to be taken in with it ("Message Sohan" was one name)
  expect(targets("Message Sohan hi")).toEqual(["Sohan"]);
  expect(targets('Message Sohan "hi"')).toEqual(["Sohan"]);
  expect(targets("Text Mum that I'm running late")).toEqual(["Mum"]);
  expect(targets("DM Rishabh that the meeting moved")).toEqual(["Rishabh"]);
  expect(targets("Call Mum")).toEqual(["Mum"]);
  expect(targets("Ring Mum")).toEqual(["Mum"]);
  expect(targets("Answer Sam's message")).toEqual(["Sam"]);
  expect(targets("Message Rishabh Jain on Instagram that says: hi")).toEqual(["Rishabh Jain"]);
  expect(targets("Text +852 9123 4567 hi")).toEqual(["+852 9123 4567"]);
  // the forms with a small word between the verb and the name were never glued, and stay as they were
  expect(targets("Reply to Sam saying thanks")).toEqual(["Sam"]);
  expect(targets("Chat with Ana about the trip")).toEqual(["Ana"]);
  expect(targets("Open the chat with Rishabh Jain and say hi")).toEqual(["Rishabh Jain"]);
  // any sentence of the goal, not just the first: after a full stop, after the clause join
  expect(targets("Go to Instagram. Message Rishabh Jain that says: hi")).toEqual(["Rishabh Jain"]);
  expect(targets("Open WhatsApp Then: Text Mum hi")).toEqual(["Mum"]);
  // the same filtering: a place or an app after the verb is not a person, and an app opened by its name is not either
  expect(targets("Message Requests")).toEqual([]);
  expect(targets("Text Messages")).toEqual([]);
  expect(targets("Message Instagram")).toEqual([]);
  expect(targets("Open Text Edit and type hi")).toEqual([]);
  // a verb with nothing after it is not a name
  expect(targets("Message")).toEqual([]);
});

test("a conversation picked by the person's name, with the noun after it ('click directly on the 'Rishabh Jain' conversation'), gives the person", () => {
  const targets = (g: string) => goalValues(g).targets;
  // the real goal Oni sent (run log 18:07): the person and nothing else, not the 'Message...' box
  expect(targets("On the open Instagram Direct Messages page, click directly on the 'Rishabh Jain' conversation in the left sidebar to open it, then click into the 'Message...' text box at the bottom of that conversation (clearing it first if it has any leftover text), and send a message that says: hi")).toEqual(["Rishabh Jain"]);
  // each verb that picks a conversation, with and without quotes, each noun
  for (const g of [
    "click directly on the 'Rishabh Jain' conversation", "click on the 'Rishabh Jain' chat", 'click directly on the "Rishabh Jain" thread', "click on the Rishabh Jain conversation",
    "Click the Rishabh Jain chat", "click just on the 'Rishabh Jain' thread", "tap the 'Rishabh Jain' chat", "choose the Rishabh Jain conversation", "pick the 'Rishabh Jain' thread",
    "click on 'Rishabh Jain' conversation", "open the 'Rishabh Jain' conversation", "open the Rishabh Jain chat", "select the 'Rishabh Jain' chat", "select the Rishabh Jain conversation",
  ]) expect([g, targets(g)]).toEqual([g, ["Rishabh Jain"]]);
  expect(targets("click on the 'Team Alpha' thread, then send a message that says: hi")).toEqual(["Team Alpha"]);
  // without the noun it is a control, as before: "click 'Rishabh Jain'" is a button
  expect(targets("click 'Rishabh Jain'")).toEqual([]);
  expect(targets("click the 'Send' button")).toEqual([]);
  expect(targets("click into the 'Message...' text box at the bottom of that conversation")).toEqual([]);
  // the same filtering: a section or an app is not a person
  expect(targets("click on the 'Instagram' chat")).toEqual([]);
  expect(targets("click on the Direct Messages conversation")).toEqual([]);
  expect(targets("click the 'Requests' thread")).toEqual([]);
  // the noun has to be that word on its own ("chatbot", "threads")
  expect(targets("click on the 'Rishabh Jain' chatbot")).toEqual([]);
});

// Live, 6 Oct (Oni's Instagram DM goals, each typed into Google whole): an address in the goal is where the task starts, a goal
// about using a page is never a search query, and Instagram DM goals belong on the inbox.
const INBOX = "https://www.instagram.com/direct/inbox/";
test("web plan: an Instagram DM goal opens the inbox, not the home feed or a Google search", () => {
  expect(webPlan("Go to instagram.com, open the direct messages inbox, find the chat with Rishabh, and send a message that says: hi")![0]!.text).toBe(INBOX);
  expect(webPlan("Go to instagram.com")![0]!.text).toBe("https://instagram.com");
});
test("web plan: 'go to the URL <address>' and 'type <address> and press Enter' open that address", () => {
  const goal1 = "In the Brave window already on instagram.com, go to the URL https://www.instagram.com/direct/inbox/ to open the direct messages inbox, click on the search field for chats, type Rishabh, click the chat that appears for Rishabh, and send a message that says: hi";
  expect(webPlan(goal1)![0]!.text).toBe(INBOX);
  const goal2 = "Click the browser address bar, clear it, type https://www.instagram.com/direct/inbox/ and press Enter to navigate there, and tell me what the page shows";
  expect(webPlan(goal2)![0]!.text).toBe(INBOX);
  expect(webPlan("open https://example.com/pricing and tell me the price")![0]!.text).toBe("https://example.com/pricing");
});
test("web plan: a goal about using the page is not sent to Google as one long query", () => {
  expect(webPlan("open the chat with Rishabh Jain and send a message that says: hi")).toBeNull();
  expect(webPlan("click on the search field for chats and type Rishabh")).toBeNull();
  // real searches are unchanged
  expect(webPlan("search for the population of Hong Kong")![0]!.text).toContain("google.com/search?q=the%20population");
  expect(webPlan("search for flights and click the cheapest")![0]!.text).toContain("google.com/search?q=");
});
