// Which addresses an agent may open (they can come from an LLM plan that read a hostile page).
import { expect, test } from "bun:test";
import { homedir } from "node:os";
import { checkUrl } from "../src/apps.ts";

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
