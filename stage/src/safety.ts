// What a Backstage agent never does on its own, whatever the app: type a secret, or make a click (or press Enter) that
// spends money, sends, or destroys something the goal did not ask for. These are checks in code on the control's label
// and the window around it, the same in every app: text in the window (a prompt injection) can't talk its way past them.
import type { AxElement } from "./contracts.ts";
import { negatedAt, negationAfter, sendIntent, unquoted } from "./compile.ts";
import { TEXT_INPUT, inWebPage } from "./perceive.ts";

/** fields for secrets: the agent never types into them, the user does that part */
const SECRET_FIELD = /pass(word|code|phrase)|\bpin\b|card ?number|credit card|\bcvv\b|\bcvc\b|security code|expiry|social security|\bssn\b|passport|\bhkid\b|one[- ]time code|\botp\b/i;

/**
 * Clicks that cost money, publish, or can't be taken back, in groups: a goal that asks for one action of a group allows
 * the others ("delete the note" -> "Move to Trash"). Inflected forms are listed so the same patterns read goals too
 * ("without deleting anything"). Send has its own rule (sendForbidden).
 */
const RISKY: [group: string, re: string][] = [
  ["pay", String.raw`buy(?:s|ing)?|bought|purchas(?:e|es|ed|ing)|pay(?:s|ing|ment)?|paid|check(?:s|ed|ing)?[ -]?out|place[sd]? (?:the |an |my |your |this )?order|placing (?:the |an |my |your |this )?order|order now|book(?:ed|ing)? now|rent(?:s|ed|ing)?|upgrad(?:e|es|ed|ing)|renew(?:s|ed|ing)?|donat(?:e|es|ed|ing)|start (?:my |your |a |the )?(?:free )?trial`],
  ["money", String.raw`transfer(?:s|red|ring)?|withdr(?:aw|aws|awn|awing|awal|ew)|send money`],
  ["delete", String.raw`delet(?:e|es|ed|ing)|remov(?:e|es|ed|ing)|trash(?:es|ed|ing)?|move[sd]? to (?:the )?(?:trash|bin)|empty(?:ing)? (?:the )?(?:trash|bin)|clear(?:s|ed|ing)? (?:all |the |my )?(?:history|browsing data|data|chats?|messages|conversations?|cache|cookies)`],
  ["erase", String.raw`eras(?:e|es|ed|ing)|wip(?:e|es|ed|ing)|format(?:s|ted|ting)? (?:the )?disk|factory reset|reset(?:s|ting)?`],
  ["discard", String.raw`discard(?:s|ed|ing)?|don[’']?t save|do not save|without saving|revert(?:s|ed|ing)?|throw(?:s|ing)? away`],
  ["replace", String.raw`replac(?:e|es|ed|ing)|overwrit(?:e|es|ing|ten)`],
  ["submit", String.raw`submit(?:s|ted|ting)?`],
  ["confirm", String.raw`confirm(?:s|ed|ing)?`],
  ["accept", String.raw`accept(?:s|ed|ing)?|agree(?:s|d|ing)?|allow(?:s|ed|ing)?|approv(?:e|es|ed|ing)|grant(?:s|ed|ing)?|authori[sz](?:e|es|ed|ing)`],
  ["publish", String.raw`post(?:ed|ing)?|publish(?:es|ed|ing)?|tweet(?:s|ed|ing)?|go live`],
  ["signout", String.raw`sign(?:s|ed|ing)? (?:out|off)|log(?:s|ged|ging)? ?(?:out|off)|logout`],
  ["subscribe", String.raw`subscrib(?:e|es|ed|ing)`],
  ["unsubscribe", String.raw`unsubscrib(?:e|es|ed|ing)`],
  ["uninstall", String.raw`uninstall(?:s|ed|ing)?`],
  // installing software (App Store's button is just "Get": see riskyIn). Live: an agent asked to look Xcode up clicked a
  // "Get" button, which the list didn't cover
  ["install", String.raw`(?:re-?)?install(?:s|ed|ing)?|download(?:s|ed|ing)? (?:the |this |an? )?(?:app|update|game|software)|update(?:s|d)? (?:all|now)|in-app purchases?`],
  ["cancel", String.raw`cancel(?:s|led|ling)? (?:my |the |your |this )?(?:subscription|order|booking|reservation|membership|plan|account|trip|flight)`],
  ["deactivate", String.raw`deactivat(?:e|es|ed|ing)|(?:close|disable)[sd]? (?:my |your |the )?account`],
  ["leave", String.raw`leav(?:e|es|ing) (?:the |this )?(?:group|chat|channel|conversation|team|meeting|call)|exit (?:the |this )?group|end (?:the )?call`],
  ["unfollow", String.raw`unfollow(?:s|ed|ing)?|unfriend(?:s|ed|ing)?|block(?:s|ed|ing)? (?:this )?(?:contact|user|number|account|caller)|report(?:s|ed|ing)? (?:as )?(?:spam|junk|abuse)`],
];
const RISKY_RE = new RegExp(String.raw`\b(?:${RISKY.map(([, r]) => `(${r})`).join("|")})\b`, "gi");

function riskyIn(text: string): { group: string; at: number; phrase: string }[] {
  // a control labelled only "Get" (or "Get…") is an App Store install button: risky. "get" anywhere else is an ordinary
  // word ("Get Info", "Get directions", "get the weather") and is left alone
  if (/^\s*get\s*\W?\s*$/i.test(text)) return [{ group: "install", at: 0, phrase: "get" }];
  return [...text.matchAll(RISKY_RE)].map((m) => ({ group: RISKY[m.slice(1).findIndex((g) => g !== undefined)]![0], at: m.index!, phrase: m[0] }));
}

/** words of a label that say nothing about WHAT is acted on ("Delete for me", "Yes, remove it") */
const FILLER = new Set(["the", "a", "an", "this", "that", "these", "those", "it", "its", "them", "my", "your", "our", "me", "now", "here", "item", "items", "selected", "yes", "ok", "okay", "and", "to", "from", "of", "for", "on", "in", "at", "with", "button", "anyway", "please", "again", "just"]);
const words = (s: string) => s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
/** "Notes" = "note", "everything" = "all": enough to compare a label's object with the goal's */
const stem = (w: string) => (w === "everything" || w === "every" ? "all" : w.length > 3 ? w.replace(/(?<!s)s$/, "").replace(/e$/, "") : w);

export function typingForbidden(label: string): string | null {
  return SECRET_FIELD.test(label) ? `'${label.slice(0, 40)}' asks for a secret (password, card or ID). Agents never type those: please do this part yourself.` : null;
}

/**
 * A browser's own address / search bar, by its label: "Address and search bar" (Brave, Chrome, Edge, Arc), "Smart Search
 * Field" (Safari), "Search or enter website name", "Search with Google or enter address" (Firefox), "Address bar", "URL".
 * "Search" alone is not one: it is the label of a page's own search box.
 */
const ADDRESS_BAR = /^(?:address(?:\s+and\s+search)?(?:\s+(?:bar|field))?|(?:location|url)(?:\s+(?:bar|field))?|smart search field|search (?:\S+ )*?or (?:enter|type) (?:a |an )?(?:website name|web address|address|url))$/i;

/**
 * Never type into a browser's address bar, nor press Enter in it. Stage opens a site with open_url; text typed there is
 * navigated to or Googled, and a message typed by mistake (live: "hi" went into Brave's address bar when Instagram's
 * message box was not exposed yet) would go to a search engine. Only the window's own bar counts: a text field inside
 * the web page (below its AXWebArea) is the page's own, even when it is labelled "Address" or "Search". Fails closed.
 * Returns why not, or null when `e` is not an address bar.
 */
export function addressBarForbidden(els: AxElement[], e: AxElement): string | null {
  if (!TEXT_INPUT.has(e.role) || !ADDRESS_BAR.test((e.label ?? "").trim()) || inWebPage(els, e)) return null;
  return "websites open with open_url; the address bar is never typed into";
}

/**
 * Did the goal ask for this action? Only a verb of the same group that is not negated ("do not delete anything" asks
 * for nothing), and the label's other words must be in what that verb governs ("delete the draft" allows "Delete",
 * not "Delete All" or "Delete Account"; "delete the draft but not the folder" does not allow "Delete Folder").
 */
function goalAsks(goal: string, hit: { group: string; phrase: string }, label: string): boolean {
  const g = unquoted(goal);
  const verb = new Set(words(hit.phrase));
  const need = words(label).filter((w) => !verb.has(w) && !FILLER.has(w)).map(stem);
  return riskyIn(g).some((m) => {
    if (m.group !== hit.group || negatedAt(g, m.at)) return false;
    if (m.group === "pay" && /^check\w* out$/i.test(m.phrase)) return false; // "check out this page" is a look, not a purchase
    const end = negationAfter(g, m.at + m.phrase.length);
    const have = new Set(words(g.slice(m.at, end < 0 ? undefined : end)).map(stem));
    return need.every((w) => have.has(w));
  });
}

/** null when the click is fine; otherwise why not. Allowed when the goal itself asks for that action ("delete the draft") */
export function clickForbidden(label: string, goal: string): string | null {
  for (const hit of riskyIn(label)) {
    if (negatedAt(label, hit.at)) continue; // "Don't Allow", "Never Delete": a refusal, not the action
    if (hit.group === "accept" && /\bcookies?\b/i.test(label)) continue; // a cookie banner: no money, nothing lost
    if (!goalAsks(goal, hit, label)) return `'${label.slice(0, 40)}' would ${hit.phrase.toLowerCase()}, and the goal does not ask for that`;
  }
  return null;
}

const EDIT = /\b(edit|append|add|update|change|modify|replace|insert|fix|correct|reply)\b/gi;
/**
 * May the agent add to (or replace) text it did not write? Only when the goal says so (a verb that isn't negated) AND
 * names that text: "add milk to my Groceries note" (the note's first line says "Groceries"), "edit this note",
 * "change the name to Bob" (the field is "Name"). "reply" writes in the conversation's own field. An edit verb
 * elsewhere in the goal ("write a new note and change the font") is not enough. `field` = label, then contents.
 */
export function editAllowed(goal: string, field: string): boolean {
  const g = unquoted(goal);
  const lines = field.split("\n").filter((l) => l.trim());
  const named = new Set(words(lines.slice(0, 2).join(" ")).filter((w) => w.length >= 3 && !FILLER.has(w)).map(stem));
  for (const m of g.matchAll(EDIT)) {
    if (negatedAt(g, m.index!)) continue;
    if (m[0].toLowerCase() === "reply") return true;
    const rest = g.slice(m.index!);
    if (m[0].toLowerCase() === "add" && !/^add\b[^,.;]*?\bto\b/i.test(rest)) continue; // "add" alone creates; "add X to Y" edits Y
    if (/\b(this|the current|the open|the existing|my current)\s+(note|document|doc|file|text|draft|list|entry|field)\b/i.test(rest)) return true;
    if (words(rest).map(stem).some((w) => named.has(w))) return true;
  }
  return false;
}

/** a Send button only when the goal asks to send something to someone */
export function sendForbidden(label: string, goal: string): string | null {
  return /^send\b/i.test(label.trim()) && !sendIntent(goal) ? "the goal does not ask to send anything" : null;
}

/** roles where a click opens, selects or focuses (a row, a field, a tab): their label is content, not a command */
const NOT_A_COMMAND = new Set(["AXTextField", "AXTextArea", "AXSearchField", "AXComboBox", "AXCell", "AXRow", "AXOutlineRow", "AXStaticText", "AXHeading", "AXImage", "AXTab", "AXRadioButton", "AXDisclosureTriangle", "AXSlider", "AXIncrementor", "AXScrollBar"]);
/** roles that are commands whatever their label's length (a link or a web element with a long label is a title) */
const COMMAND = new Set(["AXButton", "AXMenuItem", "AXMenuButton", "AXPopUpButton"]);
const DIALOG = new Set(["AXSheet", "AXDialog", "AXSystemDialog", "AXAlert"]);
/** a dialog's "do it" button: it does what the dialog asks ("Delete 3 items?" ... "OK") */
const AFFIRM = /^(ok|okay|yes|continue|proceed|done|i[’']?m sure|sure)\b/i;

/** elements below `root`, by walking down from it */
function inside(els: AxElement[], root: AxElement): AxElement[] {
  const kids = new Map<number, AxElement[]>();
  for (const e of els) if (e.parent !== undefined) (kids.get(e.parent) ?? kids.set(e.parent, []).get(e.parent)!).push(e);
  const out: AxElement[] = [];
  for (let todo = [...(kids.get(root.index) ?? [])]; todo.length; ) {
    const e = todo.pop()!;
    out.push(e);
    todo.push(...(kids.get(e.index) ?? []));
  }
  return out;
}
function ancestors(els: AxElement[], e: AxElement): AxElement[] {
  const byIndex = new Map(els.map((x) => [x.index, x]));
  const out: AxElement[] = [];
  for (let p = e.parent, n = 0; p !== undefined && n < 64; n++) {
    const a = byIndex.get(p);
    if (!a) break;
    out.push(a);
    p = a.parent;
  }
  return out;
}
const textOf = (els: AxElement[]) => els.filter((e) => e.role === "AXStaticText" || e.role === "AXHeading").map((e) => `${e.label ?? ""} ${e.value ?? ""}`).join(" ");

/**
 * The rule for EVERY click an agent makes: the Send rule and the irreversible rule on the control's label, and a
 * dialog's OK / Yes carries the dialog's own action ("Delete 3 items?"). `els` (the window read) finds the dialog.
 */
export function clickBlocked(target: { role: string; label: string; token?: string }, goal: string, els: AxElement[] = []): string | null {
  const label = target.label.trim();
  if (NOT_A_COMMAND.has(target.role)) return null;
  // a link or a web element with a long label is a page title ("How to delete your account"), not a command
  if (!COMMAND.has(target.role) && words(label).length > 6) return null;
  const why = sendForbidden(label, goal) ?? clickForbidden(label, goal);
  if (why) return why;
  const el = target.token ? els.find((e) => e.token === target.token) : undefined;
  if (el && AFFIRM.test(label)) {
    const dialog = ancestors(els, el).find((a) => DIALOG.has(a.role));
    for (const hit of dialog ? riskyIn(textOf(inside(els, dialog))) : []) {
      const r = clickForbidden(hit.phrase, goal);
      if (r) return `'${label}' confirms a dialog that would ${hit.phrase.toLowerCase()}, and the goal does not ask for that`;
    }
  }
  return null;
}

/**
 * Return / AXConfirm presses whatever is the default: a sheet's or dialog's default button ("Delete", "Replace",
 * "Pay"), or a web form's submit. The default button isn't exposed, so ANY button there that the agent may not click
 * blocks Enter. `fieldToken` is the field Enter goes to, if known.
 */
export function enterForbidden(els: AxElement[], fieldToken: string | undefined, goal: string): string | null {
  const firstBlocked = (scope: AxElement[]) => {
    for (const b of scope) {
      if (!b.token || !COMMAND.has(b.role) || !(b.label ?? "").trim()) continue;
      const why = clickBlocked({ role: b.role, label: b.label!, token: b.token }, goal, els);
      if (why) return why;
    }
    return null;
  };
  for (const d of els.filter((e) => DIALOG.has(e.role))) {
    const why = firstBlocked(inside(els, d));
    if (why) return `a dialog is open and Enter could press its button: ${why}`;
  }
  const field = fieldToken ? els.find((e) => e.token === fieldToken) : undefined;
  if (!field) return null;
  const up = ancestors(els, field);
  const web = up.findIndex((a) => a.role === "AXWebArea");
  if (web < 0) return null;
  // the form: the nearest container of the field (up to the page) that has buttons
  for (const a of up.slice(0, web + 1)) {
    const scope = inside(els, a).filter((e) => COMMAND.has(e.role) && e.token);
    if (!scope.length) continue;
    const why = firstBlocked(scope);
    return why ? `Enter would submit this web form: ${why}` : null;
  }
  return null;
}
