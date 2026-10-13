# 13 Years Producer

Connects Bitfocus Companion to [13 Years Producer](https://13years.app) — a live-production cue and timer system — via its local Control API.

## Setup

1. On the Mac or iPad running the show, open **Settings → Control API** in 13 Years Producer and turn it on. It's off by default. The screen shows the device's LAN address(es) and port (default `13390`) — that's what goes into Companion.
2. In Companion, add this module and fill in **Producer Host / IP** and **Port**, then save. **Turn countdown buttons red in overtime** (on by default) decides whether the countdown presets go red once an item runs over; presets are rebuilt as soon as you save.
3. That's it — no API key, no login. The Control API has no authentication at all, so only point this at a device on a trusted production network.

Once connected, this module holds a WebSocket open to the app for as long as the connection lives (`ws://host:port/v1/socket`). The app pushes a full state snapshot the instant that socket opens, then again roughly once a second while a timer is counting down, and again whenever anything else changes (a cue fires, a message arrives, the plan advances). Every action, feedback, and variable here reacts to those pushes — this module never polls the app on a timer. If the socket drops (the Mac sleeps, the iPad gets backgrounded — the Control API doesn't run while the app isn't in the foreground on iPad), it reconnects on its own and the **Connection Lost** feedback lights up in the meantime. A keepalive ping runs every 5 seconds; a socket that has gone silent for about 12 seconds (a half-open connection after a sleep, say) is dropped and redialled, and **Connection Stale** lights up if no data has arrived for more than 7.5 seconds while the socket still looks open (keepalive replies do not count: they only prove the socket is open). A connection attempt that is accepted but never completes gives up after 5 seconds, and the connection status says why a connect failed (connection refused, timed out, wrong port). Newer apps also speak a clock-synchronised protocol (v2) that this module negotiates automatically: the app then pushes the timer only when it changes, this module counts the clock down itself against a measured offset to the app's clock, and a small hash check every 10 seconds catches anything missed (one fresh read of the state if it ever disagrees). On such a link the keepalive allowance widens to 25 seconds and **Connection Stale** to 15 seconds of silence, since the app is quiet by design between digests. The app also picks a new random id each time it launches (the _epoch_); when it changes the module drops its clock samples and timer anchor, measures again and reads the state afresh. Clock samples older than 90 seconds are ignored and are cleared after a wake from sleep or a system clock change. Older apps keep working exactly as described above. REST commands time out after 3 seconds, and each command's reply is applied at once instead of waiting for the next push.

**The role-selection trap:** the app's _currently selected roles_ aren't remembered across launches — a fresh launch starts with nothing selected, or with a selection that no longer matches any real role. Firing **Fire Selected Cue** into that state 409s rather than silently doing nothing, and this module logs a clear warning when it happens. Run **Set Selection** first (or use the per-role **Fire Role Cue** action instead, which doesn't depend on selection at all).

## Norms worth knowing

**There is no password.** The Control API has no authentication at all, so anyone who can reach the Producer on the network can fire a cue. Leave the API switched off in the Producer's Settings on untrusted or guest Wi-Fi.

**This module never polls.** It holds one WebSocket open and drives every feedback and variable from the pushes it receives. The only on-demand read is a single `GET /v1/state` when the connection is first primed.

**Toggles are computed here, not there.** The API's setters are absolute — you tell it the value to end up at, not "flip it" — so that a button pressed twice converges instead of fighting another surface. Every toggle action in this module reads the current value from the last snapshot and sends its inverse.

**Roles must be selected before a selected-role cue works.** `selectedRoleIds` isn't persisted across app launches, so on a fresh launch it can match nothing. Use **Set Selection** first; the API answers 409 rather than a silent success, and this module logs that as a warning naming the fix.

## Actions

**Cues**

- **Fire Selected Cue** — send OFF/STANDBY/GO to every currently-selected role
- **Fire Role Cue** — same, for one specific role, regardless of selection
- **Cycle Role Cue (Standby → Go! → Clear)** — one button, three presses: advances a role through Standby → Go! → Clear → Standby, always reading its _current_ live state rather than needing a fixed target. This is what the per-role **Cues — Toggle** presets use.
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

- **Plan Next / Previous** — step through the loaded plan. _Start the timer on arrival_ is on by default; a button saved before the option existed is treated as ticked (an upgrade script writes that in). Unticked, the module sends `startTimer: false`: the plan moves to the item and the clock is held (needs a newer app). _Ignore repeat presses for N ms_ (default 0, off) drops presses that land within that window of the last accepted one, so a double-tap cannot skip an item
- **Go To Next Waypoint** — jump to the next waypoint ahead of the live item (warns when there is none)
- **Rundown: Jump to Row / Previous Page / Next Page** — drive the Rundown presets: the module holds the page, a row press jumps to whatever item that row currently shows
- **Plan Next Service** — load the next service from a Planning Center–synced flow
- **Plan Jump to Item** — jump straight to a specific plan item
- **Plan Add Item** — append a new item (title, type, length, Projected/Actual)
- **Plan Update Item** — edit an existing item; leave a field at its default (empty string / `0`) to leave it unchanged. Pick a _note category_ and type its text to set one note (empty text clears it); the item's other notes are kept
- **Plan Delete Item**
- **Plan Set Item Duration Actual** — toggle an item's saved Projected/Actual flag
- **Plan Reorder Items** — reorder by a comma-separated list of item IDs (must name every current item exactly once)
- **Plan Import** — parse pasted `Title | Type | Duration` lines into a new plan
- **Assign Waypoint To Item / Assign Waypoint To Active Item / Unassign Waypoint** — point a waypoint at an item, or take it off whatever carries it (the waypoint stays in the library)

**Planning Center**

- **Planning Center Sign In / Sign Out**
- **Planning Center Select Service Type / Refresh Service Types** — tick _Clear selection_ on Select to go back to no service type
- **Planning Center Set Default Service Type** — remembers a service type for next time; tick _Clear default_ to forget it
- **Planning Center Refresh Plans / Sync** — sync fetches one specific plan (service type + plan id) and replaces the local plan with it
- **Planning Center Set Plan Filter** — Upcoming / Past / No Dates / Undated
- **Planning Center Set Live Sync** — enable/disable PCO Live mirroring

**Messages**

- **Send Message** — to one role or everyone, optionally high priority, optionally _as_ a role (`senderRoleId`)
- **Clear Messages** — clears the whole history

**Roles**

- **Create Role / Update Role / Delete Role** — Update can also clear the assigned person, and replace the role's assigned note categories (tick _Replace_; none selected clears them)

**Service Schedules**

- **Create Schedule** — title, start time (ISO-8601 such as `2026-10-18T10:00:00-04:00`; without an offset it is read as this machine's local time), lead time in minutes, once/weekly, enabled
- **Bring Schedule Live Now / Bring Next Schedule Live Now / Enable/Disable Schedule / Set Schedule Lead Time / Delete Schedule**

**App Navigation**

- **Set UI Mode** — switch the app's own screen (Pagers / Run Sheet / Live Preview / Messages / Settings)

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
- **Connection Stale** — true while the socket looks open but no data has arrived for more than 7.5 seconds (15 seconds on sync protocol v2)
- **Role Is Selected** — true while a role is one of the app's selected roles
- **Last Action Failed** — true for 10 seconds after an action failed; the reason is in `last_action_error`
- **Rundown Row Is The Live Item** — true when row 1-8 of the current rundown page is the live item
- **At End Of Plan** — true once the plan has advanced past its last item
- **Planning Center Connected**

## Variables

- `connection_status`, `connected_api_clients` — this module's link to the app
- `sync_offset_ms` — the app's clock minus this machine's, in ms; `sync_rtt_ms` — round trip of the best clock sample. Both blank on an app without sync protocol v2
- `app_mode`
- `plan_title`, `plan_item_count`, `plan_item_index`, `plan_is_at_end`
- `active_item_title`, `active_item_type`, `active_item_service_plan_title`
- `active_item_remaining` (formatted like the app's own screen, e.g. `1:35:00`; counted locally from the timer anchor on sync protocol v2, otherwise the pushed string), `active_item_remaining_seconds`, `active_item_is_overtime`, `active_item_is_running`
- `active_item_elapsed`, `active_item_length` (both `m:ss`), `active_item_overtime_text` (`+1:12`, blank when not over), `item_ends_at` (local `HH:MM:SS` the running item reaches zero; blank when paused or over)
- `timer_entry_buffer` — what the Timer Entry keypad has typed so far; `timer_entry_preview` — what the active item would read as if it were committed, in the app's own format. A relative entry previews the amount first and where it lands second (`+00:30` over `= 04:30`), since `04:30` on its own looks the same whether it came from `430` or from `+30s`. Both are blank when nothing is typed, the way the app's popover leaves its preview line blank rather than showing an error
- `next_item_title`, `next_item_type`, `next_item_length`
- `active_item_progress_pct` — elapsed over length, whole percent 0-100
- `projected_end_time` — local `HH:MM` the plan finishes if it runs as planned from here; `service_remaining_total` — live item remaining plus everything after it; `service_over_under` — projected end against the next schedule's start plus the planned total (`+` is over), blank when no schedule exists
- `rundown_row_1_title` … `rundown_row_8_title`, `rundown_row_1_length` … `rundown_row_8_length`, `rundown_page`, `rundown_page_count` — the Rundown presets' rows
- `connection_stale` — `yes` when the link is quiet (more than 7.5 s, or 15 s on sync protocol v2)
- `sync_quality` — `v2 ±<n> ms` (half the best round trip) on a sync protocol v2 link, `legacy` otherwise
- `last_action_error` — why the last action failed; clears after 10 seconds (pair it with the **Last Action Failed** feedback)
- `selected_role_names` — comma-joined
- `last_message_text`, `last_message_sender`, `last_message_is_high_priority`
- `pco_connected`, `pco_user_name`, `pco_live_sync_enabled`
- `network_is_producer_live`, `network_is_lan_connected`
- `role_<slug>_name`, `role_<slug>_state`, `role_<slug>_label`, `role_<slug>_person` — one set per role currently on the show, `<slug>` derived from the role's own name (renamed roles get a fresh slug on the next state push)
- `role_1_name` … `role_16_person` — the same four per role by position (first 16 roles), for buttons authored against "role 3" instead of a name

## Presets

Drag-in buttons for what a producer actually reaches for mid-service, grouped into sections: **Cues** (plus **Cues — Toggle** and **Cues — Per Role**: for every role on the show a cycle button painted in the role's live cue colour, and Standby / Go / Clear buttons that light when they match), **Timer Transport** (start/pause/reset plus ±10s/±30s/±1m/±5m nudges), **Service Navigation** (prev/next/next-service, **Next Item (Hold Clock)**, a live item-and-remaining status button that turns red under threshold or in overtime, and a countdown that goes amber at 60s and red at 30s), **Service Timing** (projected end, time remaining, over/under, next item length, and a progress readout with a bar), **Rundown** (eight rows of the plan with the live one highlighted, plus page up/down), **Timer Entry**, **Waypoints** (including **Go To Next Waypoint**), **Service Schedules**, **Projected / Actual**, **Messages**, **Planning Center**, and **Status Displays** (including a stale-link banner, a **Connection Health** button showing state, v2/legacy and round trip, and a last-action-error readout). Overtime red on the countdown presets follows the config checkbox.

Buttons are ordinary Companion presets: one image slot per button. The grey gradient plate and the Font Awesome icon arrive pre-flattened into that single image, drawn over the button's own background colour, with the label as text on top. Feedbacks therefore recolour the background (the plate is translucent, so it shows through) and cannot repaint the icon on its own. Layered presets, where each layer is repainted separately, need `@companion-module/base` 2.x, which Companion 5.0.4 still refuses to load; this module stays on 1.14 until that changes.

Two behaviours worth knowing. A **Go To Waypoint** button greys itself out whenever its waypoint isn't assigned to anything in the plan currently loaded: firing one answers 409 and does nothing, so the button tells you before you press it rather than under your finger. And the **Projected / Actual** section has two different toggles — the live one is a transient override that never touches the plan, the plan-item one persists into the next time that plan loads.

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

The per-role presets (keyed by the role's id, so a rename keeps the button you already placed) regenerate automatically as roles are added, renamed, or removed on the show — no action needed to pick them up.
