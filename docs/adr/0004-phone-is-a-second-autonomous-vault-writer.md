---
status: accepted
---

# The phone is a second, autonomous Vault writer, with the Mac's API key on the device and no app lock

Phase 30 puts a native iPhone app next to the Mac: a Replica of the Vault's
Notes plus an on-device Oni that calls the Claude API directly, so the Vault
works with the Mac off. It inherits ADRs 0001-0003 unchanged — autonomous,
ungated writes, no per-turn cap, `oni: true` protection on update and delete
— so there are now two independent autonomous writers to one Vault, and the
phone is the easier of the two devices to lose.

Three choices carry the security posture of that, each the user's own call
in the scoping session (STEPS.md 164), two of them against the
recommendation:

- **The Mac's Console API key is reused on the phone** (Keychain), not a
  separate phone-only key with its own spend limit (recommended). A lost
  phone means rotating the key the Mac's `.env` also uses, and phone spend
  is not capped separately from the Mac's.
- **No app lock** (no Face ID/passcode gate; recommended: lock on every
  open). The Replica — Master Profile, Relationship Map, Diary and the rest
  of whatever folders are switched on — is readable by anyone holding the
  phone unlocked or knowing its passcode.
- **The bearer token protects `/vault/*` only.** Every other endpoint keeps
  the access it has today (unauthenticated, reachable on the tailnet). This
  is a deliberate limit, not an oversight; Phase 31 (Mac-connected mode) is
  where it must be revisited, since that mode would expose `/chat` and the
  rest to the phone.

**Considered and rejected:** read-only or ask-first writes on the phone (a
different Oni from the Mac's: notes it would have saved unasked never get
saved from the phone); routing the phone's model calls through the Mac (no
key on the device, but on-device Oni would die whenever the Mac is
unreachable, which is the scope that was chosen); a token on every
non-loopback request (better end state, but breaks the PWA and the
Shortcuts until each sends it).

**Consequences:** the stored-injection path is the one to watch. Notes the
Mac's `research_agent` wrote from web content can be read by the phone's Oni,
which has no web/email/shell tools — its blast radius is exactly the Mac
Oni's (edit/delete `oni: true` notes; deletes land in `_trash/`), not
larger. The phone's Oni is bounded by the same identical-failure circuit
breaker the Mac's agents have (STEPS.md 122). If the phone is lost, the
response is: rotate the Anthropic key, regenerate the Vault token, and
update the Mac's `.env`. Revisit the key and lock choices if the Replica
ever holds anything the user would not accept being read on a stolen,
unlocked phone — the per-folder switches are the cheap mitigation.
