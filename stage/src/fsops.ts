// Scripted file operations for Finder tasks. A background agent cannot move files through Finder's GUI: Cua refuses
// background drags on macOS (measured: background_unavailable), and the keyboard shortcuts are refused too. So moves
// are file-system calls, under strict rules, and every one is DISCLOSED as "scripted" in the log and the panel:
//   * only inside the one folder the Finder window shows (its direct children), never outside, never through a link
//   * never delete, never overwrite (an existing name is skipped and reported)
//   * every move is written to an undo script you can run
import { constants, copyFileSync, existsSync, linkSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { AxElement, Observation } from "./contracts.ts";

/** the folder a Finder window shows, read from its path bar (Macintosh HD › Users › … › folder) */
/** a folder the user names by path ("~/Desktop/stuff", "/Users/me/x"): the Finder window is opened there */
export function folderIn(clause: string): string | undefined {
  const m = clause.match(/(?:^|\s)((?:~|\/Users)\/[^\s,;"'“”]+(?:\s(?![a-z]+\b)[^\s,;]+)*)/);
  return m ? m[1]!.replace(/[.,;:]$/, "") : undefined;
}

/** whether two folder paths are the same folder (~ expanded, links and case resolved by the file system) */
export function sameFolder(a: string, b: string): boolean {
  const real = (p: string) => {
    const full = resolve(p.replace(/^~(?=\/|$)/, homedir()));
    try {
      return realpathSync(full);
    } catch {
      return full;
    }
  };
  return real(a) === real(b);
}

export function finderFolder(obs: Observation): string | null {
  const pathList = obs.elements.find((e) => e.role === "AXList" && e.label === "path");
  if (!pathList) return null;
  const parts = obs.elements.filter((e: AxElement) => e.parent === pathList.index).map((e) => (e.value ?? e.label ?? "").trim());
  if (!parts.length) return null;
  let rest = parts[0] === "Macintosh HD" ? parts.slice(1) : parts;
  // the path bar also shows the SELECTED item: cut at the folder the window shows (its title)
  const cut = rest.lastIndexOf(obs.window.title);
  if (cut >= 0) rest = rest.slice(0, cut + 1);
  let path = "/" + rest.join("/");
  while (path !== "/" && (!existsSync(path) || !statSync(path).isDirectory())) path = path.slice(0, path.lastIndexOf("/")) || "/";
  return path;
}

/** a path for the undo script, in single quotes: the shell expands nothing inside them ($(...), `...`, $HOME) */
const sh = (p: string) => `'${p.replace(/'/g, `'\\''`)}'`;

/** folders an agent may organise: inside your home folder, not the home folder itself, not Library */
export function safeRoot(dir: string): string | null {
  const home = realpathSync(homedir());
  // follow links first: a link inside your home folder can point anywhere
  let abs = resolve(dir);
  try { abs = realpathSync(abs); } catch { return "that folder does not exist"; }
  if (!abs.startsWith(home + "/") || abs === home) return "only folders inside your home folder (not the home folder itself) can be organised";
  if (/\/Library(\/|$)|\/\.[^/]+/.test(abs.slice(home.length))) return "system and hidden folders are off limits";
  if (!existsSync(abs) || !statSync(abs).isDirectory()) return "that folder does not exist";
  return null;
}

const badName = (n: string) => !n.trim() || n.includes("/") || n.includes("\0") || n === "." || n === ".." || n.startsWith(".");

/** the loose files directly inside a folder (not folders, not hidden files, not links) */
export function looseFiles(root: string): string[] {
  return readdirSync(root).filter((n) => !n.startsWith(".") && lstatSync(join(root, n)).isFile()).sort();
}

/** a short listing (2 levels) of a folder, for the verifier (a link is listed, never followed) */
export function listTree(root: string, max = 80): string[] {
  const out: string[] = [];
  for (const name of readdirSync(root).filter((n) => !n.startsWith(".")).sort()) {
    const p = join(root, name);
    if (lstatSync(p).isSymbolicLink()) out.push(`${name} (link)`);
    else if (statSync(p).isDirectory()) {
      const inner = readdirSync(p).filter((n) => !n.startsWith("."));
      out.push(`${name}/ : ${inner.length ? inner.join(", ") : "(empty)"}`);
    } else out.push(name);
    if (out.length >= max) break;
  }
  return out;
}

const lstat = (p: string) => { try { return lstatSync(p); } catch { return undefined; } };

export class FileOps {
  /** the folder with every link resolved: all checks and moves use this real path */
  readonly root: string;
  readonly undoFile: string;
  private readonly header: string;
  /** undo commands in the order the actions were done; the script holds them newest first, so it runs top to bottom */
  private readonly undo: string[] = [];
  constructor(root: string, undoDir: string, taskId: string) {
    this.root = realpathSync(root);
    mkdirSync(undoDir, { recursive: true });
    this.undoFile = join(undoDir, `undo-${taskId}.sh`);
    this.header = `#!/bin/sh\n# Undo the scripted file moves of task ${taskId} (newest first: run it as it is)\n`;
    if (existsSync(this.undoFile)) this.undo.push(...readFileSync(this.undoFile, "utf8").split("\n").filter((l) => l && !l.startsWith("#")).reverse());
    this.writeUndo();
  }

  private writeUndo(line?: string) {
    if (line) this.undo.push(line);
    writeFileSync(this.undoFile, this.header + [...this.undo].reverse().map((l) => l + "\n").join(""));
  }

  makeFolder(name: string): { ok: boolean; detail: string } {
    if (badName(name)) return { ok: false, detail: `refused folder name "${name}"` };
    const p = join(this.root, name);
    const st = lstat(p);
    if (st?.isSymbolicLink()) return { ok: false, detail: `"${name}" is a link: not using it` };
    if (st) return st.isDirectory() ? { ok: true, detail: `folder "${name}" already exists` } : { ok: false, detail: `"${name}" exists and is not a folder` };
    mkdirSync(p);
    this.writeUndo(`rmdir ${sh(p)}  # only succeeds if empty`);
    return { ok: true, detail: `created folder "${name}"` };
  }

  moveFile(file: string, folder: string): { ok: boolean; detail: string } {
    if (badName(file) || badName(folder)) return { ok: false, detail: `refused names "${file}" → "${folder}"` };
    const src = join(this.root, file);
    const dstDir = join(this.root, folder);
    const s = lstat(src);
    if (!s) return { ok: false, detail: `"${file}" is not in this folder` };
    if (!s.isFile()) return { ok: false, detail: `"${file}" is not a plain file: not moving it` };
    // a link named like a folder leads anywhere (statSync and rename would follow it): refuse links, and the real
    // destination must still be inside the real root
    const d = lstat(dstDir);
    if (!d || (!d.isDirectory() && !d.isSymbolicLink())) return { ok: false, detail: `no folder "${folder}" here` };
    if (d.isSymbolicLink()) return { ok: false, detail: `"${folder}" is a link: not moving anything through it` };
    const realDir = realpathSync(dstDir);
    if (!realDir.startsWith(this.root + "/")) return { ok: false, detail: `"${folder}" leads outside ${this.root}: refused` };
    const dst = join(realDir, basename(file));
    // never overwrite, atomically: a hard link fails if the name exists (EEXIST); then the old name goes. Across
    // volumes (or where hard links aren't supported): an exclusive copy, then the original goes
    try {
      linkSync(src, dst);
    } catch (e: any) {
      if (e?.code === "EEXIST") return { ok: false, detail: `"${folder}/${file}" already exists: not overwriting` };
      try { copyFileSync(src, dst, constants.COPYFILE_EXCL); } catch (e2: any) {
        return { ok: false, detail: e2?.code === "EEXIST" ? `"${folder}/${file}" already exists: not overwriting` : `could not move "${file}": ${e2?.code ?? e2}` };
      }
    }
    unlinkSync(src);
    this.writeUndo(`mv -n ${sh(dst)} ${sh(src)}`);
    return { ok: true, detail: `moved "${file}" → ${folder}/` };
  }
}
