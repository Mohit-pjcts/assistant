// The hotkey, as Oni sees it. Every hotkey request goes hotkey → Oni's supervisor → a sub-agent (STEPS.md 163): Stage
// takes the screenshot at key-down, posts it with the words to Oni's POST /hotkey/turn, and speaks the reply. Stage no
// longer decides what a request means. Only the words that CONTROL something already running stay in code here (move a
// lesson on, clear the drawings, stop): a model call to move to the next step would be seconds and money for nothing.
// When Oni isn't there at all, server.ts falls back to the old local router (router.ts), so the hotkey still works.
import { BACK_WORDS, NEXT_WORDS } from "./explain.ts";
import { DISMISS } from "./router.ts";
import { sayable } from "./results.ts";

const STOP = /^(stop|cancel|abort|halt)( (it|that|everything|the agents|agents|now))?$/;
const norm = (text: string) => text.toLowerCase().replace(/[.!?,]+$/g, "").replace(/\s+/g, " ").trim();

/** "stop": end the agents and Oni's turn; "lesson": a lesson word or "clear" for Onstage; null: a request for Oni */
export type Control = "stop" | "lesson" | null;

export function localControl(text: string, ctx: { lesson: boolean; working: boolean }): Control {
  const w = norm(text);
  if (STOP.test(w) && ctx.working) return "stop";
  if (DISMISS.test(w)) return "lesson"; // "clear", "never mind": clears the drawings
  if (ctx.lesson && (NEXT_WORDS.test(w) || BACK_WORDS.test(w))) return "lesson";
  return null;
}

export const oniUrl = () => (process.env.ONI_URL ?? "http://127.0.0.1:8000").replace(/\/+$/, "");
/** STAGE_HOTKEY_VIA_ONI=0 puts the old local router back, whatever Oni is doing */
export const viaOni = () => process.env.STAGE_HOTKEY_VIA_ONI !== "0";

export interface OniReply { type: "message" | "busy" | "cancelled" | "error"; content: string; declined_actions?: string[] }
export type OniResult =
  | { ok: true; reply: OniReply }
  // `unreachable`: nothing of this request reached a supervisor (Oni is off, or an older Oni without the endpoint), so
  // doing it locally instead cannot run it twice. Any other failure might have started real work: never retried.
  | { ok: false; unreachable: boolean; error: string };

export interface HotkeyBody { text: string; screenshot?: string; app?: string; window?: string }

const REFUSED = /ConnectionRefused|ECONNREFUSED|Unable to connect|connection refused/i;

/** one supervisor turn for a hotkey request. No timeout of its own beyond a generous cap: a turn can wait on agents for minutes. */
export async function askOni(body: HotkeyBody, signal: AbortSignal, capMs = 20 * 60_000): Promise<OniResult> {
  let res: Response;
  try {
    res = await fetch(`${oniUrl()}/hotkey/turn`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.any([signal, AbortSignal.timeout(capMs)]),
      // a hotkey press is rare and its turn long: a pooled connection to an Oni that has since restarted would fail
      // with ECONNRESET (indistinguishable from a reset mid-turn) instead of a clean "refused"
      keepalive: false,
    });
  } catch (e: any) {
    if (signal.aborted) return { ok: false, unreachable: false, error: "stopped" };
    const why = String(e?.code ?? e?.message ?? e);
    return { ok: false, unreachable: REFUSED.test(`${e?.code ?? ""} ${e?.message ?? ""}`), error: why.slice(0, 200) };
  }
  if (res.status === 404 || res.status === 405) return { ok: false, unreachable: true, error: "this Oni has no hotkey endpoint yet (restart it)" };
  let json: any;
  try { json = await res.json(); } catch { json = undefined; }
  if (!res.ok) return { ok: false, unreachable: false, error: String(json?.detail ?? `Oni answered ${res.status}`).slice(0, 200) };
  if (!json || typeof json.content !== "string") return { ok: false, unreachable: false, error: "Oni's answer was not understood" };
  return { ok: true, reply: json as OniReply };
}

/** ask Oni to cancel the turn it is running on the active thread (best-effort: the agents are stopped separately) */
export async function stopOni(): Promise<void> {
  try {
    await fetch(`${oniUrl()}/chat/stop`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}", signal: AbortSignal.timeout(3000) });
  } catch { /* Oni is gone or slow: nothing left to stop */ }
}

/** the model's reply as something to read out: no markdown, links or bullets, at most two sentences */
export function speakable(content: string): string {
  const plain = content
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*[-*•]\s+/gm, "")
    .replace(/^\s*\d+[.)]\s+/gm, "")
    .replace(/[*_`~|]+/g, "")
    .replace(/\s*\n+\s*/g, ". ")
    .replace(/\.(\s*\.)+/g, ".")
    .replace(/\s+/g, " ")
    .trim();
  return sayable(plain) || "Done.";
}
