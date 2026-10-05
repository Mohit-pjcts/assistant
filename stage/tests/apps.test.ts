// Which addresses an agent may open (they can come from an LLM plan that read a hostile page), which installed app a
// name stands for (strictly, for Oni's tasks), and which apps to suggest when a task names one that isn't there.
import { expect, test } from "bun:test";
import { homedir } from "node:os";
import { checkUrl, resolveAppStrict, suggestApps } from "../src/apps.ts";

const ok = (u: string, app = "Safari") => { const r = checkUrl(u, app); if (!r.ok) throw new Error(`${u}: ${r.why}`); return r.url; };
const refused = (u: string, app = "Safari") => checkUrl(u, app).ok === false;

test("web addresses the compilers and planners build are allowed", () => {
  expect(ok("https://en.wikipedia.org/w/index.php?search=University%20of%20Hong%20Kong")).toContain("wikipedia.org");
  expect(ok("https://www.google.com/search?q=" + encodeURIComponent("how tall is the peak tower ".repeat(20)))).toContain("google.com");
  expect(ok("https://www.google.com.hk/search?q=x")).toContain("google.com.hk");
  expect(ok("example.com")).toBe("https://example.com/");
  expect(ok("http://example.org/a?b=c")).toBe("http://example.org/a?b=c");
  expect(ok("https://www.youtube.com")).toBe("https://www.youtube.com/");
});

test("only the app links the code itself builds", () => {
  expect(ok("maps://?daddr=Central&dirflg=r", "Maps")).toStartWith("maps://");
  expect(ok("stocks://?symbol=AAPL", "Stocks")).toStartWith("stocks://");
  for (const u of ["file:///etc/passwd", "FILE:///Users/x/.ssh/id_rsa", "javascript:alert(1)", "data:text/html,<b>x</b>", "mailto:a@b.com", "tel:123", "x-apple.systempreferences:com.apple.preference.security", "vscode://file/x", "ftp://example.com/x"]) {
    expect(refused(u)).toBe(true);
  }
});

test("local and private-network hosts, and credentials in the address, are refused", () => {
  for (const u of ["http://127.0.0.1:3000/api/stop", "localhost:3000", "http://localhost/x", "http://192.168.1.1/", "http://10.0.0.5", "http://172.20.1.1", "http://[::1]:3000/", "http://printer.local/", "https://user:pw@example.com/"]) {
    expect(refused(u)).toBe(true);
  }
});

test("a long chunk of text sent to an unfamiliar site is refused; the same on a search engine is fine", () => {
  const leak = encodeURIComponent("Dear Sohan, the account number is 12345678 and the PIN reminder is ... ".repeat(5));
  expect(refused(`https://collector.example.net/c?d=${leak}`)).toBe(true);
  expect(refused(`https://collector.example.net/${leak}`)).toBe(true);
  expect(ok(`https://www.google.com/search?q=${leak}`)).toContain("google.com");
  expect(ok("https://example.net/a/short/path?x=1")).toContain("example.net");
});

test("folder paths open only in Finder, and never an app or a path with '..'", () => {
  expect(ok("~/Downloads", "Finder")).toBe(`${homedir()}/Downloads`);
  expect(ok("/Users/someone/Documents/School", "Finder")).toBe("/Users/someone/Documents/School");
  expect(refused("/Users/someone/Documents", "Safari")).toBe(true);
  expect(refused("/Applications/Calculator.app", "Finder")).toBe(true);
  expect(refused("~/Downloads/../../../etc", "Finder")).toBe(true);
  expect(refused("~/bin/run.sh", "Finder")).toBe(true);
});

const installed = (name: string, running = false) => ({ name, bundle_id: `com.test.${name}`, running });
const APPS = ["Google Chrome", "Google Earth", "Spotify", "Photos", "Photo Booth", "Calculator", "Arc", "Microsoft Word", "Microsoft Excel", "System Settings", "System Information"].map((n) => installed(n));

const MAC = ["Calculator", "Notes", "Safari", "Photos", "Photo Booth", "Brave Browser", "Brave Browser Beta", "Google Chrome", "Google Chrome Canary", "Microsoft Word", "Microsoft Excel", "System Settings", "System Information", "Visual Studio Code", "App Store"].map((n) => installed(n));
const strict = (name: string, apps = MAC) => resolveAppStrict(apps, name)?.name ?? null;

test("a name stands for an app only when it names it: exactly (any case), by a short name, or as the whole words of one installed name", () => {
  expect(strict("Calculator")).toBe("Calculator");
  expect(strict("  CALCULATOR ")).toBe("Calculator"); // case and spaces don't matter
  expect(strict("calculator.app")).toBe("Calculator");
  expect(strict("google   chrome")).toBe("Google Chrome");
  expect(strict("Brave")).toBe("Brave Browser"); // the short name goes to the app people mean, not to the Beta
  expect(strict("chrome")).toBe("Google Chrome");
  expect(strict("Word")).toBe("Microsoft Word");
  expect(strict("excel")).toBe("Microsoft Excel");
  expect(strict("Settings")).toBe("System Settings"); // the only installed name with that word
  expect(strict("Studio Code")).toBe("Visual Studio Code"); // whole words in a row
  expect(strict("Booth")).toBe("Photo Booth");
  expect(strict("Store")).toBe("App Store");
  expect(resolveAppStrict([installed("Word"), installed("Microsoft Word")], "word")?.name).toBe("Word"); // an exact name comes before a short name
  expect(resolveAppStrict([installed("System Settings"), installed("system settings")], "Settings")?.name).toBe("System Settings"); // one name listed twice is still one app
});

test("never a guess: a name that contains an installed name, a prefix, part of a word, or a word two apps share is unknown", () => {
  expect(strict("Photoshop")).toBeNull(); // Photos is INSIDE it: not the same app
  expect(strict("Safari browser")).toBeNull();
  expect(strict("Calculator app")).toBeNull();
  expect(strict("Notes app")).toBeNull();
  expect(strict("Calc")).toBeNull(); // a prefix is not a name
  expect(strict("Wor")).toBeNull(); // nor part of a word
  expect(strict("System")).toBeNull(); // System Settings and System Information
  expect(strict("Microsoft")).toBeNull(); // Word and Excel
  expect(strict("Brave Beta")).toBeNull(); // the words aren't in a row in "Brave Browser Beta"
  expect(strict("app")).toBeNull(); // "App Store" has the word, but a bare "app" names no app
  expect(strict("the app")).toBeNull();
  expect(strict("")).toBeNull();
  expect(strict("!!!")).toBeNull();
  // a short name stands for that app only when it is installed
  expect(resolveAppStrict([installed("Chromium"), installed("Pages")], "Chrome")).toBeNull();
  expect(resolveAppStrict([installed("Chromium"), installed("Pages")], "Word")).toBeNull();
  // the caller's reply then suggests the closest names instead
  expect(suggestApps(MAC, "Photoshop")).toEqual(["Photos", "Photo Booth"]);
  expect(suggestApps(MAC, "Safari browser")[0]).toBe("Safari");
  expect(suggestApps(MAC, "System")).toEqual(["System Information", "System Settings"]);
  expect(suggestApps(MAC, "Calc")).toEqual(["Calculator"]);
});

test("an app name nothing matches gets the installed apps that look like it: a shared word, one name inside the other, the same start", () => {
  expect(suggestApps(APPS, "Spotfy")).toEqual(["Spotify"]); // the same first three letters
  expect(suggestApps(APPS, "Spotfy.app")).toEqual(["Spotify"]);
  expect(suggestApps(APPS, "Google Docs")).toEqual(["Google Chrome", "Google Earth"]); // a word in common
  expect(suggestApps(APPS, "GOOGLE DOCS")).toEqual(["Google Chrome", "Google Earth"]); // case doesn't matter
  expect(suggestApps(APPS, "Microsoft PowerPoint")).toEqual(["Microsoft Excel", "Microsoft Word"]);
  expect(suggestApps(APPS, "Photoshop")).toEqual(["Photos", "Photo Booth"]); // Photos is inside "photoshop": it comes before the same-start Photo Booth
  expect(suggestApps(APPS, "Zzzz")).toEqual([]);
  expect(suggestApps(APPS, "   ")).toEqual([]);
  // "the" and "app" say nothing about which app; an app of three letters inside a longer word (Arc in "search") proves nothing either
  expect(suggestApps(APPS, "search the app")).toEqual([]);
});

test("suggestions are best first (shared words, then one name inside the other, then the same start, then running apps), at most five, each app once", () => {
  expect(suggestApps(APPS, "System")).toEqual(["System Information", "System Settings"]); // equal on every count: by name
  expect(suggestApps([installed("Photos"), installed("Photo Booth", true)], "Photomatic")).toEqual(["Photo Booth", "Photos"]); // a running app first among equals
  const many = Array.from({ length: 8 }, (_, i) => installed(`Microsoft App ${i}`));
  expect(suggestApps(many, "Microsoft Teams")).toHaveLength(5);
  expect(suggestApps([installed("Spotify"), installed("Spotify")], "Spotfy")).toEqual(["Spotify"]);
});
