# companion-module-13yearsproducer

A [Bitfocus Companion](https://bitfocus.io/companion) module for 13 Years Producer — a live-production cue and timer system for church/event production. Drives standby/GO cues to pagers, runs the per-item countdown timer, and steps through a Planning Center Online service plan, all through the app's local Control API.

See [companion/HELP.md](companion/HELP.md) for setup and usage.

## Design

The Control API pushes state over a WebSocket (`hello` on connect, then coalesced `state` events roughly once a second while a timer runs; on sync protocol v2, only on change, see below) rather than answering polls. This module holds that socket open for the life of the connection and drives every feedback and variable off what it pushes — it never polls `GET /v1/state` on a timer. Actions still go out over plain REST calls; most mutating routes hand back the full state snapshot anyway, so a REST action rarely needs a follow-up read.

There is no authentication: the app's Control API is off by default and has no token of any kind, so this module's config is a host, a port, and one checkbox for whether countdown presets turn red in overtime.

### Sync protocol v2

Newer apps speak the clock-synchronised protocol described in `Server/PROTOCOL-V2.md` of the Producer repo. Right after the socket opens the module sends the `proto` op with `{"version": 2}`; an app that does not answer 200 is treated as legacy and nothing below applies (1 Hz `timer` pushes, 7.5 s staleness, 12 s keepalive deadline).

On a v2 link:

- **Clock.** The module runs the `sync` op (a burst of 5 samples 100 ms apart on connect, then every 30 s), keeps the last 8 samples and uses the one with the smallest round trip. A change under 20 ms is slewed (25% per sample), anything larger jumps. Sample times (`t0`/`t3`) and aging use a monotonic clock (`performance.now()` from an epoch captured at start-up), so a system clock step cannot corrupt an offset. Samples older than 90 s are ignored; a reply with rtt over 10 s or an offset beyond a day is ignored; a fresh offset further than `max(50 ms, 2 * rtt)` from the held best discards the older samples. A wake from sleep, a clock step (seen as the wall clock pulling away from the monotonic one, or a gap of more than 5 s between 1 s housekeeping ticks), a reconnect or a new producer epoch clears all samples and bursts again. `ModuleState.producerNowMs()` is the app's clock; `sync_offset_ms` and `sync_rtt_ms` expose the measurement.
- **Local timer.** The app pushes a `timer` event only when the timer changes, carrying an `anchor`. The module computes elapsed and remaining from the anchor and the offset (`ModuleState.timerRemainingSeconds`, the single accessor every variable, feedback and the Timer Entry preview reads), and ticks on `anchorMs + k * 1000` of the app's clock. Each tick sends only the variables whose value changed and re-checks only the countdown feedbacks.
- **Digest.** Every 2 s the app sends a `digest` event with FNV-1a 64 hashes of `roles`, `timer`, `plan` and `messages` (`src/sync.ts`, same test vectors as the spec). The module hashes its held snapshot the same way; any difference costs exactly one `GET /v1/state`, adopted through the `rev` gate (a catch-up read is allowed to take an equal rev). `state` and `timer` events need a `rev` strictly greater than the one held and not more than 1,000,000 above it (unless the `epoch` changed or it is a hello); a digest repeating the held rev is simply verified. Anchors outside the protocol's ranges are ignored. The app's `epoch` (v2.1) in `hello`, `timer` and `digest` data marks a restart: a new one resets the anchor, rev gate and clock samples, bursts again and fetches the state once. The Control API has no `to` addressing, so the v2.1 addressing rules do not apply here. The digest is also the heartbeat, so staleness is 5 s of silence (8 s with a legacy app, whose beat is 5 s) and the keepalive deadline is 20 s (12 s legacy), matching the v2.4 signal-loss rules. Staleness counts data frames only; a pong does not reset it.

`src/session.ts` holds the per-connection logic against an injectable clock and scheduler, which is how `unit/session.test.mjs` tests tick alignment and the digest path without a socket. The `sync protocol v2` block in `contract/` runs against a live app and skips itself when the app is older.

### The Timer Entry keypad


The **Timer Entry** presets recreate the app's calculator-style time-entry popover (`TimeEntryPopover.swift`) on physical buttons. The typed buffer lives in this module's own state, not on a surface, so every key, the screen readout, and the feedbacks all read the same buffer however the keys are spread across pages or surfaces.

Enter does not parse anything: it posts the raw typed text to `POST /v1/timer/remaining` as `{"input": "…"}`, which the app runs through the very parser its own time field uses — so a macro pad and the producer's keyboard can't disagree about what `4350` or `+2m3s` means. `src/timerEntry.ts` _is_ a TypeScript port of that parser, but only the preview line uses it: the worst a drift there can do is show a wrong preview, never send a wrong command. `unit/timerEntry.test.mjs` runs the same cases the app's own `TimerInputParserTests` do.

**Using the entry elsewhere.** `$(13yearsproducer:timer_entry_result)` is the time the entry would leave (`03:00`) and `timer_entry_result_seconds` the same in seconds; both are empty while the buffer is empty or not a time. `timer_entry_preview` is the two-line display text, and the length fields below also accept it.

**Item lengths.** The Length field of **Plan Add Item** and **Plan Update Item** is text with variable support (global, custom or local). It reads plain seconds (`90`), `mm:ss` (`1:30`), `h:mm:ss` (`1:02:03`) or unit suffixes (`5m`, `1h2m3s`), up to 24 hours. Empty or `0` leaves the length unchanged on update. Older buttons that stored a number are converted by an upgrade script.

Companion presets are single buttons — nothing can span two cells — so the popover's double-tall Enter and double-wide `0` are ordinary one-cell buttons here. Backspace, which the popover only offers from a physical keyboard, takes the cell that frees up. Each preset's name carries its row and column (`R2C4 • −`) so the pad can be dropped onto a page in grid order.

The key faces are pre-rendered PNGs rather than Companion-drawn text, so the pad's digits match every other surface in the system — Inter, with its `zero` OpenType feature on for the slashed zero the app, the web pager, and the ESP32 pagers all show. They are drawn at 512×512, far above the 72px a Stream Deck key shows: Companion downsamples cleanly, and the surfaces that are larger than that (Stream Deck Plus, Satellite surfaces, the web UI at any zoom) get artwork that was never upscaled.

Each face is generated twice, in white and in near-black (`TIMER_ENTRY_GLYPHS` and `TIMER_ENTRY_GLYPHS_DARK`). A glyph is ink on transparency so the preset's own `bgcolor` shows through — which is exactly what makes a white face vanish when a feedback repaints that background a light colour, as Clear and Backspace do the moment you start typing and Enter does when the buffer parses. Every lit state swaps in the dark cut (`lit` in `src/presets.ts`) instead of only changing the colour behind the glyph.

`src/glyphs.ts` is generated; regenerate it with:

```bash
swift scripts/render-glyphs.swift          # needs only a Swift toolchain — no npm dependency
```

It reads the .ttf files from the Producer repo (`--fonts` overrides the path) and rewrites `src/glyphs.ts` in place. To go back to plain Companion text on every key, set `USE_GLYPH_KEY_FACES = false` at the top of `src/presets.ts` — each key's text label is passed alongside its glyph, so that one line is the whole revert.

Inter is licensed under the SIL Open Font License; see [Inter-LICENSE.txt](Inter-LICENSE.txt).

## Requirements

Companion **5.0** or later, and Node **22.20+**. The module is built on
`@companion-module/base` 1.14 (see `package.json`). Its presets have one image slot per
button, so the icon and plate are flattened into a single image; layered presets would
need base 2.x, which Companion 5.0.4 refuses to load (see the note in `src/presets.ts`).

## Development

```bash
npm install
npm run build
```

Then add this directory as a "developer module" path in Companion's module manager to test locally.

```bash
npm run lint          # eslint
npm run test:unit     # pure logic, no running app required
npm run test:contract # drives dist/api.js against a real running Producer app — see contract/contract.test.mjs
```

## CI / Releases

Every push and PR runs typecheck, lint, unit tests, `companion-module-check`, and a full `companion-module-build` via GitHub Actions ([.github/workflows/ci.yml](.github/workflows/ci.yml)).

To cut a release: bump `version` in both `package.json` and `companion/manifest.json` (`npm run sync-version -- <version>` does both), commit, then push a matching tag (e.g. `v1.1.0`). That triggers [.github/workflows/release.yml](.github/workflows/release.yml), which builds the module and attaches the packaged `.tgz` to a GitHub Release.

## Icon artwork

Button icons are Font Awesome 6 Free Solid glyphs, pre-rendered to base64 PNGs in
`src/icons.ts` (along with the gradient plate) by `scripts/render-icons.swift` — a
button's text can only use Companion's own bundled faces, so an icon
has to arrive as an image. The generated file is committed, so building the
module needs neither the font nor a Swift toolchain. Font Awesome Free is CC BY 4.0
(icons) and SIL OFL 1.1 (fonts); see [Font-Awesome-LICENSE.txt](Font-Awesome-LICENSE.txt).

SF Symbols would have been the obvious Mac-native alternative and is deliberately not
used: Apple licenses it only for apps on Apple platforms, and a Companion module runs
on Windows and Linux too.

## Planning Center and waypoint housekeeping

Beyond cues and timers, the module can clear the selected Planning Center service type (_Select Service Type_ with _Clear selection_), set or clear the remembered default (_Set Default Service Type_), and unassign a waypoint without deleting it (_Unassign Waypoint_). The OAuth sign-in only opens a browser on the device; it cannot be completed from Companion.

## Run sheet, clock format and older Producers

13 Years 1.7.0 added skips, rehearsal mode, recorded actuals (`liveOps` in the state snapshot), Planning Center item details on plan items, and a 12/24-hour clock format (`settings.clockFormat`, with a per-role override). The module reads all of them as optional: against an older Producer the new variables are blank or `no`, the new feedbacks are false, and the new actions warn that they need 1.7.0 (an unknown route answers 404 `Unknown path`, which the module tells apart from an unknown item). The next item comes from `timer.nextItem` when the Producer sends it, so it passes over headers, skipped items and items excluded from the live event time exactly as the app does; without it the module applies the same rules to the plan itself.

## Colours

`src/palette.ts` is generated by `scripts/generate-palette.py` in the Producer repo from its `Design/palette.json`, so cue colours, feedback defaults and preset colours match the app, the web pager and the ESP32 pagers. Don't edit it by hand; change the token file and rerun the generator with this repo checked out next to the Producer repo (or `COMPANION_DIR` pointing at it).

## The API this drives

The Producer app's Control API is documented in `CONTROL-API.md` in the
[13years](https://github.com/TristonYoder/13years) repo — routes, the state
snapshot, the WebSocket protocol, and the conventions the module relies on
(absolute setters rather than toggles, 202 for asynchronous work, the 404-vs-409
split on firing a waypoint). Where that document and the app's own
`ControlAPIRouter.swift` / `ControlAPIModels.swift` disagree, the code wins, and
`src/types.ts` records any divergence found so far.
