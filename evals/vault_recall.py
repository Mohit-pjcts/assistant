"""Recall benchmark for `search_vault` against the REAL vault (read-only; skips when it is absent).

    python -m evals.vault_recall [--queries paraphrases.json] [--limit N]

Keyword-style queries are generated from each note's own body BEYOND its first 500 characters (the
part the older semantic layer never saw): four distinctive words from a sentence, ground truth = that
note. `--queries` adds a JSON list of [query, note title] pairs, e.g. hand-written paraphrases; keep
private ones out of git. Reports recall@1/3/5 for the tool as it was (chunk layer switched off) and
as it is now, and checks that every note the old tool listed is still listed (the additive guarantee).
No model API is called; the local embedding model is, once, to embed the vault's chunks.
"""

from __future__ import annotations

import argparse
import json
import random
import re
import sys
import time
from pathlib import Path

from assistant import obsidian_tools, vault_index

_TITLE = re.compile(r"^\[\[(.+?)\]\]", re.MULTILINE)
_STOP = vault_index._STOPWORDS


def keyword_queries(limit: int | None, seed: int = 7) -> list[tuple[str, str]]:
    rng = random.Random(seed)
    out: list[tuple[str, str]] = []
    for path in obsidian_tools._iter_notes():
        try:
            body = vault_index.strip_frontmatter(path.read_text())
        except (OSError, UnicodeDecodeError):
            continue
        if len(body) < 900:
            continue
        sents = [s for s in re.split(r"(?<=[.!?\n])\s+", body[500:]) if len(vault_index.tokenize(s)) >= 7]
        rng.shuffle(sents)
        for s in sents[:2]:
            words = [w for w in vault_index.tokenize(s) if len(w) > 3]
            if len(words) >= 4:
                out.append((" ".join(rng.sample(words, 4)), path.stem))
    return out[:limit] if limit else out


def listing(query: str) -> list[str]:
    return _TITLE.findall(obsidian_tools.search_vault.invoke({"query": query}))


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--queries", type=Path, help="JSON list of [query, note title] pairs")
    ap.add_argument("--limit", type=int)
    args = ap.parse_args(argv)
    if not obsidian_tools.VAULT_DIR.exists():
        print("no vault; nothing to measure")
        return 0

    t0 = time.time()
    vault_index._embed_missing(vault_index.get_index())  # one-off 13 s; cached afterwards
    print(f"index ready in {time.time() - t0:.1f}s: {len(vault_index.get_index().chunks)} chunks")

    sets = {"keyword-style": keyword_queries(args.limit)}
    if args.queries:
        sets["supplied"] = [tuple(p) for p in json.loads(args.queries.read_text())]

    real_search = vault_index.search
    worst_missing: list[tuple[str, list[str]]] = []
    for name, queries in sets.items():
        old_lists, new_lists = [], []
        for q, _ in queries:
            vault_index.search = lambda *a, **k: []
            old_lists.append(listing(q))
            vault_index.search = real_search
            new_lists.append(listing(q))
        for label, lists in (("old (substring + first-500 semantic)", old_lists), ("new (+ chunk hybrid)", new_lists)):
            n = len(queries)
            r = [sum(gt in got[:k] for (_, gt), got in zip(queries, lists, strict=True)) / n for k in (1, 3, 5)]
            print(f"{name:14} {label:38} R@1 {r[0]:.2f}  R@3 {r[1]:.2f}  R@5 {r[2]:.2f}  (n={n})")
        for (q, _), old, new in zip(queries, old_lists, new_lists, strict=True):
            lost = [t for t in old if t not in new]
            if lost:
                worst_missing.append((q, lost))
    print(f"\nadditive check: {len(worst_missing)} queries lost a note the old tool listed")
    for q, lost in worst_missing[:10]:
        print("  ", q, "->", lost)
    return 1 if worst_missing else 0


if __name__ == "__main__":
    sys.exit(main())
