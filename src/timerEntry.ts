// A TypeScript port of the app's own time-entry grammar and duration
// formatting — Sources/Shared/Services/TimerInputParser.swift and
// `TimeFormatting` in Sources/Shared/Models/HourFormatThreshold.swift.
//
// This port exists ONLY to preview what a buffer will become before it is
// committed; the commit itself posts the raw text to `POST /v1/timer/remaining`
// as `{ "input": … }`, which the app parses with the very parser this file
// mirrors. Nothing here decides what a press actually does — so a drift
// between this port and the Swift original can at worst show a wrong preview,
// never send a wrong command. Keep it faithful anyway: unit/timerEntry.test.mjs
// runs the same cases as Tests/CueEngineTests.swift's TimerInputParserTests.

import type { HourFormatThreshold } from './types.js'

/** `TimerInputParser.Action`, as a discriminated union rather than a Swift enum. */
export type TimerInputAction = { kind: 'setAbsolute'; seconds: number } | { kind: 'adjustRelative'; bySeconds: number }

/** The `+`/`-` prefix that makes a buffer relative. */
export type TimerEntrySign = '+' | '-'

/**
 * Examples: `"4350"`, `"43:50"`, `"43.50"` → set 43:50. `"2m3s"` → set 2:03.
 * `"+120s"` → add 120s. `"-30s"` → subtract 30s. `"1h30m"` → set 1:30:00.
 * `null` for anything that isn't (yet) a time.
 */
export function parseTimerInput(raw: string): TimerInputAction | null {
	const trimmed = raw.trim()
	if (!trimmed) return null

	let text = trimmed
	let isRelative = false
	let sign = 1
	if (text.startsWith('+')) {
		isRelative = true
		text = text.slice(1)
	} else if (text.startsWith('-')) {
		isRelative = true
		sign = -1
		text = text.slice(1)
	}
	text = text.trim()

	const magnitude = parseMagnitude(text)
	if (magnitude === null) return null
	return isRelative
		? { kind: 'adjustRelative', bySeconds: sign * magnitude }
		: { kind: 'setAbsolute', seconds: magnitude }
}

/**
 * A non-negative duration in seconds from one of:
 * - one or more `h`/`m`/`s`-suffixed segments summed together — `"120s"` → 120,
 *   `"2m3s"` → 123, `"1h30m"` → 5400;
 * - an explicit `:` or `.` separator — `"43:50"`/`"43.50"` → 43:50;
 * - bare digits with neither — `"4350"` → 43:50, GrandMA/timecode style: the
 *   last two digits are seconds, everything before them is minutes (`"5"` →
 *   `0:05`, not 5 minutes).
 */
function parseMagnitude(text: string): number | null {
	if (!text) return null

	const combined = parseCombinedUnits(text.toLowerCase())
	if (combined !== null) return combined

	const separatorIndex = findSeparatorIndex(text)
	if (separatorIndex !== -1) {
		const minutesText = text.slice(0, separatorIndex)
		const secondsText = text.slice(separatorIndex + 1)
		// A bare separator with nothing on either side (e.g. just ":") isn't a
		// time — reject it rather than silently reading it as 0:00. One side
		// alone (":30" or "5:") is still fine.
		if (!minutesText && !secondsText) return null
		const minutes = parseInteger(minutesText || '0')
		const seconds = parseInteger(secondsText || '0')
		if (minutes === null || seconds === null) return null
		return Math.max(0, minutes) * 60 + Math.max(0, seconds)
	}

	if (!/^[0-9]+$/.test(text)) return null
	const padded = text.length < 2 ? text.padStart(2, '0') : text
	const minutesPart = padded.slice(0, -2)
	const minutes = minutesPart ? Number(minutesPart) : 0
	const seconds = Number(padded.slice(-2))
	return minutes * 60 + seconds
}

/** The first `:` or `.`, whichever comes first — the split point, matching Swift's `first(where:)` + `split(maxSplits: 1)`. */
function findSeparatorIndex(text: string): number {
	for (let i = 0; i < text.length; i++) {
		const char = text[i]
		if (char === ':' || char === '.') return i
	}
	return -1
}

/** Swift's `Int(_:)` on an ASCII string: a whole number, optional sign, nothing else. */
function parseInteger(text: string): number | null {
	if (!/^[+-]?[0-9]+$/.test(text)) return null
	return Number(text)
}

/**
 * `"2m3s"` → 123, `"1h30m"` → 5400, `"45s"` → 45 — any run of
 * `<digits><unit>` segments (unit one of `h`/`m`/`s`), summed. Returns `null`
 * for anything that doesn't fully parse this way: no digits before a unit, a
 * unit repeated, trailing digits with no unit after them (that's bare-digit/
 * separator territory instead), or any other character.
 */
function parseCombinedUnits(lowercasedText: string): number | null {
	let total = 0
	let digits = ''
	let matchedAny = false
	const seenUnits = new Set<string>()

	for (const char of lowercasedText) {
		if (char >= '0' && char <= '9') {
			digits += char
		} else if (char === 'h' || char === 'm' || char === 's') {
			if (!digits || seenUnits.has(char)) return null
			seenUnits.add(char)
			const value = Number(digits)
			if (char === 'h') total += value * 3600
			else if (char === 'm') total += value * 60
			else total += value
			digits = ''
			matchedAny = true
		} else {
			return null
		}
	}

	if (digits || !matchedAny) return null
	return Math.max(0, total)
}

/** `HourFormatThreshold.thresholdSeconds` — `null` means never switch to H:MM:SS. */
const HOUR_FORMAT_CUTOFF_SECONDS: Record<HourFormatThreshold, number | null> = {
	over60Minutes: 60 * 60,
	over90Minutes: 90 * 60,
	never: null,
}

/**
 * `TimeFormatting.string(forSeconds:threshold:)`: `MM:SS`, or `H:MM:SS` once
 * `abs(totalSeconds)` reaches the threshold. A negative value (overtime) reads
 * as `+<duration>` — the sign is about overtime, not about which format the
 * digits use.
 */
export function formatDuration(totalSeconds: number, threshold: HourFormatThreshold): string {
	const absSeconds = Math.abs(Math.trunc(totalSeconds))
	// An unrecognised threshold off the wire falls back to plain MM:SS rather
	// than throwing — a preview is not worth a crashed instance.
	const cutoff = HOUR_FORMAT_CUTOFF_SECONDS[threshold] ?? null

	let core: string
	if (cutoff !== null && absSeconds >= cutoff) {
		core = `${Math.floor(absSeconds / 3600)}:${pad2(Math.floor((absSeconds % 3600) / 60))}:${pad2(absSeconds % 60)}`
	} else {
		core = `${pad2(Math.floor(absSeconds / 60))}:${pad2(absSeconds % 60)}`
	}
	return totalSeconds < 0 ? `+${core}` : core
}

function pad2(value: number): string {
	return String(value).padStart(2, '0')
}

/**
 * What the timer's remaining time would read if this action were committed.
 * An absolute entry sets it (clamped at 0). A relative one lands on
 * `max(-elapsed, remaining + delta)`: the app clamps the item's *length* at 0,
 * not the remaining time, so a timer in overtime can still be nudged further
 * negative until the length would go below zero.
 */
export function resolvedSeconds(action: TimerInputAction, baseSeconds: number, elapsedSeconds = 0): number {
	return action.kind === 'setAbsolute'
		? Math.max(0, action.seconds)
		: Math.max(0 - elapsedSeconds, baseSeconds + action.bySeconds)
}

/**
 * The popover's "screen" preview line: the formatted result of applying
 * `buffer` to `baseSeconds`, or an empty string whenever what's typed doesn't
 * parse to a time yet — blank, deliberately, rather than an error string. A
 * relative entry with no active timer (`baseSeconds` null) has nothing to
 * adjust, so it is blank too.
 */
export function previewText(
	buffer: string,
	baseSeconds: number | null,
	threshold: HourFormatThreshold,
	elapsedSeconds = 0,
): string {
	const action = parseTimerInput(buffer)
	if (!action) return ''
	if (action.kind === 'adjustRelative' && baseSeconds === null) return ''

	const result = formatDuration(resolvedSeconds(action, baseSeconds ?? 0, elapsedSeconds), threshold)
	if (action.kind === 'setAbsolute') return result

	// A relative entry leads with the amount it's about to add or take off,
	// then what that lands on. The app's popover previews the landing value
	// alone, which it can get away with — the producer is looking straight at
	// the "+" they typed. On a pad the keys and the readout can be a metre
	// apart, and "05:30" looks identical whether it came from `530` or `+30s`.
	//
	// `formatDuration` prefixes a "+" of its own for a *negative* duration
	// (that's overtime, not subtraction — see TimeFormatting), so the sign
	// here goes on the magnitude.
	const sign = action.bySeconds < 0 ? '-' : '+'
	return `${sign}${formatDuration(Math.abs(action.bySeconds), threshold)}\n= ${result}`
}

/**
 * The `+`/`−` keys toggle a sign at the *front* of the buffer: the same sign
 * again removes it, the other one replaces it — `TimeEntryPopoverModifier.setSign`.
 */
export function withSign(buffer: string, sign: TimerEntrySign): string {
	if (buffer.startsWith(sign)) return buffer.slice(1)
	const rest = buffer.startsWith('+') || buffer.startsWith('-') ? buffer.slice(1) : buffer
	return sign + rest
}

/** The leading `+`/`-` currently on the buffer, if any — what makes an entry relative. */
export function signOf(buffer: string): TimerEntrySign | null {
	if (buffer.startsWith('+')) return '+'
	if (buffer.startsWith('-')) return '-'
	return null
}
