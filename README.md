# companion-module-13yearsproducer

A [Bitfocus Companion](https://bitfocus.io/companion) module for 13 Years Producer — a live-production cue and timer system for church/event production. Drives standby/GO cues to pagers, runs the per-item countdown timer, and steps through a Planning Center Online service plan, all through the app's local Control API.

See [companion/HELP.md](companion/HELP.md) for setup and usage.

## Design

The Control API pushes state over a WebSocket (`hello` on connect, then coalesced `state` events roughly once a second while a timer runs) rather than answering polls. This module holds that socket open for the life of the connection and drives every feedback and variable off what it pushes — it never polls `GET /v1/state` on a timer. Actions still go out over plain REST calls; most mutating routes hand back the full state snapshot anyway, so a REST action rarely needs a follow-up read.

There is no authentication: the app's Control API is off by default and has no token of any kind, so this module's config is a host, a port, and one checkbox for whether countdown presets turn red in overtime.

### The Timer Entry keypad

The **Timer Entry** presets recreate the app's calculator-style time-entry popover (`TimeEntryPopover.swift`) on physical buttons. The typed buffer lives in this module's own state, not on a surface, so every key, the screen readout, and the feedbacks all read the same buffer however the keys are spread across pages or surfaces.

Enter does not parse anything: it posts the raw typed text to `POST /v1/timer/remaining` as `{"input": "…"}`, which the app runs through the very parser its own time field uses — so a macro pad and the producer's keyboard can't disagree about what `4350` or `+2m3s` means. `src/timerEntry.ts` _is_ a TypeScript port of that parser, but only the preview line uses it: the worst a drift there can do is show a wrong preview, never send a wrong command. `unit/timerEntry.test.mjs` runs the same cases the app's own `TimerInputParserTests` do.

Companion presets are single buttons — nothing can span two cells — so the popover's double-tall Enter and double-wide `0` are ordinary one-cell buttons here. Backspace, which the popover only offers from a physical keyboard, takes the cell that frees up. Each preset's name carries its row and column (`R2C4 • −`) so the pad can be dropped onto a page in grid order.

The key faces are pre-rendered PNGs rather than Companion-drawn text, so the pad's digits match every other surface in the system — Inter, with its `zero` OpenType feature on for the slashed zero the app, the web pager, and the ESP32 pagers all show. They are drawn at 512×512, far above the 72px a Stream Deck key shows: Companion downsamples cleanly, and the surfaces that are larger than that (Stream Deck Plus, Satellite surfaces, the web UI at any zoom) get artwork that was never upscaled.

Each face is generated twice, in white and in near-black (`TIMER_ENTRY_GLYPHS` and `TIMER_ENTRY_GLYPHS_DARK`). A glyph is ink on transparency so the preset's own `bgcolor` shows through — which is exactly what makes a white face vanish when a feedback repaints that background a light colour, as Clear and Backspace do the moment you start typing and Enter does when the buffer parses. Every lit state swaps in the dark cut (`litFace` in `src/presets.ts`) instead of only changing the colour behind the glyph.

`src/glyphs.ts` is generated; regenerate it with:

```bash
swift scripts/render-glyphs.swift          # needs only a Swift toolchain — no npm dependency
```

It reads the .ttf files from the Producer repo (`--fonts` overrides the path) and rewrites `src/glyphs.ts` in place. To go back to plain Companion text on every key, set `USE_GLYPH_KEY_FACES = false` at the top of `src/presets.ts` — each key's text label is passed alongside its glyph, so that one line is the whole revert.

Inter is licensed under the SIL Open Font License; see [Inter-LICENSE.txt](Inter-LICENSE.txt).

## Requirements

Companion **5.0** or later, and Node **22.20+**. The module uses Companion's layered
button presets (`@companion-module/base` 2.2), which is also why that dependency is
currently pinned to a nightly — the layered graphics API hasn't landed in a stable
release yet.

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
layered button's text element can only use Companion's own bundled faces, so an icon
has to arrive as an image layer. The generated file is committed, so building the
module needs neither the font nor a Swift toolchain. Font Awesome Free is CC BY 4.0
(icons) and SIL OFL 1.1 (fonts); see [Font-Awesome-LICENSE.txt](Font-Awesome-LICENSE.txt).

SF Symbols would have been the obvious Mac-native alternative and is deliberately not
used: Apple licenses it only for apps on Apple platforms, and a Companion module runs
on Windows and Linux too.

## The API this drives

The Producer app's Control API is documented in `CONTROL-API.md` in the
[13years](https://github.com/TristonYoder/13years) repo — routes, the state
snapshot, the WebSocket protocol, and the conventions the module relies on
(absolute setters rather than toggles, 202 for asynchronous work, the 404-vs-409
split on firing a waypoint). Where that document and the app's own
`ControlAPIRouter.swift` / `ControlAPIModels.swift` disagree, the code wins, and
`src/types.ts` records any divergence found so far.
