# Phone setup — Action Button, Share Sheet, health sync (Phase 21)

Everything the backend needs for Phase 21 is built and tested (`assistant/server.py`'s
`/phone/turn`, `/phone/resume`, `/phone/health-sync`; `phone_agent` wired into the
supervisor). What's left is entirely on-device setup in the iOS Shortcuts app — Apple
gives no way to install or configure a Shortcut remotely, so this part has to be done
by hand, once, on the iPhone itself. This doc is the exact sequence.

## Prerequisites

1. **Tailscale installed and signed in on both the Mac and the iPhone**, same account
   on both (STEPS.md 100). Confirm the Mac's Tailscale hostname or IP from the
   Tailscale app/menu bar — you'll use it below as `<TAILSCALE-HOST>`.
2. **The backend running and reachable** — either via `npm run tauri dev`
   (`dashboard/run-oni-dev.sh`) or the installed `Oni` launcher. Confirm it's
   listening on `0.0.0.0:8000` (STEPS.md 100's `--host 0.0.0.0` change), not just
   `127.0.0.1`.
3. **Sanity check from the phone's own browser** before building any Shortcut: visit
   `http://<TAILSCALE-HOST>:8000/threads` in Safari on the iPhone. You should get a
   real JSON response, not a timeout. If this doesn't work, nothing below will either
   — fix connectivity first (Tailscale on both ends, backend actually bound to
   `0.0.0.0`, no firewall blocking the port).

All three Shortcuts below POST to `http://<TAILSCALE-HOST>:8000` — replace that
placeholder with your actual Tailscale hostname/IP once, and reuse it in all three.

---

## Shortcut 1 — "Ask Oni" (the Action Button trigger)

This is the one you'll assign to the Action Button. Build a new Shortcut named
**Ask Oni** with these actions in order:

1. **Dictate Text** — Language: your default. This is what captures your spoken
   request; it auto-stops on silence, no second press needed.
2. **Text** — content: your dictated text (reference the Dictate Text output). This
   just gives you a named variable to reuse below.
3. **Get Contents of URL**
   - URL: `http://<TAILSCALE-HOST>:8000/phone/turn`
   - Method: `POST`
   - Headers: `Content-Type: application/json`
   - Request Body: JSON, with one field: `message` = the Text from step 2.
     (If you want location context — see PLAN.md Phase 21 — add a `location`
     field too, populated from a `Get Current Location` action placed before this
     step, formatted as an address or "lat,lon" text.)
4. **Get Dictionary from Input** (on the result of step 3) — this parses the JSON
   response so later steps can pull fields out of it by key (`type`, `content`,
   `payload`, `phone_actions`).
5. **If** — condition: dictionary's `type` value **is** `interrupt`
   - **Get Value for "payload" in Dictionary**, then **Get Value for
     "spoken_prompt" in Dictionary** (fall back to just showing the raw payload if
     `spoken_prompt` is missing — this only happens for a gated tool that hasn't
     set one, which today is none of them).
   - **Speak Text**: the spoken_prompt, followed by "Say yes or no."
   - **Dictate Text** — capture the answer.
   - **If** the dictated answer text **contains** "yes" → set a variable
     `Approved` to `true`; **Otherwise** → `Approved` = `false`.
     (Fail-closed, matching every other confirmation gate in this project:
     only a clear "yes" approves; anything else — including silence/unclear
     speech — declines.)
   - **Get Contents of URL**
     - URL: `http://<TAILSCALE-HOST>:8000/phone/resume`
     - Method: `POST`, header `Content-Type: application/json`
     - Body: `{"approved": <Approved variable>}`
   - **Get Dictionary from Input** on this second response, then **Speak Text**
     its `content` value.
6. **Otherwise** (type is `message`):
   - **Speak Text**: the dictionary's `content` value.
   - **If** the dictionary has a `phone_actions` key (Shortcuts: "has any value"
     on `Get Value for "phone_actions"`):
     - **Repeat with Each** item in `phone_actions`:
       - **If** the item's `type` is `open_app` → **Open App**, with its app
         field set to **"Ask Each Time"** and bound to the item's `name` value
         (a real, live-verified trick — Shortcuts' default fixed-picker `Open
         App` field can't take a variable, but "Ask Each Time" turns it into
         one that can).
       - **If** the item's `type` is `open_url` → **Open URLs** using the item's
         `url` value.
       - **If** the item's `type` is `run_shortcut` → **Run Shortcut**, with
         its shortcut field set to "Ask Each Time" and bound to the item's
         `name` value (same trick as `open_app` — UNVERIFIED whether `Run
         Shortcut` actually offers this option; check before assuming it
         does).
7. **End If**

Save. Then: **Settings → Action Button → Shortcut → Ask Oni**. A single press now
runs this whole flow.

**Real status as actually built on the device (2026-07-25/26, STEPS.md
108-112), vs. this section's own target design:** steps 1-4, 6-7 minus the
interrupt branch, and both the `open_app`/`open_url` rows under step 6 are
built and live-verified. **Step 5 (the interrupt/confirmation-gate branch)
is NOT yet built** — a gated request today just auto-declines silently if
it's a text-only gate, or returns an interrupt this Shortcut has no branch
to handle otherwise, so nothing happens. This does NOT block
`run_shortcut_on_phone` specifically anymore: it was explicitly UNGATED at
the user's own request (STEPS.md 112, a deliberate choice — see
`phone_tools.py`'s own module docstring), so the `run_shortcut` row under
step 6 fires immediately like `open_app`/`open_url` do, no gate involved —
still not yet built/tested on the device, but no longer blocked on step 5
to do so.

---

## Shortcut 2 — "Share to Oni" (Share Sheet intake)

New Shortcut named **Share to Oni**, with **Accepts**: Images, URLs, and Text (set
this in the Shortcut's own settings, the ⓘ icon).

1. **If** the Shortcut Input is an image:
   - **Get Contents of URL** → `POST http://<TAILSCALE-HOST>:8000/uploads`,
     Request Body: **Form**, one file field containing the Shortcut Input.
   - **Get Dictionary from Input** on the response (fields: `path`, `mime_type`,
     `kind`, `filename` — this is `/uploads`' existing response shape, unchanged
     by Phase 21).
2. **Ask for Text** — prompt: "What do you want to know about this?" (skippable —
   an empty answer is fine, phone_agent will just describe what it sees).
3. **Get Contents of URL** → `POST http://<TAILSCALE-HOST>:8000/phone/turn`
   - Body: `{"message": <the Ask-for-Text answer>, "attachments": [{"path":
     <path from step 1>, "mime_type": <mime_type>, "kind": <kind>, "filename":
     <filename>}]}` — build the `attachments` array as a Shortcuts Dictionary
     matching those four keys exactly (this mirrors `ChatRequest.attachments`'
     shape, server.py).
   - If the input was a URL or plain text instead of an image, skip step 1
     entirely and just put the shared URL/text directly into `message`.
4. Same **Get Dictionary from Input → If type is interrupt/message → Speak
   Text → handle phone_actions** flow as Shortcut 1's steps 4–7 (you can copy
   those actions over, or factor them into a shared "Handle Oni Reply" Shortcut
   that both call via **Run Shortcut**, to avoid maintaining two copies).

---

## Shortcut 3 — "Sync Health to Oni" (manual, user-triggered)

New Shortcut named **Sync Health to Oni** — run it by hand whenever you want
`phone_agent`'s health answers to reflect current data (there is no automatic/
scheduled sync — PLAN.md Phase 21's deliberate "user-triggered push only" design).

1. **Find Health Samples where** — pick whichever categories you care about
   (e.g. Resting Heart Rate, Steps, Sleep Analysis), a reasonable date range
   (e.g. "today" or "last 24 hours").
2. **Text** — compose a plain-text summary from the found samples (Shortcuts'
   "Combine Text" / magic-variable insertion works fine here — this doesn't need
   to be structured JSON, `phone_agent` just reads it as free text).
3. **Get Contents of URL** → `POST http://<TAILSCALE-HOST>:8000/phone/health-sync`
   - Body: `{"content": <the Text from step 2>}`
4. Optional: **Show Notification** — "Health synced" — so you get confirmation it
   worked.

Run this manually whenever you want a fresh snapshot; ask phone_agent about it
afterward via Shortcut 1 ("what's my resting heart rate").

---

## Shortcut 4 — geofence trigger for a pre-approved automation (Phase 24)

**Register the automation itself FIRST**, in the dashboard's Automations tab
(name, trigger description, target, goal, and which action — `send_imessage` or
`send_email` — it's pre-approved for) — this Shortcut only ever fires an
*already-registered* automation by id; it has no way to create one.

Building this Shortcut is genuinely higher-stakes than the other three: once
armed, it fires with **no confirmation at all**, using whatever content the
model generates in the moment (PLAN.md Phase 24 — a deliberate, explicitly
accepted exception to the confirmation gate). Don't arm the Personal Automation
step (the last part below) until you've fired it manually at least once and
checked the Automations tab's run log.

**Cost, per CLAUDE.md's standing rule that anything unattended needs a
disclosed estimate before it's scheduled:** each firing is one specialist
turn (`mac_control_agent`/`life_admin_agent` on Sonnet 5 — the same model/cost
tier as any normal chat turn), with a short instruction and no tool-calling
loop for a simple messaging goal. Based on this project's own measured
per-call Sonnet 5 costs (STEPS.md 75's Phase 10 trace data, ~$0.01-0.02/call
for a comparable single-specialist call), expect roughly **a cent or two per
firing** — an "arrive"+"leave" pair on a daily commute is on the order of a
few cents a day, well under a dollar a month per automation even used daily.
This is an estimate from existing trace data, not a live Console spend-cap
check specific to this feature — if you register several automations with
frequent triggers, keep an eye on the Automations tab's run log and your
Anthropic Console usage the first few days after arming one.

1. In the **Shortcuts app → Automation tab → \+ → Create Personal Automation**,
   choose **Arrive** or **Leave**, pick the location, and turn off **"Ask Before
   Running"** only once you're confident (see above) — while testing, leave it
   ON so you get a manual confirmation prompt each time, which is a normal iOS
   affordance and NOT the same thing as this project's own confirmation gate.
2. Add action: **Get Contents of URL**
   - URL: `http://<TAILSCALE-HOST>:8000/automations/<AUTOMATION-ID>/fire`
     (copy the id from the Automations tab — there's no name-based lookup).
   - Method: `POST`
3. Optional: **Get Dictionary from Input** on the response, then **Show
   Notification** with the `outcome`/`detail` fields, so you get local
   confirmation of what happened (fired / skipped / error) without having to
   open the dashboard.
4. Save, confirm **"Ask Before Running" is OFF** only when you're ready to let
   it fire unattended, and confirm **"Notify When Run"** is set the way you
   want (iOS shows a brief notification for silent automations by default —
   this is a genuinely useful safety net for a fire-and-forget action).

Check the dashboard's Automations tab afterward — every firing (including a
skip because the automation was disabled, or an error) is logged there with a
timestamp and outcome, since this execution path has no human present to
review anything before it happens.

---

## Verifying it works

Once Shortcut 1 is assigned to the Action Button:

1. Press the Action Button, say something simple ("say exactly: action button test
   ok"), confirm you hear it spoken back.
2. Ask something that should delegate to phone_agent: "open apple.com" — should
   open Safari (or your default browser) to that URL after the spoken reply.
3. Ask something gated but voice-approvable through a different specialist, e.g. a
   Google Calendar event delete, to confirm the Speak/Dictate/`/phone/resume` loop
   works end to end.
4. Run Shortcut 3, then ask Shortcut 1 about your health data to confirm the sync
   round-trips.
5. Share a photo to "Share to Oni" from the Photos app and confirm you get a
   spoken/relevant reply.

This is the remaining, genuinely-can't-be-done-without-you part of Phase 21 (task 5 in
this session's tracked list) — the code side is built and tested against the real
graph; this doc is what's needed to actually exercise it live.
