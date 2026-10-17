// Plan compilers: turn common goals into exact steps IN CODE (no LLM, no cost, no latency).
// "Code computes facts; the classifier only chooses" (the awlevin principle). Anything not covered returns null,
// and the agent falls back to a cached plan, then (optionally) to an LLM planner, then to jev on its own.
import type { Item, PlanStep } from "./contracts.ts";

// ---------- shared text helpers ----------

/** "titled 'Groceries' with milk, eggs and bread" -> "Groceries\n• milk\n• eggs\n• bread" (no LLM needed) */
export function titledList(goal: string): string | null {
  const m = goal.match(/\b(?:titled|called|named|headed)\s*["“'‘]([^"”'’]+)["”'’]\s*(?:with|containing|listing|that lists|including)\s+(?:the\s+(?:items?|things?)\s+)?(.+?)\s*\.?$/i);
  if (!m) return null;
  const items = m[2]!.split(/,\s*(?:and\s+)?|\s+and\s+/).map((s) => s.trim()).filter(Boolean);
  if (!items.length || items.some((s) => s.split(/\s+/).length > 8)) return null; // a description, not a list: leave it
  return `${m[1]!.trim()}\n${items.map((s) => `• ${s}`).join("\n")}`;
}

/**
 * What mergeSameApp writes between one app's clauses ("compute 6x7 Then: tell me the answer"), so one agent does them in
 * turn. Capital T and a single space each side. The text a goal hands over for typing ends here (the next clause is the
 * goal again); a lowercase "then:", or a line that merely starts with "Then:", is still part of the text.
 */
export const CLAUSE_JOIN = " Then: ";

/** a marker that hands over the exact text, WITH its colon: what comes after it is the text */
const MARKERS = /\b(?:that says|which says|saying|with the text|the words|exactly)\s*:/gi;

/**
 * An instruction clause that sometimes trails the text a goal hands over: "The year is 1911. and tell me that it was
 * created." It starts after the text's LAST sentence break (a full stop, ! or ?, and a closing quote if there is one),
 * runs to the end, and opens with a lowercase "and tell me", "and then tell me" or "then tell me": the forms that carry
 * on from the sentence before, which is how an instruction gets appended. Group 1 is the text up to and including the
 * break. It is case-sensitive on purpose, because the text can be a message: a sentence that starts "Tell me …" or
 * "And tell me …" is the message's own ("Running late. Tell me where you are."), as is a bare lowercase "tell me", and
 * so is a "tell me" with no sentence break before it ("please tell me when you're home", "hello, and tell me").
 */
const TRAILING_ASK = /^([\s\S]*[.!?]["”’']?)\s+(?:and\s+then|and|then)\s+tell\s+me\b[\s\S]*$/;

/**
 * The texts that markers with a colon hand over, as ranges of the goal: from just after the colon to the next
 * CLAUSE_JOIN or the end, less a trailing instruction clause (TRAILING_ASK: the agent was typing "… and tell me that the
 * document was created." into the document). explicitText types the first one, and unquoted() hides them all from the
 * checks that read the goal for orders, so a trailing instruction counts as the goal's own words. Both take their ranges
 * from here, so what is typed and what is not read as an order end together.
 */
function markedTexts(goal: string): { start: number; end: number }[] {
  const texts: { start: number; end: number }[] = [];
  let resume = 0; // where the last text ended
  for (const m of goal.matchAll(MARKERS)) {
    if (m.index! < resume) continue; // a marker inside a text that is already taken
    const start = m.index! + m[0].length;
    const join = goal.indexOf(CLAUSE_JOIN, start);
    const clauseEnd = join < 0 ? goal.length : join;
    const ask = goal.slice(start, clauseEnd).match(TRAILING_ASK);
    resume = ask ? start + ask[1]!.length : clauseEnd;
    texts.push({ start, end: resume });
  }
  return texts;
}

/** the older marker, with no colon ("saying hello"); a space (or more) must follow it */
const PLAIN_MARKERS = /\b(?:saying|that says|which says|with the text|the words)\s*:?(?=\s)/gi;
/**
 * a single-quoted span: the quotes sit at word boundaries (the opening one after the start, a space, a colon, a bracket
 * or a comma; the closing one before the end, a space or punctuation), so an apostrophe inside a word ("I'll", "Mum's")
 * is never one, and the span itself may hold apostrophes. It can't hold another opening quote: 'a' and then 'bc' is
 * two spans, not one long one.
 */
const SINGLE_QUOTED = /(?<=^|[\s:(,])['‘]((?:(?!(?<=[\s:(,])['‘])[\s\S]){2,}?)['’](?=$|[\s,.!?:;)])/;

/** one pair of quotes around the WHOLE text only marks where it starts and ends ("hi" -> hi); "a" and "b" is two spans, left as is */
function unquoteWhole(text: string): string {
  const inner = text.slice(1, -1);
  if (text.length > 2 && /^["“]/.test(text) && /["”]$/.test(text) && !/["“”]/.test(inner)) return inner.trim();
  if (text.length > 2 && /^['‘]/.test(text) && /['’]$/.test(text) && !/['’](?=$|[\s,.!?:;)])|(?<=^|[\s:(,])['‘]/.test(inner)) return inner.trim();
  return text;
}

/**
 * The text a goal gives to type. Oni now writes the goal itself, so the order goes from most to least exact:
 * a titled list; text after a marker with a colon ("create a note that says: I'll call Mum's phone": everything after
 * the colon, exactly, apostrophes, quotes and line breaks included); a double-quoted span; a single-quoted span (only
 * at word boundaries: counting every ' as a quote returned "ll call Mum" for that goal); and last the older marker
 * without a colon ("saying hello"). Both marker forms end at the next CLAUSE_JOIN, so in a merged goal ("create a note
 * that says: hi Then: delete the draft") only the clause's own text is typed: "hi".
 */
export function explicitText(goal: string): string | null {
  const listed = titledList(goal);
  if (listed) return listed;
  const first = markedTexts(goal)[0];
  const marked = first ? goal.slice(first.start, first.end).trim() : "";
  if (marked) return unquoteWhole(marked);
  const double = goal.match(/["“]([^"”]+)["”]/)?.[1]!.trim();
  if (double) return double;
  const single = goal.match(SINGLE_QUOTED)?.[1]!.trim();
  if (single) return single;
  // the older marker: the text runs to the end of its clause, a full stop, or "in TextEdit" / "in Notes"
  for (const m of goal.matchAll(PLAIN_MARKERS)) {
    const from = m.index! + m[0].length;
    const join = goal.indexOf(CLAUSE_JOIN, from);
    const text = goal.slice(from, join < 0 ? undefined : join).match(/^\s+(.+?)\s*(?:\.$|$|\bin (?:textedit|notes)\b)/i)?.[1]!.trim();
    if (text) return text;
  }
  return null;
}

/**
 * Places and apps a goal goes TO, which are never who to reach: sections of an app ("go to Direct Messages", "the Inbox",
 * "Settings"), the apps and sites themselves ("go to Instagram"), and addresses. Live, "Direct Messages" was taken for
 * the person to message, and no conversation on screen was ever "with" it, so the message was never sent. A name made
 * only of such words is not a person (singular or plural, any case); "Rishabh Jain" is.
 */
const NOT_A_PERSON = new RegExp(`^(?:(?:the|app|page|tab|section|screen|site|website|${[
  "direct messages?", "messages?", "dms?", "inbox(?:es)?", "chats?", "requests?", "notifications?", "home", "search", "settings?", "explore", "feeds?", "channels?", "contacts?", "people", "persons?", "friends?", "groups?", // places in an app
  "instagram", "whatsapp", "messenger", "facebook", "twitter", "linkedin", "discord", "slack", "telegram", "signal", "gmail", "mail", "imessage", "snapchat", "wechat", "skype", "viber", "tiktok", "reddit", "youtube", "x", // apps and sites
].join("|")})(?:['’]s)?(?:\\s+|$))+$`, "i");
const URL_LIKE = /:\/\/|\/|^www\.|\b[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.(?:com|net|org|io|co|app|edu|gov|ai|me|tv|dev|gg|ly|us|uk|hk|cn|jp|de|fr|info|biz|xyz)\b/iu;

/**
 * What a goal says when it sends something to a person, in the two orders Oni writes it, so the person is a target too:
 * the thing, then "to" ("send a message to Rishabh", "send a quick text to Mum", "send it to Mum", "write a message to
 * Sam", "drop a line to Sam") and the person, then the thing ("send Rishabh Jain a message", "write Mum a message",
 * "drop Mum a line"). Without a target the check that the open conversation is the right one never runs, and the message
 * goes to whichever chat happens to be open. "write a note to Mum" is left out on purpose: that is a note in the Notes
 * app, where the guard would only get in the way and the search for "Mum" could open an unrelated note.
 */
const SENT_DET = "(?:an?|the|my|this|that)";
const SENT_KIND = "(?:(?:quick|short|brief|new|nice|friendly|polite|simple|follow-?up|private|direct|text|chat|instant)\\s+)*"; // "a quick text message"
const SENT_NOUN = "(?:message|text|dm|note|line|reply|msg)";
const SEND_TO = new RegExp(
  `\\b(?:(?:send|drop)\\s+${SENT_DET}\\s+${SENT_KIND}${SENT_NOUN}|send\\s+(?:it|this|that|them)|write\\s+${SENT_DET}\\s+${SENT_KIND}(?:message|text|dm|msg))` +
  `\\s+to\\s+(?:the\\s+)?(?:(?:chat|conversation|thread|group)\\s+(?:with\\s+|called\\s+|named\\s+)?)?["“'‘]?$`, "i");
/** "send", "write" or "drop" right before the person; SENT_AFTER is what must follow the name for it to be one ("a message") */
const SEND_VERB = /\b(?:send|write|drop)\s+["“'‘]?$/i;
const SENT_AFTER = new RegExp(`^["”’']?\\s+${SENT_DET}\\s+${SENT_KIND}${SENT_NOUN}\\b`, "i");
/**
 * A conversation picked by the person's name, with the noun AFTER it ("click directly on the 'Rishabh Jain' conversation",
 * "tap the Mum chat"). PICK_VERB is what must come right before the name, CONVERSATION_AFTER what must follow it: with no
 * noun, "click Sign In" is a button, not a person.
 */
const PICK_VERB = /\b(?:click|tap|choose|pick|open|select)\s+(?:(?:directly|just|simply)\s+)?(?:on\s+)?(?:the\s+)?["“'‘]?$/i;
const CONVERSATION_AFTER = /^["”’']?\s+(?:conversation|chat|thread)\b/i;
/**
 * The verbs that take the person straight after them. Capitalised at the start of a sentence ("Message Sohan hi", "Call
 * Mum", "Send Rishabh Jain a message"), the verb and the name are one capitalised run, so the verb is taken off it.
 * "email" is left out on purpose: a compose window has no conversation to check, so the check would only block its body.
 * "open", "select" and "go to" are left out too: "Open Calculator" would make the app a person to reach.
 */
const PERSON_VERB = /^(?:send|write|drop|message|text|dm|call|ring|answer)\s+(?=\S)/i;

/** the concrete values a goal gives: quoted text, names (capitalised words that aren't the first word or the app it
 *  is told to use), and the TARGETS among them: what a verb of reaching asks to get to ("message Sohan", "reply to
 *  Sohan's text", "open the chat with Mum", "click on the conversation with Rishabh Jain", "click on the 'Rishabh Jain'
 *  conversation", "send a message to Sohan", "send Sohan a message", "send it to Mum", and the same with a capital verb
 *  that opens a sentence: "Message Sohan hi"), never a place or an app ("go to Direct Messages", "go to Instagram") or an
 *  address, and never a name inside the text the goal hands over to type ("… that says: call Mum"). "Open WhatsApp,
 *  message Sohan "hi"" -> quoted ["hi"], names ["Sohan"], targets ["Sohan"]. */
export function goalValues(goal: string): { quoted: string[]; names: string[]; targets: string[] } {
  const QUOTE = /["“]([^"”]{1,300})["”]|(?<=^|[\s:(,])['‘]([^'’]{2,300})['’](?=$|[\s,.!?:;)])/g;
  const quoted = [...goal.matchAll(QUOTE)].map((q) => (q[1] ?? q[2])!.trim()).filter(Boolean);
  // a clause join is a sentence break: left in, its capital "Then" joins the name before it ("message Sohan Then: …" gave
  // the name "Sohan Then", which no conversation is ever headed with)
  const rest = goal.replace(QUOTE, " , ").split(CLAUSE_JOIN).join(" . ");
  const names: string[] = [];
  for (const m of rest.matchAll(/\b([A-Z][\p{L}\p{N}'’&-]*(?:\s+[A-Z][\p{L}\p{N}'’&-]*){0,2})/gu)) {
    const before = rest.slice(0, m.index).trimEnd();
    let run = m[1]!;
    if (!before || /[.!?:;]$/.test(before)) {
      // the first word of a sentence is capitalised whatever it is, so a sentence that opens with the verb ("Send Rishabh
      // Jain a message", "Call Mum") has the verb and the name in ONE capitalised run: drop the verb, keep the name
      run = run.replace(PERSON_VERB, "");
      if (run === m[1]) continue;
    } else if (/\b(open|in|on|using|via|launch|start|use)$/i.test(before)) continue; // the app to use ("open WhatsApp", "in Discord")
    const n = run.replace(/[’']s$/, "");
    if (!names.includes(n) && !quoted.some((q) => q.toLowerCase() === n.toLowerCase())) names.push(n);
  }
  const REACH = /\b(?:message|text|dm|email|call|ring|reply(?:ing)? to|respond(?:ing)? to|answer|chat with|write to|talk to|open|go to|switch to|select|join)\s+(?:the\s+)?(?:(?:chat|conversation|thread|group)\s+(?:with\s+|called\s+|named\s+)?)?(?:(?:last|latest|newest|most recent)\s+)?(?:(?:message|text)\s+from\s+)?["“'‘]?$/i;
  // clicking a CONVERSATION reaches its person too ("click on the conversation with Rishabh Jain"); a bare "click X" does
  // not (X is a button's label)
  const REACH_CLICK = /\b(?:click|tap|choose|pick)(?:\s+on)?\s+(?:the\s+)?(?:chat|conversation|thread|group|dm)\s+(?:with\s+|called\s+|named\s+)["“'‘]?$/i;
  // phone numbers are names too ("message +852 9123 4567")
  for (const m of rest.matchAll(/\+?\d[\d ()-]{6,}\d/g)) if (!names.includes(m[0].trim())) names.push(m[0].trim());
  // every place a value appears is looked at, not just the first: it may first show up in the text the goal hands over to
  // type ("… that says: call Mum Then: open the chat with Mum"), which never counts, and a later mention is the target
  const typed = markedTexts(goal);
  const targets = [...quoted, ...names].filter((v) => {
    for (let at = goal.indexOf(v); at >= 0; at = goal.indexOf(v, at + 1)) {
      if (at === 0 || typed.some((t) => at >= t.start && at < t.end)) continue;
      if (/[\p{L}\p{N}]/u.test(goal[at + v.length] ?? "")) continue; // inside a longer word ("Sam" in "Samuel")
      const before = goal.slice(0, at);
      const after = goal.slice(at + v.length);
      if (REACH.test(before) || REACH_CLICK.test(before) || SEND_TO.test(before)) return true;
      if ((SEND_VERB.test(before) && SENT_AFTER.test(after)) || (PICK_VERB.test(before) && CONVERSATION_AFTER.test(after))) return true;
    }
    return false;
  }).filter((v) => !URL_LIKE.test(v) && !NOT_A_PERSON.test(v.trim()));
  return { quoted, names, targets };
}

/** a field for what to SAY (a message, a reply), and a field for WHO or WHAT to find (search, recipient, name) */
export const MESSAGE_FIELD = /\b(message|compose|reply|imessage|write a|type a|say something|chat)\b/i;
export const FIND_FIELD = /\b(search|find|name|number|username|recipient|to:|contact)\b/i;
/** fields whose old contents may be replaced: what to look for, not what the user wrote (search boxes, address bars) */
export const SEARCH_FIELD = /\b(search|find|filter|address|url|location|go to)\b/i;

const QUOTED = /["“][^"”]*["”]|(?<=^|[\s:(,])['‘][^'’]*['’](?=$|[\s,.!?:;)])/g;
/**
 * The goal without the text it only hands over to WRITE: what every check of "does the goal ask for this action" reads.
 * Quoted text is what to write, not what to do ("write 'tell Sam to delete it'" asks to send and delete nothing), and so
 * is the text after a marker with a colon ("create a note that says: remember to delete old files": typed, not ordered),
 * up to the next CLAUSE_JOIN (the next clause is the goal again) or the end. The text ends where explicitText's does.
 * Blanking too much only makes the guards refuse more, never allow more, so a lowercase "then:" or a line starting with
 * "Then:" inside the text is not a clause boundary.
 */
export function unquoted(goal: string): string {
  let out = "";
  let from = 0; // where the text that is kept starts again
  for (const { start, end } of markedTexts(goal)) {
    out += `${goal.slice(from, start)} , `;
    from = end;
  }
  return (out + goal.slice(from)).replace(QUOTED, " , ");
}

const NEGATION = /\b(?:don[’']?t|do not|does not|doesn[’']?t|never|not|without|no|nothing|none|avoid|stop|won[’']?t|shouldn[’']?t|mustn[’']?t|cannot|can[’']?t)\b/i;
/** a verb at `at` is negated by a "don't / never / without ..." earlier in its own clause ("do not delete anything") */
export function negatedAt(text: string, at: number): boolean {
  const clause = text.slice(0, at).split(/[,.;:!?]|\b(?:and|but|then|also|so|or)\b/i).pop() ?? "";
  return NEGATION.test(clause.trim().split(/\s+/).slice(-6).join(" "));
}
/** where a negation starts after `from` (-1: none): the scope of a verb ends there ("delete the draft but not the note") */
export const negationAfter = (text: string, from: number) => {
  const i = text.slice(from).search(NEGATION);
  return i < 0 ? -1 : from + i;
};

/** a word before a verb that makes it a noun or a report, not an order: "the reply", "my messages", "Sam will reply" */
const NOT_AN_ORDER = /^(the|a|an|my|your|his|her|their|our|its|this|that|last|latest|newest|recent|new|unread|first|previous|any|each|every|which|what|will|would|did|does|has|have|had|was|is|if|whether|until|i|he|she|they|we|it|someone)$/;
/** words after "tell / ask / message" that are not someone else to send to ("tell me the year", "ask for directions") */
const NOT_SOMEONE = /^(me|us|you|i|myself|ourselves|yourself|it|this|that|these|those|what|how|when|where|why|which|who|whom|whether|if|about|for|a|an|some|any|more|again|all|everything|nothing|so|to|in|on|at|from|with|by|up|out|back|yes|no|hi|hello|is|was|field|box|app|inbox|thread|history|address|preview|notifications?)$/;
/** a person or group to send to, also after "the / my" ("tell my mum", "message the team") */
const PEOPLE = /^(him|her|them|everyone|everybody|team|group|chat|channel|family|class|friends?|boss|manager|mum|mom|mother|dad|father|parents|wife|husband|partner|sister|brother|son|daughter|girlfriend|boyfriend|teacher|professor|tutor|landlord|doctor|roommates?|flatmates?|colleagues?|coworkers?|client|customer|others)$/;

/**
 * The goal asks to SEND something to someone: only then may a message field be filled and Enter / Send pressed in it.
 * "tell me ...", "say ...", "answer the question" are not sending (the README's "... and tell me the year it was
 * founded"); "message Mohit hi", "reply to Sam ...", "send X to Y", "tell Sam I'm late", "say hi to Mum" are.
 * A recipient is a Name, a number or @handle, or a person word ("my mum", "the team"); unclear means no (fails closed).
 */
export function sendIntent(goal: string): boolean {
  const g = unquoted(goal);
  const toks = [...g.matchAll(/[\p{L}\p{N}@+’']+/gu)].map((m) => ({ w: m[0].toLowerCase().replace(/[’']s$/, ""), raw: m[0], at: m.index! }));
  const someone = (k: number): boolean => {
    const t = toks[k];
    if (!t) return false;
    if (/^(the|my|our|his|her|their|your)$/.test(t.w)) return PEOPLE.test(toks[k + 1]?.w ?? "");
    if (NOT_SOMEONE.test(t.w)) return false;
    return PEOPLE.test(t.w) || /^[+@\d]/.test(t.raw) || /^\p{Lu}/u.test(t.raw);
  };
  // the next few words of the same clause (no punctuation crossed)
  const ahead = (k: number, n: number) => toks.slice(k + 1, k + 1 + n).filter((t) => !/[,.;:!?]/.test(g.slice(toks[k]!.at, t.at)));
  const toSomeone = (k: number, n: number) => ahead(k, n).some((x) => x.w === "to" && someone(toks.indexOf(x) + 1));
  return toks.some((t, k) => {
    if (negatedAt(g, t.at) || NOT_AN_ORDER.test(toks[k - 1]?.w ?? "")) return false;
    // "wait for Sam to reply": a report about someone else
    if (toks[k - 1]?.w === "to" && toks.slice(Math.max(0, k - 4), k - 1).some((x) => x.w === "for")) return false;
    switch (t.w) {
      case "send": case "reply": case "respond": case "post": case "dm":
        return true;
      case "message": case "text": case "email": case "ping":
      case "tell": case "ask": case "remind": case "inform": case "answer":
        return someone(k + 1);
      case "let": // "let Sam know"
        return someone(k + 1) && ahead(k, 4).some((x) => x.w === "know");
      case "say": case "write": case "forward": // "say hi to Mum", "write to Sam", "forward it to Sam"
        return toSomeone(k, 6);
    }
    return false;
  });
}


export const asksQuestion = (goal: string): boolean =>
  mustCompute(goal) ||
  /\b(tell me|what|when|which|who|where|how (many|much|long|tall|old|far)|find out|look up|compute|calculate|work out|report)\b/i.test(goal) ||
  /\bcheck\b(?!\s+(?:the\s+|a\s+|that\s+)?(?:check)?box)/i.test(goal) || // "check the weather in Tokyo", "check Sony's stock price"
  /\bfind\s+(?:the|a|an|out|how|what|when|who|which)\b(?!.*\b(file|folder|document)s?\b)/i.test(goal);
/** the goal is ONLY to open pages: nothing to answer, play, write or click after opening (then counting tabs is the check) */
export const openOnly = (goal: string): boolean =>
  /\b(open|go to|visit|launch|bring up|pull up)\b/i.test(goal) && !asksQuestion(goal) &&
  !/\b(play|watch|click|press|write|type|search|send|sign|log ?in|download|buy|add|reply|post|fill|book|subscribe|like|scroll|read)\b/i.test(goal);
/** the answer must be produced by doing something (not just read off what was already on screen) */
export const mustCompute = (goal: string) =>
  /\b(compute|calculate|work out|add|plus|subtract|minus|times|multiply|multiplied|divide|divided|sum|total|convert|square|squared)\b/i.test(goal) && /\d/.test(goal);

// ---------- Calculator ----------

const OPS: [RegExp, string][] = [
  [/^(times|x|×|\*|multiplied by)$/i, "Multiply"],
  [/^(plus|\+|add)$/i, "Add"],
  [/^(minus|-|−|subtract)$/i, "Subtract"],
  [/^(divided by|over|÷|\/)$/i, "Divide"],
];

/** "128 times 37", "45 × 12", "1200 / 3", "15% of 2480" -> button presses */
export function calculatorPlan(goal: string, items: Item[]): PlanStep[] | null {
  const labels = new Set(items.map((i) => i.text));
  const clear = labels.has("All Clear") ? "All Clear" : labels.has("Clear") ? "Clear" : null;
  const digitsOf = (n: string): string[] => [...n].map((ch) => (ch === "." ? "Point" : ch));
  const press = (keys: string[]) => keys.map((k) => ({ action: "click" as const, target: k }));
  const g = goal.replace(/,(?=\d{3})/g, "");
  let m = g.match(/(\d+(?:\.\d+)?)\s*(?:%|percent)\s+of\s+(\d+(?:\.\d+)?)/i);
  if (m) {
    // p% of n  =  n × p ÷ 100
    const keys = [...digitsOf(m[2]!), "Multiply", ...digitsOf(m[1]!), "Divide", "1", "0", "0", "Equals"];
    return press([...(clear ? [clear] : []), ...keys]);
  }
  m = g.match(/\bsquare of\s+(\d+(?:\.\d+)?)|(\d+(?:\.\d+)?)\s+squared\b/i);
  if (m) {
    const n = m[1] ?? m[2]!;
    const keys = [...digitsOf(n), "Multiply", ...digitsOf(n), "Equals"];
    if (keys.every((k) => labels.has(k))) return press([...(clear ? [clear] : []), ...keys]);
  }
  const chain = calcChain(g);
  if (!chain) return null;
  // Equals after every operation: the Calculator carries the result into the next one (no reliance on its precedence)
  const keys = [...digitsOf(chain.first), ...chain.rest.flatMap(([op, n]) => [op, ...digitsOf(n), "Equals"])];
  if (keys.some((k) => !labels.has(k))) return null; // the window doesn't show these buttons: don't guess
  return press([...(clear ? [clear] : []), ...keys]);
}

const RANK: Record<string, number> = { Add: 1, Subtract: 1, Multiply: 2, Divide: 2 };

/**
 * "128 times 37", "(17 + 25) times 3", "250 + 175 - 80" -> a first number and [operation, number] pairs, worked left to
 * right. Only where left to right IS the arithmetic: at most one bracketed group, at the start, and never a stronger
 * operation after a weaker one ("2 + 3 x 4" is 14, not 20: left to an LLM instead). Live, "(17 + 25) times 3" compiled
 * to 17 + 25 = and dropped the "times 3"; an LLM call ($0.007) finished it.
 */
export function calcChain(goal: string): { first: string; rest: [string, string][] } | null {
  const g = goal
    .replace(/\bmultiplied by\b|\btimes\b/gi, " × ").replace(/\bdivided by\b|\bover\b/gi, " ÷ ")
    .replace(/\bplus\b/gi, " + ").replace(/\bminus\b/gi, " − ").replace(/(\d)\s*[xX*]\s*(?=[\d(])/g, "$1 × ");
  const run = g.match(/\(?\s*\d[\d.\s()+\-−×÷/]*[\d)]/)?.[0];
  if (!run) return null;
  const tokens = run.match(/\d+(?:\.\d+)?|[()+\-−×÷/]/g) ?? [];
  const opOf = (t: string) => OPS.find(([re]) => re.test(t))?.[1];
  let i = 0;
  // a group (or the whole run): number (op number)*, never a stronger operation after a weaker one
  const seq = (): [string, [string, string][]] | null => {
    const first = tokens[i++];
    if (!first || !/^\d/.test(first)) return null;
    const rest: [string, string][] = [];
    while (i < tokens.length && opOf(tokens[i]!)) {
      const op = opOf(tokens[i]!)!;
      const n = tokens[i + 1];
      if (!n || !/^\d/.test(n)) return null;
      if (rest.length && RANK[op]! > RANK[rest[rest.length - 1]![0]]!) return null;
      rest.push([op, n]);
      i += 2;
    }
    return [first, rest];
  };
  let first: string;
  let rest: [string, string][] = [];
  if (tokens[0] === "(") {
    i = 1;
    const grp = seq();
    if (!grp || tokens[i] !== ")") return null;
    i++;
    [first, rest] = grp;
    const after: [string, string][] = [];
    while (i < tokens.length && opOf(tokens[i]!)) {
      const op = opOf(tokens[i]!)!;
      const n = tokens[i + 1];
      if (!n || !/^\d/.test(n)) return null;
      if (after.length && RANK[op]! > RANK[after[after.length - 1]![0]]!) return null;
      after.push([op, n]);
      i += 2;
    }
    rest = [...rest, ...after];
  } else {
    const all = seq();
    if (!all) return null;
    [first, rest] = all;
  }
  if (i < tokens.length || !rest.length) return null; // brackets elsewhere, or no operation at all
  return { first, rest };
}

// ---------- the web ----------

const APP_WORDS = /\b(?:in|on|using|with|open)\s+(?:a\s+new\s+)?(?:safari|chrome|google chrome|brave|brave browser|the browser|my browser)(?:\s+(?:window|tab))?\b/gi;

/** well-known sites people name instead of typing a URL */
export const KNOWN_SITES: [RegExp, string][] = [
  [/\bclaude\b.*\b(dash\w*|console|api|platform|usage|billing)\b|\b(anthropic)\s+(console|dash\w*)\b/i, "https://platform.claude.com"],
  [/\bclaude\b/i, "https://claude.ai"],
  [/\btype ?safe\b/i, "https://console.typesafe.ai"],
  [/\byoutube\b/i, "https://www.youtube.com"],
  [/\bgmail\b/i, "https://mail.google.com"],
  [/\bgithub\b/i, "https://github.com"],
  [/\bwhatsapp\b/i, "https://web.whatsapp.com"],
  [/\bmoodle\b/i, "https://moodle.hku.hk"],
  [/\bchatgpt\b/i, "https://chatgpt.com"],
  [/\bgoogle (docs?)\b/i, "https://docs.google.com"],
  [/\bgoogle drive\b/i, "https://drive.google.com"],
  [/\bcanvas\b/i, "https://canvas.instructure.com"],
];

/** "open the Claude dashboard and the TypeSafe dashboard (in a new window)" -> the sites' URLs, opened together */
export function openSitesPlan(goal: string): PlanStep[] | null {
  if (!/\b(open|go to|visit|launch|bring up|pull up)\b/i.test(goal)) return null;
  if (/\b(search|look up|find|tell me|play)\b/i.test(goal)) return null;
  const parts = goal.replace(APP_WORDS, " ").split(/,|\band\b|&|\bplus\b/i);
  const urls: string[] = [];
  for (const part of parts) {
    const hit = KNOWN_SITES.find(([re]) => re.test(part));
    if (hit && !urls.includes(hit[1])) urls.push(hit[1]);
  }
  if (!urls.length) return null;
  const newWindow = /\bnew\s+(?:\w+\s+){0,2}window\b/i.test(goal);
  return [{ action: "open_url", text: urls.join(" "), target: newWindow ? "new window" : undefined }];
}

/**
 * The question a goal asks about a page comes after the page's name: ", and then tell me …", " then find …", ". Tell me …".
 * A verb alone isn't enough (a title can hold "Find" or "Let"): it needs an "and" / "then" or a full stop before it.
 */
const ASK_AFTER_NAME = /(?:[\s,;]+(?:and\s+then|and|then)\s+|[.!?]\s+)(?:tell|find|report|give|let\s+me\s+know)\b[\s\S]*$/i;
/** the lead-in of "go to the page for X on Wikipedia": what is left once "on Wikipedia" is cut */
const PAGE_LEAD = /^(?:(?:go\s+to|visit|read)\s+)?(?:the\s+)?(?:page|article|entry)\s+(?:for|on|about|of)\s+/i;

/**
 * The thing to look up on Wikipedia, or "" when the goal names none. "look up X on Wikipedia and tell me …", "go to the
 * Wikipedia page for X and tell me …", "open the Wikipedia article on X", "find the Wikipedia entry about X" and "search
 * Wikipedia for X" all give X, however the goal leads in and whatever it asks afterwards. (Live, "Go to the Wikipedia
 * page for the University of Hong Kong and tell me the year it was founded" searched Wikipedia for that whole sentence.)
 */
export function wikipediaTopic(g: string): string {
  const topic = (s: string): string => {
    const t = s.split(/\s+Then:\s+/i)[0]!.replace(ASK_AFTER_NAME, "").replace(/[\s.,;:!?]+$/, "").trim();
    return (/^["“](.+)["”]$/.exec(t) ?? /^['‘](.+)['’]$/.exec(t))?.[1]!.trim() ?? t; // a quoted title is the title
  };
  // the page is named outright, whatever leads in ("go to", "open", "find" …): X follows "the Wikipedia page for"
  const named = g.match(/\bwikipedia(?:['’]s)?\s+(?:page|article|entry)\s+(?:for|on|about|of)\s+(.+)$/i)?.[1]
    ?? g.match(/\b(?:search|look(?:\s+up)?|find)\s+(?:on\s+|in\s+)?wikipedia\s+(?:for|about)\s+(.+)$/i)?.[1]; // "search Wikipedia for X"
  if (named) return topic(named);
  // "look up X on Wikipedia and tell me …": X is between the lead verb and "on Wikipedia". ("Open Wikipedia and search
  // for X" first drops "Open Wikipedia and", or "Open" would be taken as the lead and "Wikipedia and search for" kept)
  return topic(
    g.replace(/^(?:please\s+)?(?:open|go\s+to|visit)\s+(?:the\s+)?(?:english\s+)?wikipedia(?:\s+(?:site|website|homepage))?\s*(?:,|and\s+then|and|then)\s+/i, "")
      .replace(/^.*?\b(?:look up|search(?: for)?|find|open)\s+/i, "")
      .replace(/\s+(?:on|in|from)\s+(?:the\s+)?(?:english\s+)?wikipedia\b.*$/i, "")
      .replace(PAGE_LEAD, ""),
  );
}

/**
 * Where a site's own section lives, when the goal is about it: "go to instagram.com ... open the direct messages
 * inbox ... send a message" belongs on the inbox, not on the home feed (live, 6 Oct: Oni's Instagram DM goal opened
 * the home page and the agent wandered).
 */
const DEEP_LINKS: [RegExp, RegExp, string][] = [
  [/(?:^|\.)instagram\.com$/i, /\b(dms?|direct\s+messages?|inbox|messages?|chats?)\b/i, "https://www.instagram.com/direct/inbox/"],
];
export function deepLink(url: string, goal: string): string {
  let host = "";
  try { host = new URL(url).hostname; } catch { return url; }
  // an address that already goes somewhere specific is left alone
  try { if (new URL(url).pathname.replace(/\/+$/, "")) return url; } catch { /* keep */ }
  for (const [h, about, to] of DEEP_LINKS) if (h.test(host) && about.test(goal)) return to;
  return url;
}

/** a goal that starts as a search ("search for", "look up"), as opposed to one that merely mentions a search field */
const LEADING_SEARCH = /^(?:please\s+)?(?:look up|search(?: for)?)\b/i;
/**
 * A goal that is about USING a page (click, type, pick, send a message, open a chat): its words are instructions for the
 * agent, never a question for a search engine. (Live, 6 Oct: "... click on the search field ... type Rishabh ... send
 * a message that says: hi" and "... and tell me what the page shows" were each typed into Google whole.)
 */
const PAGE_ACTION = /\b(click|tap|tick|choose|select|press|fill in)\b|\b(send|reply)\b.*\b(message|dm|text)\b|\b(chat|conversation|inbox)\b/i;

/** a URL that already encodes the search: no search box, no pop-up suggestions */
export function webPlan(goal: string): PlanStep[] | null {
  const sites = openSitesPlan(goal);
  if (sites) return sites;
  // "in Brave, search for X": the comma left behind kept the search words from being stripped (live: Google got
  // ", search for the population of Hong Kong Then: tell me the number", and an LLM had to redo the search)
  const g = goal.replace(APP_WORDS, " ").replace(/\s+/g, " ").replace(/^[\s,;:.-]+/, "").trim();
  const site = g.match(/\b(?:open|go to|visit)\s+((?:https?:\/\/)?[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/\S*)?)/i);
  // a site the goal names is opened even when the goal asks a question about it ("go to news.ycombinator.com and tell
  // me the top story"): the answer is read off THAT page. Live, the question sent the whole sentence to Google instead,
  // and the "answer" came from a search engine's AI summary. (A goal that searches the site is a search, below)
  if (site && !/\b(search|look up)\b/i.test(g)) {
    const bare = site[1]!.replace(/[.,;:!?]+$/, "");
    return [{ action: "open_url", text: deepLink(/^https?:\/\//i.test(bare) ? bare : `https://${bare}`, g) }];
  }
  // an address written out anywhere in the goal ("go to the URL https://…", "type https://… and press Enter") is where the
  // task starts; what the goal does on that page is the agent's job. (Not for a goal that begins as a search.)
  const explicit = g.match(/\bhttps?:\/\/[^\s,;)"'<>]+/i)?.[0]?.replace(/[.,;:!?]+$/, "");
  if (explicit && !LEADING_SEARCH.test(g)) return [{ action: "open_url", text: deepLink(explicit, g) }];
  if (/\byoutube\b/i.test(g) && !/\bsearch\b/i.test(g)) return [{ action: "open_url", text: "https://www.youtube.com" }];
  if (!LEADING_SEARCH.test(g) && PAGE_ACTION.test(g)) return null;
  if (!asksQuestion(g) && !/\b(search|find)\b/i.test(g)) return null;
  if (/\bwikipedia\b/i.test(g)) {
    const what = wikipediaTopic(g);
    if (what) return [{ action: "open_url", text: `https://en.wikipedia.org/w/index.php?search=${encodeURIComponent(what)}` }];
  }
  // otherwise a web search with the whole information need: search engines handle natural language well
  // the search is the thing named; a follow-up ("Then: tell me the number") is answered from the results page
  const strip = (x: string) => x.replace(/^(?:please\s+)?(?:look up|search(?: for)?|find(?: out)?|tell me|check)\s+/i, "").replace(/[.?!]+$/, "").trim();
  const head = /^(?:please\s+)?(?:look up|search|find)\b/i.test(g) ? strip(g.split(/\s+Then:\s+/i)[0]!) : "";
  const q = head || strip(g);
  return [{ action: "open_url", text: `https://www.google.com/search?q=${encodeURIComponent(q)}` }];
}

// ---------- writing explicit text ----------

/** "make a word doc", "as a Word document", "save it as docx" */
export const WORD_DOC = /\b(word\s+(doc|docs|document|file)s?|docx|\.doc\b|ms\s+word|microsoft\s+word)\b/i;

export function writePlan(goal: string, items: Item[]): PlanStep[] | null {
  if (WORD_DOC.test(goal)) {
    // write the text (given, or by the writer), then code saves it as a real .docx and opens it in Word
    const field = items.find((i) => i.role === "AXTextArea" && i.state === "empty") ?? items.find((i) => i.role === "AXTextArea");
    return [{ action: "type", target: field?.text, text: explicitText(goal) ?? undefined }, { action: "save_as", text: "docx", target: "Microsoft Word" }];
  }
  // a quoted TITLE is not the whole content ("a note titled 'X' with ..."): don't compile, let the planner handle it
  if (/\b(titled|called|named|headed)\s*["“'‘]/i.test(goal) && !titledList(goal)) return null;
  const text = explicitText(goal);
  if (!text) return null;
  const field = items.find((i) => i.role === "AXTextArea" && i.state === "empty") ?? items.find((i) => i.role === "AXTextArea");
  return [{ action: "type", target: field?.text, text }];
}

// ---------- Reminders ----------

/**
 * "add a reminder called X" -> press Add Reminder (in code), then type X into the new row. Live, left to jev and the LLM
 * planner, it once called the task done before adding anything, then twice planned only "click Add Reminder" and left
 * two blank reminders behind.
 */
export function remindersPlan(goal: string, items: Item[]): PlanStep[] | null {
  const m = goal.match(/\b(?:add|create|make|set|new)\b.*?\breminders?\b\s*(?:called|named|titled|that says|saying|to|:)\s*["“'‘]?(.+?)["”'’]?\s*[.!]?$/i);
  const add = items.find((i) => /^(add reminder|new reminder)$/i.test(i.text.trim()));
  if (!m?.[1]?.trim() || !add) return null;
  return [{ action: "click", target: add.text }, { action: "type", text: m[1].trim() }];
}

// ---------- Finder ----------

const TYPE_FOLDERS: [string, RegExp][] = [
  ["Documents", /\.(pdf|docx?|rtf|pages|odt|md|key|pptx?)$/i],
  ["Images", /\.(png|jpe?g|gif|heic|webp|tiff?|bmp|svg)$/i],
  ["Spreadsheets", /\.(csv|xlsx?|numbers|ods|tsv)$/i],
  ["Text", /\.(txt|log)$/i],
  ["Audio", /\.(mp3|m4a|wav|aac|flac)$/i],
  ["Video", /\.(mp4|mov|m4v|avi|mkv)$/i],
  ["Archives", /\.(zip|rar|7z|tar|gz|dmg)$/i],
  ["Code", /\.(js|ts|py|java|c|cpp|swift|go|rs|html|css|json|sh)$/i],
];

/** "by type" -> the type folders actually needed; "into A, B and C" -> those names */
export function finderPlan(goal: string, files: string[]): PlanStep[] | null {
  if (!/\b(organi[sz]e|sort|tidy|clean up|arrange)\b/i.test(goal)) return null;
  const named = goal.match(/\binto\s+(?:(?:three|four|five|two|\d+)\s+)?folders?\s*(?:called|named|:)?\s*(.+?)\s*$/i) ?? goal.match(/\binto\s+(.+?)\s+folders?\b/i);
  if (named && !/\bby (type|kind|extension)\b/i.test(goal)) {
    const names = named[1]!.replace(/[.]$/, "").split(/,\s*|\s+and\s+/).map((s) => s.replace(/^(?:a|the)\s+/i, "").trim()).filter((s) => s && s.length < 40);
    if (names.length >= 2) return [{ action: "sort_into", text: names.join(", ") }];
  }
  const needed = TYPE_FOLDERS.filter(([, re]) => files.some((f) => re.test(f))).map(([n]) => n);
  if (!needed.length) return null;
  return [{ action: "sort_into", text: needed.join(", ") }];
}

/** pick a compiler by app */
// ---------- apps that open straight to the answer from a link ----------

/** "how long to drive from HKU to the airport" -> Apple Maps with the route already planned (maps:// link) */
export function mapsPlan(goal: string): PlanStep[] | null {
  const g = goal.replace(/\b(?:in|on|using|with)\s+(?:apple\s+)?maps\b/gi, " ").replace(/\s+/g, " ").trim();
  const m = g.match(/\bfrom\s+(.+?)\s+to\s+(.+?)(?:\s+(?:by|on|via)\s+(car|driving|transit|public transport|bus|mtr|train|walking|foot))?(?:[,.?!]|$|\s+and\b)/i)
    ?? g.match(/\b(?:directions|route|way|drive|walk)\s+to\s+(.+?)(?:[,.?!]|$|\s+and\b)/i);
  if (!m) return null;
  const [from, to] = m.length >= 3 && m[2] ? [m[1]!, m[2]!] : ["", m[1]!];
  const how = /\b(transit|public transport|bus|mtr|train)\b/i.test(g) ? "r" : /\b(walk|walking|on foot)\b/i.test(g) ? "w" : "d";
  const clean = (s: string) => s.replace(/^(?:the\s+)/i, "").trim();
  return [{ action: "open_url", text: `maps://?${from ? `saddr=${encodeURIComponent(clean(from))}&` : ""}daddr=${encodeURIComponent(clean(to))}&dirflg=${how}` }];
}

const TICKERS: [RegExp, string][] = [
  [/\bapple\b/i, "AAPL"], [/\bnvidia\b/i, "NVDA"], [/\btesla\b/i, "TSLA"], [/\bmicrosoft\b/i, "MSFT"], [/\b(google|alphabet)\b/i, "GOOGL"],
  [/\bamazon\b/i, "AMZN"], [/\b(meta|facebook)\b/i, "META"], [/\bnetflix\b/i, "NFLX"], [/\btencent\b/i, "0700.HK"], [/\balibaba\b/i, "BABA"],
  [/\bhsbc\b/i, "0005.HK"], [/\bsony\b/i, "SONY"], [/\btoyota\b/i, "TM"], [/\bbitcoin\b/i, "BTC-USD"], [/\b(s&p|s and p)\s*500\b/i, "^GSPC"], [/\bhang seng\b/i, "^HSI"],
];

/** "what's Apple's stock price" -> the Stocks app opened on AAPL (stocks:// link) */
export function stocksPlan(goal: string): PlanStep[] | null {
  const known = TICKERS.find(([re]) => re.test(goal));
  const explicit = (goal.match(/\b[A-Z]{2,5}(?:\.[A-Z]{1,2})?\b/g) ?? []).find((t) => !/^(HKU|USD|HKD|MTR|AI|OK|US|UK|HK|ETA)$/.test(t));
  const symbol = known?.[1] ?? explicit;
  return symbol ? [{ action: "open_url", text: `stocks://?symbol=${encodeURIComponent(symbol)}` }] : null;
}

/** what can follow "in / for / at" or a verb without being a place: a unit, something the app shows, a time, a pronoun */
const NOT_A_PLACE = new RegExp(`^(?:${[
  "celsius", "fahrenheit", "kelvin", "centigrade", "degrees?", "metric", "imperial", // units
  "weather", "forecasts?", "temperatures?", "conditions?", "hourly", "daily", "weekly", "radar", "humidity", "wind", "rain", "snow", "pressure", "visibility", "sunrise", "sunset", "air quality", "uv index", // what the app shows
  "today", "tonight", "tomorrow", "yesterday", "now", "right now", "(?:morning|afternoon|evening|night|day|week|weekend|month|moment)s?(?:\\s.*)?", // times
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday", "january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december",
  "general", "detail", "me", "you", "us", "him", "her", "it", "them", "myself", "a", "an", "the", "this", "that", "my", "our", "your", "his", "their", // not places
].join("|")})$`, "i");
/** "the week", "the next three days", "a while": a determiner and a lowercase word is a noun phrase, not a place ("The Hague" is one) */
const NOUN_PHRASE = /^(?:the|a|an|my|our|your|his|her|their|this|that|these|those|some|any|every|each|no|next|last)\s+[a-z]/;
const isPlace = (s: string): boolean => s !== "" && !NOT_A_PLACE.test(s) && !NOUN_PHRASE.test(s);

/**
 * where a place after "in / for / at" ends: before "and", "then", another preposition or a day word, at a comma, colon,
 * bracket or full stop (not the dot of "St.", "Mt.", "Ft."), or at the end
 */
const PLACE_END = String.raw`(?=\s+(?:and|then|in|for|at|today|tonight|tomorrow|now|right now|this week|this weekend)\b|\s*(?:[,;:?!(]|(?<!\b(?:st|mt|ft))\.)|\s*$)`;
const AFTER_PREPOSITION = new RegExp(String.raw`\b(?:in|for|at)\s+([\p{L}][\p{L} .'’-]*?)${PLACE_END}`, "giu");

/** "check the weather in Hong Kong": a place after "in / for / at", from the first weather word on, the first that is a place */
function placeAfterPreposition(goal: string): string | null {
  const from = goal.search(/\b(?:weather|forecast|temperature)\b/i);
  if (from < 0) return null;
  for (const m of goal.slice(from).matchAll(AFTER_PREPOSITION)) {
    const place = m[1]!.trim();
    if (isPlace(place)) return place;
  }
  return null;
}

/** the verbs that name a place to switch to */
const PLACE_VERBS = /\b(?:search(?:\s+for)?|look\s+up|find|show(?:\s+me)?|switch\s+to|check)\s+/giu;
/** a place's name: capitalised words in a row ("New York City", "St. Louis", "Tokyo's") */
const PLACE_NAME = /^(?:(?:St|Mt|Ft)\.|\p{Lu}[\p{L}'’-]*)(?:\s+(?:(?:St|Mt|Ft)\.|\p{Lu}[\p{L}'’-]*))*/u;

/** "search for Hong Kong and tell me the high": the capitalised words right after the verb (so never "the weather") */
function placeAfterVerb(goal: string): string | null {
  for (const v of goal.matchAll(PLACE_VERBS)) {
    const place = goal.slice(v.index! + v[0].length).match(PLACE_NAME)?.[0].replace(/['’]s$/, "");
    if (place && isPlace(place)) return place;
  }
  return null;
}

/**
 * "check the weather in Hong Kong" -> switch the Weather app to that city (done in code: search, pick the city). The
 * city is read from "weather / forecast / temperature … in | for | at <City>" first, then from the verb that names it:
 * "search (for) <City>", "look up", "find", "show (me)", "switch to", "check". (Live, "search for Tokyo and tell me the
 * current temperature shown" compiled to nothing and jev wandered; "… the high temperature in Celsius" found the city
 * "Celsius", and "weather in Tokyo and tell me the temperature" the city "Tokyo and tell me the temperature".) The city
 * ends before "and", "then", a comma or a full stop, and is never a unit, a time or a generic word.
 */
export function weatherPlan(goal: string): PlanStep[] | null {
  const city = placeAfterPreposition(goal) ?? placeAfterVerb(goal);
  return city ? [{ action: "pick_city", text: city }] : null;
}

/** "check the weather in Tokyo in Weather" -> "check the weather in Tokyo": a trailing "in <this app>" names the app,
 * not the content (live, the Weather plan searched for the city "Tokyo in Weather" and found nothing) */
export function withoutAppSuffix(app: string, goal: string): string {
  const name = app.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+");
  return goal.replace(new RegExp(`[,\\s]+(?:in|on|using|with|via)\\s+(?:the\\s+)?${name}(?:\\s+app)?\\s*([.?!]*)\\s*$`, "i"), "$1");
}

export function compilePlan(app: string, rawGoal: string, items: Item[], files: string[] = []): PlanStep[] | null {
  const goal = withoutAppSuffix(app, rawGoal);
  if (app === "Calculator") return calculatorPlan(goal, items);
  if (app === "Maps") return mapsPlan(goal);
  if (app === "Stocks") return stocksPlan(goal);
  if (app === "Weather") return weatherPlan(goal);
  if (app === "Finder") return finderPlan(goal, files);
  if (["Safari", "Google Chrome", "Brave Browser", "Arc", "Firefox"].includes(app)) return webPlan(goal);
  if (["TextEdit", "Notes"].includes(app)) return writePlan(goal, items);
  if (app === "Reminders") return remindersPlan(goal, items);
  return null;
}
