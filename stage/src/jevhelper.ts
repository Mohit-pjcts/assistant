// A Helper with no LLM in the normal path:
//   plan    -> compilers in code (compile.ts), then a plan cache, then (optional, counted) the LLM planner, else none
//   verify  -> deterministic "did anything change?" + jev yes/no on the NEW screen text; answers are extracted by jev
//              choosing the answering line from the screen (extraction as classification)
//   write   -> the text the user gave; an LLM only for genuinely creative text (optional, counted)
import { choice, noul, TypeSafeClient } from "@typesafe-ai/sdk";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Helper, Item, PlanStep } from "./contracts.ts";
import { asksQuestion, compilePlan, explicitText, FIND_FIELD, goalValues, MESSAGE_FIELD, mustCompute } from "./compile.ts";
import { JEV_MODEL, JEV_PRICE_PER_TOKEN } from "./decide.ts";
import { joinFragments, relevantLines, TEXT_INPUT } from "./perceive.ts";

const CACHE = join(import.meta.dir, "..", "runs", "plan-cache.json");
const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

export interface HelperStats { compiled: number; cached: number; llmFallback: number; none: number }
/** where a plan came from. Returned with EACH plan: parallel agents share one helper, so a shared "last source" field
 *  would let another agent's plan call decide this agent's mode */
export type PlanSource = "compiled" | "cached" | "llm" | "none";

const FILLER_WORDS = new Set(["the", "and", "are", "was", "were", "has", "have", "its", "it's", "this", "that", "with", "for", "from", "about", "approximately", "around", "roughly", "shown", "shows", "screen", "made", "makes", "maker", "developer", "developed", "called", "named", "answer", "which", "there", "one", "app", "application"]);
const answerWords = (s: string) => s.toLowerCase().replace(/,(?=\d{3})/g, "").match(/[\p{L}\p{N}][\p{L}\p{N}.]*/gu)?.map((w) => w.replace(/\.$/, "")) ?? [];

/**
 * An LLM's answer to a question must be READ off the screen: at least half of its answer words (beyond the question's
 * own words) have to be there. The prompt already says "only the text visible", and still, live, the App Store tie-break
 * answered "Apple makes Xcode" because "the official Xcode app is made by Apple", with no "Apple" anywhere on screen.
 */
export function groundedIn(answer: string, goal: string, screen: string[], items: Item[]): boolean {
  const asked = new Set(answerWords(goal));
  const key = answerWords(answer).filter((w) => !asked.has(w) && !FILLER_WORDS.has(w) && (w.length >= 3 || /\d/.test(w)));
  if (!key.length) return true;
  const seen = new Set(answerWords([...screen, ...items.map((i) => `${i.text} ${i.value ?? ""}`)].join(" ")));
  return key.filter((w) => seen.has(w)).length / key.length >= 0.5;
}

export class JevHelper implements Helper {
  private client: TypeSafeClient;
  readonly stats: HelperStats = { compiled: 0, cached: 0, llmFallback: 0, none: 0 };

  get canEscalate() { return !!this.fallback; }

  /** reading a picture needs vision: the LLM fallback's, when there is one (counted like any other fallback) */
  get readPicture() {
    const fb = this.fallback;
    if (!fb?.readPicture) return undefined;
    return (goal: string, png: string) => { this.stats.llmFallback++; return fb.readPicture!(goal, png); };
  }

  constructor(private fallback?: Helper, model = JEV_MODEL) {
    this.client = new TypeSafeClient({ timeout: 4000, retry: { maxRetries: 1 }, defaultModel: model });
  }

  // ---------- plans ----------
  private cache(): Record<string, PlanStep[]> {
    try { return existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, "utf8")) : {}; } catch { return {}; }
  }
  /** remember a plan for the same app + goal. The loop no longer calls this: the only LLM plans are mid-task re-plans
   *  made from window text (an injected plan would become permanent once it "verified"). Kept for hand-made entries. */
  remember(app: string, goal: string, steps: PlanStep[]) {
    if (!steps.length) return;
    const c = this.cache();
    c[`${app}::${norm(goal)}`] = steps;
    try { writeFileSync(CACHE, JSON.stringify(c, null, 1)); } catch { /* cache is optional */ }
  }

  async plan(goal: string, app: string, screen: string[], items: Item[], why?: string, files?: string[]): Promise<{ steps: PlanStep[]; costUsd: number; ms: number; source: PlanSource }> {
    const t0 = performance.now();
    if (!why) {
      const compiled = compilePlan(app, goal, items, files);
      if (compiled) { this.stats.compiled++; return { steps: compiled, costUsd: 0, ms: Math.round(performance.now() - t0), source: "compiled" }; }
      const cached = this.cache()[`${app}::${norm(goal)}`];
      if (cached) { this.stats.cached++; return { steps: cached, costUsd: 0, ms: Math.round(performance.now() - t0), source: "cached" }; }
    }
    // "LLM only where needed": no compiler / cache -> jev starts ALONE. The LLM plans only when the loop escalates
    // (jev unsure, stalled, or the result not achieved), which arrives here with a reason (why).
    if (why && this.fallback) {
      this.stats.llmFallback++;
      return { ...(await this.fallback.plan(goal, app, screen, items, why, files)), source: "llm" };
    }
    this.stats.none++;
    return { steps: [], costUsd: 0, ms: 0, source: "none" }; // jev works step by step on its own
  }

  // ---------- text ----------
  async writeText(goal: string, field: Item, screen: string[], previous: string[]) {
    // the goal may give several values ("message Sohan "hi"": a name and a message): which one goes into THIS field
    // is a decision (a search or recipient field wants the name, a message field the text), not "the first quote"
    // (only quoted text and the names the goal asks to reach count: "a packing list for Tokyo" is not a value to type)
    const { quoted, targets } = goalValues(goal);
    // what the field is for decides first: a message field never gets the name of who to reach, a search /
    // recipient field gets that name
    const isMessage = MESSAGE_FIELD.test(field.text) && !FIND_FIELD.test(field.text);
    const isFind = FIND_FIELD.test(field.text) || field.role === "AXSearchField";
    if (isFind && targets.length === 1) return { text: targets[0]!, costUsd: 0, ms: 0 };
    const values = isMessage ? quoted : [...new Set([...quoted, ...targets])];
    if (isMessage && values.length === 1) return { text: values[0]!, costUsd: 0, ms: 0 };
    if (values.length > 1 || (values.length === 1 && targets.length === 1)) {
      const t0 = performance.now();
      const options: Record<string, string> = Object.fromEntries(values.map((v, i) => [String(i), v]));
      options.none = "none of these: something else has to be written here";
      try {
        const r = await this.client.systemOne({ state: { goal, field: field.text, field_kind: field.role.replace(/^AX/, ""), already_done: previous.slice(-6) }, questions: { q: choice(`Which value should be typed into the field "${field.text}"?`, options) } } as any);
        const a = (r.answers as any).q;
        const costUsd = (r.usage?.input_tokens ?? 0) * JEV_PRICE_PER_TOKEN;
        const ms = Math.round(performance.now() - t0);
        if (a.choice !== "none" && a.confidence >= 0.5) return { text: values[Number(a.choice)]!, costUsd, ms };
        if (a.choice === "none" && a.confidence >= 0.5 && this.fallback) { this.stats.llmFallback++; return { ...(await this.fallback.writeText(goal, field, screen, previous)), llm: true }; }
      } catch { /* jev unavailable: fall through */ }
    }
    const t = explicitText(goal);
    if (t) return { text: t, costUsd: 0, ms: 0 };
    // creative text (nothing given by the user) genuinely needs a language model
    if (this.fallback) { this.stats.llmFallback++; return { ...(await this.fallback.writeText(goal, field, screen, previous)), llm: true }; }
    return { text: "", costUsd: 0, ms: 0 };
  }

  /** the LLM's verdict, with an answer to a question held to the screen (groundedIn) */
  private async llmVerify(goal: string, screen: string[], items: Item[], before?: string[]) {
    const v = await this.fallback!.verify(goal, screen, items, before);
    if (v.achieved && asksQuestion(goal) && !groundedIn(v.answer, goal, screen, items)) {
      return { ...v, achieved: false, answer: "", reason: `the answer "${v.answer.slice(0, 60)}" is not on the screen (not read off it)` };
    }
    return v;
  }

  // ---------- "done?" ----------
  async verify(goal: string, screen: string[], items: Item[], before?: string[], opts?: { acted?: boolean }) {
    const t0 = performance.now();
    let cost = 0;
    const ask = async (questions: Record<string, any>, state: object) => {
      const r = await this.client.systemOne({ state, questions } as any);
      cost += (r.usage?.input_tokens ?? 0) * JEV_PRICE_PER_TOKEN;
      return r.answers as any;
    };
    const was = new Set(before ?? []);
    const fresh = screen.filter((l) => !was.has(l));
    const controls = items.slice(0, 30).map((i) => `${i.text}${i.value ? ` = "${i.value.slice(0, 60)}"` : ""}`);

    // a computation must be DONE in this task: an old result left on screen is not an answer
    if (mustCompute(goal) && !opts?.acted) {
      return { achieved: false, answer: "", reason: "nothing has been computed in this task yet: the result on screen is from BEFORE this task, so redo the whole task from the start (clear first)", costUsd: cost, ms: Math.round(performance.now() - t0) };
    }
    // a question: pick the line that answers it (classification over the lines on screen)
    if (asksQuestion(goal)) {
      // candidates: not the window title (evidence only). A compute task got here only after acting (checked above), so
      // a line that was already on screen counts too: the agent may have recomputed the same value
      screen = joinFragments(screen); // "… starts every night at" + "8:00 p.m. sharp"
      // what a text field holds is what was typed into it (by the agent, or left over), never the answer: live, a search
      // box's leftover sentence was picked as "the weather in Tokyo"
      const echoes = items
        .filter((i) => TEXT_INPUT.has(i.role) && (i.value ?? "").trim().length >= 4)
        .map((i) => i.value!.replace(/\s+/g, " ").trim().slice(0, 40).toLowerCase());
      const echo = (l: string) => echoes.some((e) => l.replace(/\s+/g, " ").trim().toLowerCase().startsWith(e));
      // "what does X mean": a dictionary entry's first sense, the first real sentence after its part of speech. The sense
      // rarely repeats the word itself, so ranking lines by the goal's words buried it under every "Serendipity (film)"
      // (live: jev answered with the word's Wikipedia etymology)
      if (/\b(mean(s|ing)?|definition|define)\b/i.test(goal)) {
        const pos = screen.findIndex((l) => /^\[?(noun|verb|adjective|adverb|mass noun|count noun|n\.|v\.|adj\.)\]?$/i.test(l.trim()));
        const sense = pos >= 0 ? screen.slice(pos + 1, pos + 6).find((l) => !/^\[.*\]$/.test(l.trim()) && (l.match(/[\p{L}]+/gu) ?? []).length >= 4) : undefined;
        if (sense) return { achieved: true, answer: sense.replace(/\s+/g, " ").trim().slice(0, 300), reason: "the dictionary sense after its part of speech", costUsd: cost, ms: Math.round(performance.now() - t0) };
      }
      // "the top story / first result": the line ranked 1, in code (live, jev answered Hacker News' top story with #3)
      if (/\b(top|first|number one|#\s?1)\s+(stor(y|ies)|result|item|post|article|headline|link|song|entry|news)\b/i.test(goal)) {
        // "1. Title" on one line, or "1." alone with the title on the next (Hacker News exposes the rank as its own text)
        const at = screen.findIndex((l) => /^1[.)](\s|$)/.test(l.trim()));
        const ranked = at < 0 ? undefined : screen[at]!.trim().replace(/^1[.)]\s*/, "") || screen[at + 1]?.trim();
        if (ranked && ranked.length >= 2) return { achieved: true, answer: ranked.replace(/\s+/g, " ").slice(0, 300), reason: "the line ranked 1 on screen", costUsd: cost, ms: Math.round(performance.now() - t0) };
      }
      const lines = relevantLines(screen, goal, 30, 8).filter((l) => l.length <= 300 && !l.startsWith("window title:") && !echo(l));
      if (lines.length) {
        const crit: Record<string, string> = Object.fromEntries(lines.map((l, i) => [String(i), l]));
        crit.none = "No line on screen answers it yet";
        // "directly": live, for "what does serendipity mean" jev picked the word's HISTORY over its definition
        const a = await ask({ line: choice(`Which line on the screen directly answers: ${goal} (the line that states the answer itself, such as a definition, value or name; not background, history or a related fact)`, crit) }, { goal, screen_lines: lines });
        const pick = a.line;
        const ms = Math.round(performance.now() - t0);
        // borderline: let the LLM break the tie (only here). Up to 0.6, not 0.4: live, jev picked "About Privacy" at 0.55
        // as the macOS version, a wrong answer reported as done, which is far worse than one extra LLM call
        if (this.fallback && pick.confidence >= 0.2 && pick.confidence < 0.6) {
          this.stats.llmFallback++;
          const v = await this.llmVerify(goal, screen, items, before);
          return { ...v, costUsd: v.costUsd + cost, reason: `jev unsure which line answers (confidence ${pick.confidence.toFixed(2)}), LLM tie-break: ${v.reason}`, llm: true };
        }
        if (pick.choice !== "none" && pick.confidence >= 0.4) {
          // screen text often splits a sentence across lines: answer with the chosen line AND its neighbours
          const idx = screen.indexOf(lines[Number(pick.choice)]!);
          const around = (idx >= 0 ? screen.slice(Math.max(0, idx - 1), idx + 2) : [lines[Number(pick.choice)]!]).filter((l) => !l.startsWith("window title:"));
          const answer = around.join(" ").replace(/\s+/g, " ").trim().slice(0, 300);
          // a quantity question needs a number in the answer, otherwise it is not answered yet
          const needsNumber = /\b(how (many|much|tall|long|old|far|big)|population|year|when|price|cost|number|percent|temperature|weather|forecast|version|what time|rating|size|score|age)\b/i.test(goal);
          if (needsNumber && !/\d/.test(answer)) {
            return { achieved: false, answer: "", reason: `the chosen line has no number: "${answer.slice(0, 80)}"`, costUsd: cost, ms };
          }
          // a computation's answer must contain a NEW number (not only the numbers from the question, e.g. "250+175-80")
          if (mustCompute(goal) || /\b(add|plus|subtract|minus|times|divided)\b/i.test(goal)) {
            const given = new Set((goal.match(/\d+(?:\.\d+)?/g) ?? []).map(Number));
            const got = (answer.replace(/,(?=\d{3})/g, "").match(/\d+(?:\.\d+)?/g) ?? []).map(Number);
            if (!got.some((n) => !given.has(n))) {
              if (this.fallback) {
                this.stats.llmFallback++;
                const v = await this.llmVerify(goal, screen, items, before);
                return { ...v, costUsd: v.costUsd + cost, reason: `no result on screen yet (only "${answer.slice(0, 40)}"), LLM check: ${v.reason}`, llm: true };
              }
              return { achieved: false, answer: "", reason: `no computed result on screen yet: "${answer.slice(0, 60)}"`, costUsd: cost, ms };
            }
          }
          return { achieved: true, answer, reason: `jev picked this line (confidence ${pick.confidence.toFixed(2)})`, costUsd: cost, ms };
        }
        if (!/\b(open|play|write|create|add|send|type|organi[sz]e|sort)\b/i.test(goal)) {
          return { achieved: false, answer: "", reason: `no line on screen answers it yet (best: ${pick.choice}, confidence ${pick.confidence.toFixed(2)})`, costUsd: cost, ms };
        }
      }
    }
    // a goal that only asks for a STATE ("open the chat with X", "show Y") is achieved if the screen shows it, even
    // when it was already so before the task; everything else must have CHANGED something
    const stateGoal = /\b(open|show|go to|switch to|view|bring up|select)\b/i.test(goal) && !/\b(send|write|type|create|add|make|reply|message|compute|calculate|play|delete|move|save|sort|organi[sz]e)\b/i.test(goal);
    if (stateGoal && fresh.length === 0) {
      const a = await ask(
        { done: noul("Does the screen show that this goal is achieved?", { true: "Yes: the screen clearly shows it", false: "No, or it is not clear" }) },
        { goal, text_on_screen: relevantLines(screen, goal, 40, 10), controls },
      );
      const yes = a.done.noul as number;
      return { achieved: yes >= 0.7, answer: yes >= 0.7 ? "it was already so" : "", reason: `already on screen? jev ${(yes * 100).toFixed(0)}%`, costUsd: cost, ms: Math.round(performance.now() - t0) };
    }
    // "search for X" whose results are ALREADY on screen (the app kept an earlier search: live, Podcasts showed the Lex
    // Fridman results from before the task and this rule failed it as "nothing new"): done, if a line other than the
    // search box's own text names the term. Code-only, no classifier call
    const term = goal.match(/\b(?:search(?:es|ed|ing)?\s+(?:for\s+)?|look\s+up\s+|find\s+)["“]?(.+?)["”]?\s*[.?!]?$/i)?.[1]?.trim().toLowerCase();
    if (before && fresh.length === 0 && term && term.length >= 3 && !/\b(and|then|tell|what|which|how)\b/i.test(term)) {
      const boxes = new Set(items.filter((i) => TEXT_INPUT.has(i.role)).map((i) => (i.value ?? i.text).replace(/\s+/g, " ").trim().toLowerCase()));
      const hits = screen.filter((l) => { const s = l.replace(/\s+/g, " ").trim().toLowerCase(); return s.includes(term) && !boxes.has(s) && !s.startsWith("window title:"); });
      if (hits.length) return { achieved: true, answer: hits.slice(0, 3).join(" | ").slice(0, 300), reason: `results for "${term}" are on screen (${hits.length} lines)`, costUsd: cost, ms: Math.round(performance.now() - t0) };
    }
    // an action: something must have CHANGED on screen, and jev must agree the change achieves the goal
    if (before && fresh.length === 0) {
      return { achieved: false, answer: "", reason: "nothing new appeared on screen since the task started", costUsd: cost, ms: Math.round(performance.now() - t0) };
    }
    const a = await ask(
      { done: noul("Does the new text on screen show that this task's goal has been achieved?", { true: "Yes: the goal is clearly done", false: "No, or it is not clear from the screen" }) },
      { goal, new_text_on_screen: relevantLines(fresh.length ? fresh : screen, goal, 40, 10), controls },
    );
    const yes = a.done.noul as number;
    // a false "done" is the costliest mistake: anything short of clearly yes goes to the LLM for a second opinion
    if (this.fallback && yes >= 0.35 && yes < 0.85) {
      // borderline yes/no: let the LLM break the tie (only here)
      this.stats.llmFallback++;
      const v = await this.llmVerify(goal, screen, items, before);
      return { ...v, costUsd: v.costUsd + cost, reason: `jev ${(yes * 100).toFixed(0)}% sure, LLM tie-break: ${v.reason}`, llm: true };
    }
    const ms = Math.round(performance.now() - t0);
    // report the new lines that relate to the goal (not dates, counters or labels)
    const gw = new Set(goal.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []);
    const related = fresh.filter((l) => (l.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).some((w) => gw.has(w)));
    const summary = related.slice(0, 3).join(" | ").slice(0, 300);
    return {
      achieved: yes >= (this.fallback ? 0.85 : 0.6),
      answer: summary || "done",
      reason: `jev: ${(yes * 100).toFixed(0)}% that the goal is achieved${fresh.length ? ` (${fresh.length} new lines)` : ""}`,
      costUsd: cost,
      ms,
    };
  }
}
