---
status: accepted
---

# The phone app drives the Mac's chat API with no token and no approval check

Phase 31 lets the iPhone app talk to the Mac's real Oni through the same
`/chat`, `/resume` and thread endpoints the dashboard uses, including tapping
Approve on confirmation gates. ADR 0004 gave the phone a bearer token for
`/vault/*` only and named this phase as the point to revisit that. It was
revisited in the scoping session (STEPS.md 172) and **left as it is**. Two
choices carry the security posture, both the user's own call and both against
the recommendation:

- **No new authentication on the chat API.** The recommended design was
  "from the Mac itself OR a valid bearer token" on the routes the app uses
  (`/chat`, `/resume`, `/chat/stop`, `/threads*`, `/projects*`, `/history`,
  `/uploads`, `/a2ui/action`), leaving the Shortcuts' `/phone/*` and
  `/automations/*/fire` alone. Declined: the private tailnet stays the trust
  boundary for these routes, exactly as it is for the Shortcuts today.
- **No Face ID or passcode check before Approve.** The recommendation was a
  system authentication prompt before every Approve tap (Decline never
  asks). Declined: the phone's own lock screen is the only protection, which
  is consistent with ADR 0004's no-app-lock choice.

**What this means concretely:** the Mac API's chat, board and memory routes
remain callable by any client that can reach port 8000 — anyone on the same
Wi-Fi (the backend binds `0.0.0.0`) or any device on the tailnet — with no
credential. That exposure already exists for the dashboard routes; Phase 31
does not widen it, but it does mean a phone is now a second place from which
real actions (email, iMessage, file writes and deletes, calendar changes, shell
inline code) can be approved, and a thief with the unlocked phone, or someone
who gets past its passcode, can do that with no further check. Before this
phase the same person could only read and edit Notes.

**Considered and rejected:** a token on every non-local route including the
Shortcuts (best end state, but means editing all four Shortcuts on the phone);
a new "app" channel marker so the supervisor knows the request came from a
phone (no need: D1 treats the app as a second dashboard, so Mac actions mean
the Mac); automatic approval of gates the app cannot render (an unknown gate
kind shows a generic verbatim card instead; an unparseable payload is declined).

**Mitigations that do exist:** every gate still shows the real content
verbatim and nothing is approved by the act of opening the app; an unknown
gate kind or a field a layout has no slot for is shown, never hidden (D4); an
unparseable payload fails closed; the existing per-turn write caps, circuit
breaker and `active_turns` visibility apply unchanged; app-started turns that
keep running after a disconnect (D7) show in the dashboard's in-flight banner.

**Revisit when:** the phone is ever lost, or the Mac is used on a network with
untrusted devices — rotating the Vault token does not help here, because the
chat API has no token to rotate. The cheap fixes, in order, are the declined
options above: Face ID before Approve (a few lines in the gate card), then the
token on the app's routes. Either can be added later without redoing Phase 31.
