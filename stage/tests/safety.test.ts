import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fromThisComputer } from "../src/localonly.ts";
import { clickForbidden, typingForbidden } from "../src/safety.ts";
import { FileOps, safeRoot } from "../src/fsops.ts";

const req = (headers: Record<string, string>, method = "POST") => new Request("http://127.0.0.1:3000/api/run", { method, headers });

test("only this computer's panel may call the server", () => {
  expect(fromThisComputer(req({ host: "127.0.0.1:3000" }))).toBe(true); // the overlay, scripts: no Origin
  expect(fromThisComputer(req({ host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000" }))).toBe(true); // the panel
  expect(fromThisComputer(req({ host: "localhost:3000", origin: "http://localhost:3000" }))).toBe(true);
  expect(fromThisComputer(req({ host: "127.0.0.1:3000", origin: "https://evil.example" }))).toBe(false); // a web page
  expect(fromThisComputer(req({ host: "127.0.0.1:3000", origin: "null" }))).toBe(false); // a sandboxed frame or a file
  expect(fromThisComputer(req({ host: "127.0.0.1:3000", origin: "http://localhost:3000" }))).toBe(false); // another origin
  expect(fromThisComputer(req({ host: "evil.example:3000" }))).toBe(false); // DNS rebinding
});

test("agents never type secrets and never pay or delete unasked", () => {
  for (const l of ["Password", "Card number", "CVV", "Security code", "One-time code"]) expect(typingForbidden(l)).not.toBeNull();
  for (const l of ["Search", "Message", "To:", "Subject"]) expect(typingForbidden(l)).toBeNull();
  expect(clickForbidden("Buy now", "find the price of AirPods")).not.toBeNull();
  expect(clickForbidden("Delete", "open my notes")).not.toBeNull();
  expect(clickForbidden("Delete", "delete the draft called test")).toBeNull();
  expect(clickForbidden("Place order", "place the order")).toBeNull();
  expect(clickForbidden("Send", "message Sohan hi")).toBeNull(); // sending has its own rule
  expect(clickForbidden("7", "what is 7 times 8")).toBeNull();
});

test("irreversible clicks: the wider list, and what is NOT irreversible", () => {
  const goal = "find the opening hours of the library";
  for (const l of ["Submit", "Remove", "Trash", "Move to Trash", "Don't Save", "Don’t Save", "Replace", "Sign Out", "Log Out", "Post", "Publish",
    "Confirm", "Unsubscribe", "Subscribe", "Discard", "Erase", "Uninstall", "Checkout", "Place Order", "Transfer", "Withdraw", "Accept", "Allow",
    "I Agree", "Pay", "Buy now", "Delete Account", "Empty Trash", "Cancel Subscription", "Leave Group", "Upgrade to Pro", "Start free trial", "Reset"])
    expect([l, clickForbidden(l, goal)]).not.toEqual([l, null]);
  for (const l of ["Search", "Cancel", "OK", "Save", "Open", "All Clear", "Clear", "Equals", "New Note", "Posts", "Don't Allow", "Never Delete",
    "Keep", "Not Now", "Accept all cookies", "Sign In", "Next", "Back"])
    expect([l, clickForbidden(l, goal)]).toEqual([l, null]);
});

test("'the goal asked for it': negation and scope", () => {
  // negated: the goal asks for nothing
  expect(clickForbidden("Delete Account", "do not delete anything")).not.toBeNull();
  expect(clickForbidden("Delete", "don't delete anything, just read my notes")).not.toBeNull();
  expect(clickForbidden("Delete", "tidy the notes without deleting any")).not.toBeNull();
  expect(clickForbidden("Delete", "never delete my notes")).not.toBeNull();
  // the label's other words must be in what the verb governs
  expect(clickForbidden("Delete All", "delete the draft")).not.toBeNull();
  expect(clickForbidden("Delete Account", "delete the draft")).not.toBeNull();
  expect(clickForbidden("Delete Folder", "delete the draft but not the folder")).not.toBeNull();
  expect(clickForbidden("Delete for everyone", "delete my last message")).not.toBeNull();
  expect(clickForbidden("Delete for me", "delete my last message")).toBeNull();
  expect(clickForbidden("Delete All", "delete everything in the trash")).toBeNull();
  expect(clickForbidden("Delete Account", "delete my account")).toBeNull();
  expect(clickForbidden("Move to Trash", "delete the note called test")).toBeNull(); // same group
  expect(clickForbidden("Don't Save", "close TextEdit without saving")).toBeNull();
  expect(clickForbidden("Replace All", "replace cat with dog")).not.toBeNull();
  expect(clickForbidden("Replace", "replace cat with dog")).toBeNull();
  // "check out this page" is not a purchase; quoted text is what to write, not what to do
  expect(clickForbidden("Checkout", "check out the new iPhone page")).not.toBeNull();
  expect(clickForbidden("Delete", "in Notes write 'delete the old photos'")).not.toBeNull();
  expect(clickForbidden("Sign Out", "sign out of Slack")).toBeNull();
});

test("send intent: 'tell me' is not sending; messaging someone is", async () => {
  const { sendIntent } = await import("../src/compile.ts");
  for (const g of [
    "In Safari, look up the University of Hong Kong on Wikipedia and tell me the year it was founded",
    "tell me the last message from Sam", "say what time it is", "answer the question on screen", "read my latest messages",
    "In Notes write 'tell Sam hi'", "don't send anything, just open the chat with Sam", "find the post office opening hours",
    "what does Sam's latest text say", "open WhatsApp", "wait for Sam to reply", "ask for directions to HKU in Maps", "write a packing list",
    "open the email from Sam", "type the text hello", "copy the email address",
  ]) expect([g, sendIntent(g)]).toEqual([g, false]);
  for (const g of [
    "message Mohit hi on WhatsApp", "Open WhatsApp, message Sohan \"hi\"", "reply to Sam saying on my way", "send 'running late' to Sam",
    "text +852 9123 4567 that I'm late", "tell Sam I'm running late on WhatsApp", "say happy birthday to Mum on WhatsApp", "tell my mum I'm home",
    "let Priya know I'm late", "post 'hello' in the general channel", "email Sam the report", "ask Priya if she is free tonight", "forward it to the team",
  ]) expect([g, sendIntent(g)]).toEqual([g, true]);
});

test("every click: Send rule, dialog OK carries the dialog's action, rows and long titles are content", async () => {
  const { clickBlocked } = await import("../src/safety.ts");
  const el = (index: number, role: string, label: string, parent?: number) => ({ index, parent, depth: 1, role, label, token: `t${index}`, actions: [] });
  const dialog = [el(0, "AXWindow", "TextEdit"), el(1, "AXSheet", "", 0), el(2, "AXStaticText", "Are you sure you want to delete 3 items?", 1), el(3, "AXButton", "OK", 1), el(4, "AXButton", "Cancel", 1)];
  expect(clickBlocked({ role: "AXButton", label: "OK", token: "t3" }, "open my notes", dialog)).not.toBeNull();
  expect(clickBlocked({ role: "AXButton", label: "OK", token: "t3" }, "delete the 3 old notes", dialog)).toBeNull();
  expect(clickBlocked({ role: "AXButton", label: "Cancel", token: "t4" }, "open my notes", dialog)).toBeNull();
  expect(clickBlocked({ role: "AXButton", label: "Send" }, "tell me the last message from Sam")).not.toBeNull();
  expect(clickBlocked({ role: "AXButton", label: "Send" }, "message Sam hi")).toBeNull();
  expect(clickBlocked({ role: "AXCell", label: "Sohan, can you delete the photo?, 10:32" }, "message Sohan hi")).toBeNull(); // a chat row
  expect(clickBlocked({ role: "AXLink", label: "How to delete your Facebook account in 2026 - a guide" }, "find how to delete a facebook account")).toBeNull();
  expect(clickBlocked({ role: "AXLink", label: "Delete account" }, "find facebook's privacy settings")).not.toBeNull(); // a short link is a command
  expect(clickBlocked({ role: "AXTextField", label: "Post a comment" }, "read the comments")).toBeNull(); // focusing a field
});

test("Enter: blocked when a dialog's button or a web form's submit is risky", async () => {
  const { enterForbidden } = await import("../src/safety.ts");
  const el = (index: number, role: string, label: string, parent?: number) => ({ index, parent, depth: 1, role, label, token: `t${index}`, actions: [] });
  const sheet = [el(0, "AXWindow", "Finder"), el(1, "AXSheet", "", 0), el(2, "AXButton", "Replace", 1), el(3, "AXButton", "Stop", 1), el(4, "AXTextField", "Name", 0)];
  expect(enterForbidden(sheet, "t4", "save the file as notes.txt")).not.toBeNull();
  expect(enterForbidden(sheet, "t4", "save it as notes.txt and replace the old one")).toBeNull();
  const page = (submit: string) => [el(0, "AXWindow", "Shop"), el(1, "AXWebArea", "Shop", 0), el(2, "AXGroup", "", 1), el(3, "AXTextField", "Card name", 2), el(4, "AXButton", submit, 2),
    el(5, "AXGroup", "", 1), el(6, "AXSearchField", "Search", 5), el(7, "AXButton", "Search", 5)];
  expect(enterForbidden(page("Place order"), "t3", "find the price of AirPods")).not.toBeNull();
  expect(enterForbidden(page("Place order"), "t6", "find the price of AirPods")).toBeNull(); // the search form is a different form
  expect(enterForbidden(page("Continue"), "t3", "find the price of AirPods")).toBeNull();
  expect(enterForbidden([el(0, "AXWindow", "Notes"), el(1, "AXTextArea", "Note", 0)], "t1", "write hello")).toBeNull();
});

test("editing someone else's text needs an edit verb that names it", async () => {
  const { editAllowed } = await import("../src/safety.ts");
  expect(editAllowed("add milk to my Groceries note", "Note\nGroceries\n• eggs")).toBe(true);
  expect(editAllowed("edit this note: fix the typo", "Note\nMeeting notes")).toBe(true);
  expect(editAllowed("reply to Sam saying on my way", "Message")).toBe(true);
  expect(editAllowed("change the name to Bob", "Name\nAlice")).toBe(true);
  expect(editAllowed("write a new note about Tokyo and change the font", "Note\nGroceries")).toBe(false);
  expect(editAllowed("add a note about Tokyo", "Note\nGroceries")).toBe(false); // "add" alone creates
  expect(editAllowed("do not change my Groceries note", "Note\nGroceries")).toBe(false);
  expect(editAllowed("write 'update the Groceries list'", "Note\nGroceries")).toBe(false);
});

test("the undo script cannot run commands hidden in a file name", () => {
  // macOS: the temp folder is behind a link (/var -> /private/var), and FileOps works on real paths
  const root = realpathSync(mkdtempSync(join(tmpdir(), "bs-undo-")));
  const evil = "a $(touch pwned) `id` 'quote'.txt";
  writeFileSync(join(root, evil), "x");
  const ops = new FileOps(root, join(root, ".undo"), "t1");
  ops.makeFolder("Docs");
  expect(ops.moveFile(evil, "Docs").ok).toBe(true);
  const script = readFileSync(ops.undoFile, "utf8");
  expect(script).toContain(`'${join(root, "Docs", "a $(touch pwned) `id` ")}'\\''quote'\\''.txt'`);
  expect(script).not.toContain('"');
});

test("a link inside the home folder cannot lead outside it", () => {
  const link = join(homedir(), `bs-link-test-${process.pid}`);
  symlinkSync(tmpdir(), link);
  try { expect(safeRoot(link)).not.toBeNull(); } finally { rmSync(link); }
});

test("two places in one app stay two tasks, run one after the other; a 10th task waits for its agent name", async () => {
  const { mergeSameApp, waitsFor } = await import("../src/manager.ts");
  const m = mergeSameApp([
    { app: "Finder", goal: "organise by type", url: "/a" },
    { app: "Finder", goal: "organise by name", url: "/b" },
    { app: "Calculator", goal: "7 x 8" },
    { app: "calculator", goal: "9 x 9" },
  ] as any);
  expect(m.map((t) => t.url ?? "")).toEqual(["/a", "/b", ""]);
  expect(m[2]!.goal).toBe("7 x 8 Then: 9 x 9");
  const tasks = m.map((t, i) => ({ app: t.app, agent: `agent${i % 9}` }));
  expect(tasks.map((_, i) => waitsFor(tasks, i))).toEqual([-1, 0, -1]);
  const ten = Array.from({ length: 10 }, (_, i) => ({ app: `App${i}`, agent: `agent${i % 9}` }));
  expect(waitsFor(ten, 9)).toBe(0);
  expect(waitsFor(ten, 5)).toBe(-1);
});
