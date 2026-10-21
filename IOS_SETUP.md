# Oni for iPhone: setup and on-device checklist

A native SwiftUI app (`ios/Oni`) that holds a copy of the Obsidian Vault on the
phone and runs a small on-device Oni against it. It talks to the Mac only to sync
the Vault and for semantic search. Design and decisions: PLAN.md Phase 30 and
`docs/adr/0004-phone-is-a-second-autonomous-vault-writer.md`.

## What you need

- A Mac with Xcode (the version that supports your iPhone's iOS) and
  [XcodeGen](https://github.com/yonaskolb/XcodeGen) (`brew install xcodegen`).
- An iPhone with Developer Mode on, connected once by cable and trusted.
- A free Apple ID added in Xcode (Settings → Accounts). No paid developer
  program is needed.
- [Tailscale](https://tailscale.com) on the Mac and the phone, so the phone can
  reach the Mac from anywhere over HTTPS.

## One-time Mac setup

```sh
tailscale serve --bg 8000          # publishes https://<mac>.<tailnet>.ts.net/ → localhost:8000
cd ~/Documents/summer26/PA
.venv/bin/python -m assistant.vault_sync   # prints the Vault token (also stored in .vault_token)
```

The token only unlocks `/vault/*`. Treat it like a password: paste it into the
phone, never into chat or a commit.

## Build and install

```sh
cd ios
cp Config/Local.xcconfig.example Config/Local.xcconfig
Scripts/show-team-id.sh            # prints your Personal Team ID; put it in Local.xcconfig
xcodegen generate
xcodebuild -project Oni.xcodeproj -scheme Oni -destination 'id=<DEVICE_UDID>' \
  -derivedDataPath DerivedData -allowProvisioningUpdates build
xcrun devicectl device install app --device <DEVICE_UDID> \
  DerivedData/Build/Products/Debug-iphoneos/Oni.app
```

Find the UDID with `xcrun devicectl list devices`. On first launch, trust the
developer profile on the phone (Settings → General → VPN & Device Management).

**Free signing expires after 7 days.** The app stops opening; rebuild and
reinstall (same bundle ID, so the local Vault copy and chats survive). Edits
made on the phone and not yet synced are the only thing at risk if you delete
the app instead.

## Pairing and the Anthropic key

1. Open the app, enter the Mac's `https://….ts.net` address and the Vault token.
   The first sync pulls the whole Vault.
2. For on-device Oni: Settings → **Oni on this iPhone** → paste an Anthropic API
   key. It is stored in the iPhone Keychain and sent only to `api.anthropic.com`.
   Pick Haiku (default, cheapest) or Sonnet.

The phone uses the same Console key as the Mac and there is no app lock (both
deliberate, ADR 0004). If the phone is lost: rotate the key in the Anthropic
Console, update the Mac's `.env`, and rotate the Vault token with
`.venv/bin/python -m assistant.vault_sync --rotate`.

## One VPN at a time (Hong Kong)

iOS runs one VPN at a time, and Anthropic's API refuses requests from Hong Kong
(HTTP 403). So the phone has two modes:

- **Tailscale on, Mac as exit node:** syncs with the Mac, and the on-device Oni's
  Claude calls leave through the Mac's connection. Needs the Mac awake and online.
  One-time: `tailscale set --advertise-exit-node` on the Mac, approve it in the
  Tailscale admin console (Machines → the Mac → Edit route settings), then pick
  Exit node → the Mac in the phone's Tailscale app.
- **Your own VPN on, Tailscale off:** the on-device Oni works against the phone's
  copy of the Vault; sync resumes the next time Tailscale is on.

A failed chat request never clears the saved key. A 403 or no connection shows an
explanation and a **Retry** button that resends your message, so you can switch
VPN and retry without retyping.

## Cost

Phone chats are billed to that key. Each chat shows an estimated cost, and the
Oni tab shows the running total (estimates from published prices, not an
invoice). The system prompt and tool definitions are cached, so a short chat
costs a fraction of a cent on Haiku. A turn is capped at 25 model calls, and
three identical tool failures in a row stop it. While a turn runs the Oni tab
shows a marker, and the chat shows what Oni is doing with a Stop button.

## Tests

```sh
ios/OniCore/test.sh                # Swift tests, no device or network
ios/OniCore/Scripts/integration_mac.sh # Mac client vs the REAL /chat routes, scripted graph, no API spend
ios/OniCore/Scripts/integration.sh # sync engine vs the real Python router, on a temp copy of the Vault
ios/OniCore/Scripts/smoke.sh       # REAL API, a few cents: Haiku + Sonnet, temp notes only
```

None of these touch the real Vault.

## On-device checklist (Phase 30 is not done until you've run this)

1. Install via Xcode and pair. First sync shows the same note count as the Mac.
2. Folder switches in Settings add and remove folders on the phone.
3. Edit a note in airplane mode, reconnect, see the edit on the Mac.
4. Edit the same note on both sides: a copy appears under Conflicts, and you can
   keep either version.
5. Delete a note on the phone: it appears in Trash (and `_trash/` on the Mac) and
   can be restored. A Mac edit made meanwhile beats the pending delete.
6. Mac off: ask Oni (Oni tab) about a note and it answers from the phone copy.
   Tell it something worth saving: it writes a linked note marked `oni: true`,
   which syncs when the Mac is back.
7. Ask Oni to delete or rewrite one of *your* notes: it refuses.
8. Mac on: Search returns semantic matches. Mac off: it says keyword matches only.

## Mac-connected Oni (Phase 31) — on-device checklist, stages 1-5

Before anything: **quit and relaunch Oni.app on the Mac.** The backend inside it
was started before these changes and has no detached turns, turn-state endpoint
or per-thread history, so the phone would get errors. Tailscale must be on (the
phone talks to the Mac through the same address as the Vault).

1. Oni tab → **Mac** side. The list shows your dashboard's conversations, with
   Projects as folders. Pull to refresh works.
2. New chat (pencil) → ask something that needs a tool ("what's on my calendar
   today?"). The reply streams, the bar shows what Oni is doing, and the thread
   appears in the dashboard (the dashboard's *current* thread does not change).
3. Ask something slow, then **lock the phone**. Unlock: the answer is there, or
   the bar says it is still working. (The Mac keeps going either way.)
4. Press **Stop** during a long turn: it ends and says "Stopped."
5. Ask for something gated ("email me a test message"): a card shows the real
   recipients, subject and body. **Decline** does nothing; asking again and
   **Approve** does it once.
6. Open a dashboard thread on the phone, reply, and see the reply on the dashboard.
7. Turn Tailscale off: the Mac side says it cannot reach your Mac and offers the
   iPhone side; the iPhone side still works.

   Also try approving the same card from the dashboard first, then the phone:
   the phone says it was already answered and sends nothing.

8. Ask Oni for a form ("make me a quick form to log my mood with a 1-10 slider,
   a note box and a Save button"). The card draws in the chat, every input can be
   edited, and **Save** starts a new turn that carries what you typed (it shows
   as a "[UI interaction]" message, the same as on the dashboard). While Oni is
   working or a confirmation is open, the buttons are greyed out.
9. Ask for a tabbed or checklist card, a date/time field, and a picture
   ("show a screenshot of my desktop"). Tabs switch, choices toggle, the date
   picker opens, the image shows. A video or audio player shows a grey note to
   open the chat on the Mac instead.

Not built yet (later stages): photo attach, the kanban board, memory approvals.
Cards made while a turn is running appear when it ends (after the reply).
