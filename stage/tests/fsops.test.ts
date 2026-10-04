import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileOps, listTree, looseFiles } from "../src/fsops.ts";

const tmp = (p: string) => realpathSync(mkdtempSync(join(tmpdir(), p)));

test("a folder that is a link cannot carry files out of the root", () => {
  const root = tmp("bs-fs-root-");
  const outside = tmp("bs-fs-outside-");
  writeFileSync(join(root, "a.txt"), "secret");
  symlinkSync(outside, join(root, "Docs")); // looks like a folder in Finder
  const ops = new FileOps(root, join(root, ".undo"), "t1");
  expect(ops.makeFolder("Docs").ok).toBe(false); // not "already exists"
  const r = ops.moveFile("a.txt", "Docs");
  expect(r.ok).toBe(false);
  expect(r.detail).toContain("link");
  expect(readdirSync(outside)).toEqual([]);
  expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("secret");
});

test("the root itself may be reached through a link: FileOps works on its real path", () => {
  const real = tmp("bs-fs-real-");
  const via = join(tmp("bs-fs-via-"), "shortcut");
  symlinkSync(real, via);
  writeFileSync(join(real, "a.pdf"), "x");
  const ops = new FileOps(via, join(real, ".undo"), "t1");
  expect(ops.root).toBe(real);
  expect(ops.makeFolder("PDFs").ok).toBe(true);
  expect(ops.moveFile("a.pdf", "PDFs").ok).toBe(true);
  expect(existsSync(join(real, "PDFs", "a.pdf"))).toBe(true);
});

test("never overwrites, and links are neither sorted nor followed in listings", () => {
  const root = tmp("bs-fs-ow-");
  mkdirSync(join(root, "Docs"));
  writeFileSync(join(root, "Docs", "a.txt"), "old");
  writeFileSync(join(root, "a.txt"), "new");
  const outside = tmp("bs-fs-out2-");
  writeFileSync(join(outside, "private.txt"), "x");
  symlinkSync(join(outside, "private.txt"), join(root, "link.txt"));
  symlinkSync(outside, join(root, "Elsewhere"));
  const ops = new FileOps(root, join(root, ".undo"), "t1");
  expect(ops.moveFile("a.txt", "Docs").ok).toBe(false);
  expect(readFileSync(join(root, "Docs", "a.txt"), "utf8")).toBe("old");
  expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("new");
  expect(looseFiles(root)).toEqual(["a.txt"]); // the link is not a loose file
  expect(ops.moveFile("link.txt", "Docs").ok).toBe(false);
  expect(listTree(root)).toContain("Elsewhere (link)"); // listed, its contents not read
  expect(listTree(root).join(" ")).not.toContain("private.txt");
});

test("the undo script runs top to bottom and puts everything back", () => {
  const root = tmp("bs-fs-undo-");
  for (const f of ["a.pdf", "b.png", "it's $(odd).txt"]) writeFileSync(join(root, f), f);
  const ops = new FileOps(root, tmp("bs-fs-undodir-"), "t1");
  ops.makeFolder("Documents");
  ops.makeFolder("Images");
  expect(ops.moveFile("a.pdf", "Documents").ok).toBe(true);
  expect(ops.moveFile("b.png", "Images").ok).toBe(true);
  expect(ops.moveFile("it's $(odd).txt", "Documents").ok).toBe(true);
  const script = readFileSync(ops.undoFile, "utf8").split("\n");
  expect(script.findIndex((l) => l.startsWith("mv"))).toBeLessThan(script.findIndex((l) => l.startsWith("rmdir"))); // moves back first
  // a second FileOps for the same task keeps the earlier lines (and their order)
  const again = new FileOps(root, join(ops.undoFile, ".."), "t1");
  expect(readFileSync(again.undoFile, "utf8")).toBe(script.join("\n"));
  const run = Bun.spawnSync(["sh", ops.undoFile]);
  expect(run.exitCode).toBe(0);
  expect(readdirSync(root).sort()).toEqual(["a.pdf", "b.png", "it's $(odd).txt"]);
});
