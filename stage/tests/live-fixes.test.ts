// Regressions for what live runs on real apps found (STEPS.md 156): each case is a shape that once made an agent fail
// or act wrongly on this Mac, pinned down offline.
import { expect, test } from "bun:test";
import { homedir } from "node:os";
import type { AxElement } from "../src/contracts.ts";
import { calcChain, calculatorPlan, remindersPlan, webPlan, withoutAppSuffix } from "../src/compile.ts";
import { folderIn, sameFolder } from "../src/fsops.ts";
import { overlapShare } from "../src/loop.ts";
import { splitAtAppBoundaries } from "../src/manager.ts";
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
