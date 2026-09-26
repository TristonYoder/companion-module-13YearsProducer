// Pure unit tests for the Timer Entry keypad: the TypeScript port of the app's
// own input grammar and duration formatting, plus the buffer editing the
// keypad's keys do.
//
// The parse cases below are the same ones the app asserts in
// /Users/tyoder/Projects/13years/Tests/CueEngineTests.swift
// (TimerInputParserTests / TimeFormattingTests) — if the Swift parser's rules
// change, these are what should catch the drift.
//
//   npm run test:unit
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

const { formatDuration, parseTimerInput, previewText, resolvedSeconds, signOf, withSign } = await import(
	'../dist/timerEntry.js'
)
const { ModuleState } = await import('../dist/state.js')

const absolute = (seconds) => ({ kind: 'setAbsolute', seconds })
const relative = (bySeconds) => ({ kind: 'adjustRelative', bySeconds })

describe('parseTimerInput', () => {
	test('bare digits split positionally (MMSS)', () => {
		assert.deepEqual(parseTimerInput('4350'), absolute(43 * 60 + 50))
		assert.deepEqual(parseTimerInput('350'), absolute(3 * 60 + 50))
		assert.deepEqual(parseTimerInput('50'), absolute(50))
		assert.deepEqual(parseTimerInput('5'), absolute(5))
	})

	test('an explicit separator is minutes:seconds', () => {
		assert.deepEqual(parseTimerInput('43:50'), absolute(43 * 60 + 50))
		assert.deepEqual(parseTimerInput('43.50'), absolute(43 * 60 + 50))
	})

	test('one side of the separator alone is still a time', () => {
		assert.deepEqual(parseTimerInput(':30'), absolute(30))
		assert.deepEqual(parseTimerInput('5:'), absolute(5 * 60))
	})

	test('a unit suffix is a plain count, not positional', () => {
		assert.deepEqual(parseTimerInput('120s'), absolute(120))
		assert.deepEqual(parseTimerInput('1m'), absolute(60))
	})

	test('combined unit suffixes sum', () => {
		assert.deepEqual(parseTimerInput('2m3s'), absolute(2 * 60 + 3))
		assert.deepEqual(parseTimerInput('1h30m'), absolute(90 * 60))
		assert.deepEqual(parseTimerInput('1h2m3s'), absolute(3600 + 2 * 60 + 3))
		assert.deepEqual(parseTimerInput('+2m3s'), relative(2 * 60 + 3))
		assert.deepEqual(parseTimerInput('-2m3s'), relative(-(2 * 60 + 3)))
	})

	test('a leading sign makes it relative', () => {
		assert.deepEqual(parseTimerInput('+120s'), relative(120))
		assert.deepEqual(parseTimerInput('+1m'), relative(60))
		assert.deepEqual(parseTimerInput('-30s'), relative(-30))
		assert.deepEqual(parseTimerInput('-1m'), relative(-60))
		assert.deepEqual(parseTimerInput('+43:50'), relative(43 * 60 + 50))
	})

	test('units are case-insensitive, the way typing them is', () => {
		assert.deepEqual(parseTimerInput('1H30M'), absolute(90 * 60))
	})

	test('invalid input parses to null', () => {
		assert.equal(parseTimerInput(''), null)
		assert.equal(parseTimerInput('   '), null)
		assert.equal(parseTimerInput('abc'), null)
		assert.equal(parseTimerInput('+'), null)
		assert.equal(parseTimerInput(':'), null)
		// Trailing digits with no unit after them isn't valid combined-unit
		// input — that's bare-digit/separator territory, and "2m3" has neither
		// a separator nor a trailing unit to fall back to.
		assert.equal(parseTimerInput('2m3'), null)
		// A repeated unit is ambiguous, not just "sum it again".
		assert.equal(parseTimerInput('1m2m'), null)
	})
})

describe('formatDuration', () => {
	test('stays MM:SS below the threshold', () => {
		assert.equal(formatDuration(89 * 60 + 59, 'over90Minutes'), '89:59')
		assert.equal(formatDuration(0, 'over90Minutes'), '00:00')
		assert.equal(formatDuration(5, 'over90Minutes'), '00:05')
	})

	test('switches to H:MM:SS at the threshold', () => {
		assert.equal(formatDuration(90 * 60, 'over90Minutes'), '1:30:00')
		assert.equal(formatDuration(60 * 60, 'over60Minutes'), '1:00:00')
		assert.equal(formatDuration(60 * 60, 'over90Minutes'), '60:00')
	})

	test('never means never, however long', () => {
		assert.equal(formatDuration(3 * 60 * 60, 'never'), '180:00')
	})

	test('overtime reads as +duration', () => {
		assert.equal(formatDuration(-65, 'over90Minutes'), '+01:05')
	})
})

describe('resolvedSeconds', () => {
	test('absolute ignores the base; relative applies to it', () => {
		assert.equal(resolvedSeconds(absolute(150), 600), 150)
		assert.equal(resolvedSeconds(relative(120), 600), 720)
		assert.equal(resolvedSeconds(relative(-120), 600), 480)
	})

	test('clamps at zero rather than going negative', () => {
		assert.equal(resolvedSeconds(relative(-900), 600), 0)
		assert.equal(resolvedSeconds(absolute(-5), 600), 0)
	})
})

describe('previewText', () => {
	test('previews an absolute entry against nothing in particular', () => {
		assert.equal(previewText('2m3s', 600, 'over90Minutes'), '02:03')
	})

	test('previews a relative entry as the amount, then where it lands', () => {
		assert.equal(previewText('+120s', 2 * 60 + 30, 'over90Minutes'), '+02:00\n= 04:30')
		assert.equal(previewText('-30s', 2 * 60 + 30, 'over90Minutes'), '-00:30\n= 02:00')
	})

	test("a relative entry's sign is the one typed, not the one overtime would print", () => {
		// `formatDuration` prefixes "+" for a negative duration, which means
		// overtime — nothing to do with subtracting. The magnitude is what gets
		// formatted here, so "-5m" must not come out as "+05:00".
		assert.equal(previewText('-5m', 600, 'over90Minutes'), '-05:00\n= 05:00')
	})

	test('a relative entry that would go past zero lands at zero, like the popover', () => {
		assert.equal(previewText('-10m', 60, 'over90Minutes'), '-10:00\n= 00:00')
	})

	test('is blank — not an error — while the buffer is empty or half-typed', () => {
		assert.equal(previewText('', 600, 'over90Minutes'), '')
		assert.equal(previewText('+', 600, 'over90Minutes'), '')
		assert.equal(previewText('2m3', 600, 'over90Minutes'), '')
	})
})

describe('withSign / signOf', () => {
	test('a sign goes on the front of whatever is already typed', () => {
		assert.equal(withSign('30s', '+'), '+30s')
		assert.equal(withSign('30s', '-'), '-30s')
	})

	test('the same sign again removes it', () => {
		assert.equal(withSign('+30s', '+'), '30s')
		assert.equal(withSign('-30s', '-'), '30s')
	})

	test('the other sign replaces it', () => {
		assert.equal(withSign('+30s', '-'), '-30s')
		assert.equal(withSign('-30s', '+'), '+30s')
	})

	test('signOf reports the leading sign, or null for an absolute entry', () => {
		assert.equal(signOf('+30s'), '+')
		assert.equal(signOf('-30s'), '-')
		assert.equal(signOf('30s'), null)
		assert.equal(signOf(''), null)
	})
})

describe('ModuleState timer entry buffer', () => {
	test('starts empty, with nothing to commit and nothing to preview', () => {
		const state = new ModuleState()
		assert.equal(state.timerEntryBuffer, '')
		assert.equal(state.timerEntryAction, null)
		assert.equal(state.timerEntrySign, null)
		assert.equal(state.timerEntryPreview, '')
	})

	test('keys append, backspace removes the last one, clear empties it', () => {
		const state = new ModuleState()
		for (const key of ['2', 'm', '3', 's']) state.appendTimerEntry(key)
		assert.equal(state.timerEntryBuffer, '2m3s')
		state.backspaceTimerEntry()
		assert.equal(state.timerEntryBuffer, '2m3')
		assert.equal(state.timerEntryAction, null)
		state.clearTimerEntry()
		assert.equal(state.timerEntryBuffer, '')
	})

	test('backspace on an empty buffer is a no-op, not an error', () => {
		const state = new ModuleState()
		state.backspaceTimerEntry()
		assert.equal(state.timerEntryBuffer, '')
	})

	test('the sign keys toggle a prefix without disturbing what is typed', () => {
		const state = new ModuleState()
		state.appendTimerEntry('30')
		state.appendTimerEntry('s')
		state.setTimerEntrySign('+')
		assert.equal(state.timerEntryBuffer, '+30s')
		assert.equal(state.timerEntrySign, '+')
		state.setTimerEntrySign('-')
		assert.equal(state.timerEntryBuffer, '-30s')
		state.setTimerEntrySign('-')
		assert.equal(state.timerEntryBuffer, '30s')
		assert.equal(state.timerEntrySign, null)
	})

	test('the preview reads against the live countdown and the app’s own hour-format setting', () => {
		const state = new ModuleState()
		state.applyState({
			timer: { remainingSeconds: 2 * 60 + 30 },
			settings: { hourFormatThreshold: 'over60Minutes' },
		})
		state.appendTimerEntry('3')
		state.appendTimerEntry('0')
		state.appendTimerEntry('s')
		assert.equal(state.timerEntryPreview, '00:30')
		state.setTimerEntrySign('+')
		assert.equal(state.timerEntryPreview, '+00:30\n= 03:00')
		state.clearTimerEntry()
		for (const key of ['1', 'h']) state.appendTimerEntry(key)
		assert.equal(state.timerEntryPreview, '1:00:00')
	})

	test('a relative entry with no timer running previews against zero, clamped', () => {
		const state = new ModuleState()
		state.appendTimerEntry('-')
		state.appendTimerEntry('3')
		state.appendTimerEntry('0')
		// "-" typed as a plain key (not via the sign action) still reads as a
		// relative entry — the grammar is the same either way.
		assert.equal(state.timerEntryPreview, '-00:30\n= 00:00')
	})
})
