// Regressions for what live runs on real apps found (STEPS.md 156): each case is a shape that once made an agent fail
// or act wrongly on this Mac, pinned down offline.
import { expect, test } from "bun:test";
import { homedir } from "node:os";
import type { AxElement } from "../src/contracts.ts";
import { CLAUSE_JOIN, calcChain, calculatorPlan, explicitText, remindersPlan, unquoted, webPlan, withoutAppSuffix, writePlan } from "../src/compile.ts";
import { folderIn, sameFolder } from "../src/fsops.ts";
import { overlapShare } from "../src/loop.ts";
import { mergeSameApp, splitAtAppBoundaries } from "../src/manager.ts";
import { groundedIn } from "../src/jevhelper.ts";
import { namesOfRows, pressableText } from "../src/perceive.ts";
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
