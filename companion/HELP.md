# 13 Years Producer

Connects Bitfocus Companion to [13 Years Producer](https://13years.app) — a live-production cue and timer system — via its local Control API.

## Setup

1. On the Mac or iPad running the show, open **Settings → Control API** in 13 Years Producer and turn it on. It's off by default. The screen shows the device's LAN address(es) and port (default `13390`) — that's what goes into Companion.
2. In Companion, add this module and fill in **Producer Host / IP** and **Port**, then save.
3. That's it — no API key, no login. The Control API has no authentication at all, so only point this at a device on a trusted production network.

Once connected, this module holds a WebSocket open to the app for as long as the connection lives (`ws://host:port/v1/socket`). The app pushes a full state snapshot the instant that socket opens, then again roughly once a second while a timer is counting down, and again whenever anything else changes (a cue fires, a message arrives, the plan advances). Every action, feedback, and variable here reacts to those pushes — this module never polls the app on a timer. If the socket drops (the Mac sleeps, the iPad gets backgrounded — the Control API doesn't run while the app isn't in the foreground on iPad), it reconnects on its own and the **Connection Lost** feedback lights up in the meantime.

**The role-selection trap:** the app's *currently selected roles* aren't remembered across launches — a fresh launch starts with nothing selected, or with a selection that no longer matches any real role. Firing **Fire Selected Cue** into that state 409s rather than silently doing nothing, and this module logs a clear warning when it happens. Run **Set Selection** first (or use the per-role **Fire Role Cue** action instead, which doesn't depend on selection at all).

## Actions

**Cues**
- **Fire Selected Cue** — send OFF/STANDBY/GO/FLASH_STANDBY/FLASH_GO to every currently-selected role
- **Fire Role Cue** — same, for one specific role, regardless of selection
- **Cycle Role Cue (Standby → Go! → Clear)** — one button, three presses: advances a role through Standby → Go! → Clear → Standby, always reading its *current* live state rather than needing a fixed target. This is what the **Cues — Toggle** presets use.
- **Clear All Cues** — set every role to OFF in one call
- **Set Selection** — choose which roles are "selected" (see the trap above)

**Timer**
- **Timer Start / Pause / Toggle / Reset** — transport controls; Start/Pause are idempotent (sending Start twice doesn't pause)
- **Timer Adjust** — add or subtract N seconds from the active item's remaining time
- **Timer Set Remaining (Seconds)** — set the remaining time to an absolute value
- **Timer Set Remaining (Input)** — set or adjust remaining time using the app's own typed-in grammar: `"4350"` (absolute seconds), `"+30s"`, `"-5m"`, `"1h30m"` — the same parser the app's own time field uses
- **Timer Actual Override** — flip the active item's Projected/Actual display flag (a transient override; doesn't touch the plan item's own saved flag)

**Timer Entry** (the keypad — see the **Timer Entry** presets below)
- **Timer Entry: Append Key** — type a digit, `h`, `m`, `s`, or `:` into the entry buffer. The dropdown also takes custom text, so one button can type a whole fragment like `30s`
- **Timer Entry: Sign (+/−)** — put a `+` or `−` on the front of the buffer, making the entry relative to the current remaining time. Pressing the sign that's already set removes it; the other one replaces it
- **Timer Entry: Backspace** — drop the last character
- **Timer Entry: Clear** — empty the buffer
- **Timer Entry: Enter (Commit)** — send what's typed. The raw text goes to the app, which parses it with the same parser its own time field uses; an empty or half-typed buffer sends nothing. The buffer clears after a press, except when the send itself fails (no plan loaded, no active item) — then what was typed is kept for a second try

**Service Navigation**
- **Plan Next / Previous** — step through the loaded plan
- **Plan Next Service** — load the next service from a Planning Center–synced flow
- **Plan Jump to Item** — jump straight to a specific plan item
- **Plan Add Item** — append a new item (title, type, length, Projected/Actual)
- **Plan Update Item** — edit an existing item; leave a field at its default (empty string / `0`) to leave it unchanged
- **Plan Delete Item**
- **Plan Set Item Duration Actual** — toggle an item's saved Projected/Actual flag
- **Plan Reorder Items** — reorder by a comma-separated list of item IDs (must name every current item exactly once)
- **Plan Import** — parse pasted `Title | Type | Duration` lines into a new plan

**Planning Center**
- **Planning Center Sign In / Sign Out**
- **Planning Center Select Service Type / Refresh Service Types**
- **Planning Center Refresh Plans / Sync** — sync fetches one specific plan (service type + plan id) and replaces the local plan with it
- **Planning Center Set Plan Filter** — Upcoming / Past / No Dates / Undated
- **Planning Center Set Live Sync** — enable/disable PCO Live mirroring

**Messages**
- **Send Message** — to one role or everyone, optionally high priority
- **Clear Messages** — clears the whole history

**Roles**
- **Create Role / Update Role / Delete Role**

**App Navigation**
- **Set UI Mode** — switch the app's own screen (Producer Control / Service Flow / Live Preview / Messages / Settings)

**Plotiphar** (lighting/scenic companion app pairing)
- **Plotiphar Start Pairing / Cancel Pairing / Sync Assignments / Disconnect**

**Network & Settings**
- **Network Ping** — wake/signal a device on the LAN by IP
- **Network Forget Producer** — clear an assigned producer (client mode)
- **Network Set Master** — switch master/client mode
- **Update Settings** — hour-format threshold for how the timer displays past an hour
- **Set Relay** — configure the off-LAN Plotiphar relay (host/enabled only — the relay's session credential is never exposed by this API, by design)

## Feedbacks

- **Role Cue Color** — paints the whole button in whatever color that role's cue is actually showing right now (the same amber/green/dark the app itself uses) — the general-purpose "make this button track that role" feedback
- **Role Cue Is** — true when a specific role is showing a specific cue state; layer this under an action button so it visibly confirms once the cue actually took
- **Timer Running** / **Timer Overtime** — live transport state
- **Timer Under Threshold** — true once the active item's remaining time drops to or below a configurable number of seconds (default 30) — the classic "last 30 seconds turns red"
- **Timer Entry Is Committable** — true once what's typed on the keypad actually parses to something the app can act on; this is what lights the Enter key
- **Timer Entry Sign Is** — true while the buffer carries a specific sign, so the active `+`/`−` key reads as engaged
- **Timer Entry In Progress** — true whenever anything is typed, for the C and Backspace keys
- **Connection Lost** — true whenever the control socket isn't currently open
- **At End Of Plan** — true once the plan has advanced past its last item
- **Planning Center Connected**

## Variables

- `connection_status`, `connected_api_clients` — this module's link to the app
- `app_mode`
- `plan_title`, `plan_item_count`, `plan_item_index`, `plan_is_at_end`
- `active_item_title`, `active_item_type`, `active_item_service_plan_title`
- `active_item_remaining` (the app's own formatted string, e.g. `1:35:00`), `active_item_remaining_seconds`, `active_item_is_overtime`, `active_item_is_running`
- `timer_entry_buffer` — what the Timer Entry keypad has typed so far; `timer_entry_preview` — what the active item would read as if it were committed, in the app's own format. A relative entry previews the amount first and where it lands second (`+00:30` over `= 04:30`), since `04:30` on its own looks the same whether it came from `430` or from `+30s`. Both are blank when nothing is typed, the way the app's popover leaves its preview line blank rather than showing an error
- `next_item_title`, `next_item_type`
- `selected_role_names` — comma-joined
- `last_message_text`, `last_message_sender`, `last_message_is_high_priority`
- `pco_connected`, `pco_user_name`, `pco_live_sync_enabled`
- `network_is_producer_live`, `network_is_lan_connected`
- `role_<slug>_name`, `role_<slug>_state`, `role_<slug>_label`, `role_<slug>_person` — one set per role currently on the show, `<slug>` derived from the role's own name (renamed roles get a fresh slug on the next state push)

## Presets

Drag-in buttons for the buttons a producer actually reaches for mid-service, grouped into categories: **Cues** (selected-role commands, colored to match the app's own amber/green screen), **Cues — Toggle** (one button per role — press to advance Standby → Go! → Clear → Standby; the button's own live color/label *is* what decides what the next press does, so it's a single drag-on button rather than three), **Cues — Per Role** (the full explicit cue-state set per role, for when you want a specific state on one press regardless of what it's currently showing — includes the FLASH_* states, which the toggle button intentionally skips), **Status Displays** (Connection Lost and End of Plan indicators), **Timer Transport**, **Timer Nudges** (±30s/±1m/±5m), **Service Navigation** (prev/next/next-service plus a live item-and-remaining-time status button that turns red under threshold or in overtime), **Planning Center**, **Messages** (a few common quick-sends plus a live last-message display), and **Timer Entry**.

**Timer Entry** is the app's own calculator-style time-entry grid, one button per key. Drop the whole category onto a page in the order its names give — the screen readout above the grid, then the rows:

```
R0    screen (what's typed, over what it would become)
R1    C  h  m  s
R2    7  8  9  −
R3    4  5  6  +
R4    1  2  3  ↵
R5    0  :  ⌫
```

Type a time the way you would in the app — `4350` or `43:50` for 43:50, `2m3s` for 2:03, `1h30m` for 1:30:00 — or lead with `+`/`−` to adjust the running time instead of setting it (`+30s`, `-5m`). The screen previews before you commit: an absolute entry shows what the timer will read, a relative one shows the amount being added or taken off and where that lands. Enter lights green once what's typed is actually valid, Clear and Backspace light amber while there's something to undo, and the active sign key stays lit while the entry is relative — every lit key keeps its face, in dark ink. Enter sends the raw text to the app, which parses it itself, so the pad and the producer's own keyboard always agree about what an entry means.

In the app the Enter key is double-tall and `0` is double-wide; Companion buttons can't span cells, so both are ordinary buttons here, and Backspace (keyboard-only in the app) takes the spare cell. The key faces are pre-rendered in Inter — slashed zero included — to match the app's own screen and the pagers rather than Companion's default font.

Per-role presets regenerate automatically as roles are added, renamed, or removed on the show — no action needed to pick them up.
