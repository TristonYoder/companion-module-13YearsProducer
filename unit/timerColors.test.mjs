import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

const { timerColorStyle, hexToRgbNumber } = await import('../dist/timerColors.js')
const { ModuleState } = await import('../dist/state.js')
const { getActionDefinitions, parseScheduleTarget } = await import('../dist/actions.js')
const { getFeedbackDefinitions } = await import('../dist/feedbacks.js')
const { getVariableDefinitions, getVariableValues } = await import('../dist/variables.js')
const { getPresetDefinitions } = await import('../dist/presets.js')

// The standard scale as the app documents it: yellow at 10% left, red flickering from zero, a pulsing deeper level 3s over.
const STANDARD = {
	stops: [
		{ id: 'w', phase: 'remaining', value: 10, unit: 'percent', colorHex: 'FFD60A', effect: 'none' },
		{ id: 'd', phase: 'overtime', value: 3, unit: 'seconds', colorHex: 'AA0000', effect: 'pulse' },
	],
	overtimeHex: 'CC1717',
	overtimeEffect: 'flicker',
}

describe('timerColorStyle', () => {
	test('no scale from the producer means no color', () => {
		assert.deepEqual(timerColorStyle(null, 30, 100), { colorHex: null, effect: 'none', level: 'none' })
		assert.deepEqual(timerColorStyle(undefined, -5, 100), { colorHex: null, effect: 'none', level: 'none' })
		assert.equal(timerColorStyle(STANDARD, null, 100).colorHex, null)
	})

	test('plenty of time keeps the normal color, or the on-time color when set', () => {
		assert.equal(timerColorStyle(STANDARD, 90, 100).colorHex, null)
		const withOnTime = timerColorStyle({ ...STANDARD, onTimeHex: '00FF00' }, 90, 100)
		assert.deepEqual(withOnTime, { colorHex: '00FF00', effect: 'none', level: 'on_time' })
	})

	test('lead-up stop applies at its percent of the item length, nearest to zero wins', () => {
		assert.equal(timerColorStyle(STANDARD, 10, 100).colorHex, 'FFD60A')
		assert.equal(timerColorStyle(STANDARD, 11, 100).colorHex, null)
		const scale = {
			...STANDARD,
			stops: [
				{ phase: 'remaining', value: 60, unit: 'seconds', colorHex: 'FFFF00' },
				{ phase: 'remaining', value: 20, unit: 'seconds', colorHex: 'FF8800', effect: 'blink' },
			],
		}
		assert.deepEqual(timerColorStyle(scale, 15, 600), { colorHex: 'FF8800', effect: 'blink', level: 'lead_up' })
		assert.equal(timerColorStyle(scale, 40, 600).colorHex, 'FFFF00')
	})

	test('a stop with no phase is a lead-up stop', () => {
		const scale = { ...STANDARD, stops: [{ value: 30, unit: 'seconds', colorHex: 'ABCDEF' }] }
		assert.equal(timerColorStyle(scale, 20, 600).colorHex, 'ABCDEF')
	})

	test('overtime uses the overtime color and effect, deepest overtime stop wins', () => {
		assert.deepEqual(timerColorStyle(STANDARD, -1, 100), { colorHex: 'CC1717', effect: 'flicker', level: 'overtime' })
		assert.deepEqual(timerColorStyle(STANDARD, -3, 100), { colorHex: 'AA0000', effect: 'pulse', level: 'overtime_deep' })
		const scale = {
			...STANDARD,
			stops: [
				{ phase: 'overtime', value: 10, unit: 'percent', colorHex: '111111' },
				{ phase: 'overtime', value: 5, unit: 'seconds', colorHex: '222222' },
			],
		}
		assert.equal(timerColorStyle(scale, -6, 100).colorHex, '222222')
		assert.equal(timerColorStyle(scale, -12, 100).colorHex, '111111')
	})

	test('overtimeStart delays the overtime color and keeps the lead-up look as if at zero', () => {
		const scale = { ...STANDARD, overtimeStart: { value: 10, unit: 'seconds' } }
		// 5s over, 10s needed: the 10%-left stop still applies, as at zero.
		assert.deepEqual(timerColorStyle(scale, -5, 100), { colorHex: 'FFD60A', effect: 'none', level: 'lead_up' })
		assert.equal(timerColorStyle(scale, -10, 100).level, 'overtime_deep')
		assert.equal(timerColorStyle({ ...scale, stops: [] }, -10, 100).level, 'overtime')
	})

	test('a missing effect reads as none', () => {
		const scale = { stops: [{ value: 30, unit: 'seconds', colorHex: 'ABCDEF' }], overtimeHex: 'CC1717' }
		assert.equal(timerColorStyle(scale, 10, 100).effect, 'none')
		assert.equal(timerColorStyle(scale, -1, 100).effect, 'none')
	})
})

test('hexToRgbNumber packs six hex digits and rejects the rest', () => {
	assert.equal(hexToRgbNumber('FFD60A'), 0xffd60a)
	assert.equal(hexToRgbNumber('ffd60a'), 0xffd60a)
	assert.equal(hexToRgbNumber('#FFD60A'), null)
	assert.equal(hexToRgbNumber('FFF'), null)
	assert.equal(hexToRgbNumber(null), null)
})

let nextRev = 1
function snapshotWithTimer({ remaining, colors, settingsColors } = {}) {
	return {
		rev: nextRev++,
		roles: [],
		selectedRoleIds: [],
		timer: {
			item: { id: 'i1', title: 'Welcome', itemType: 'item', sequence: 1, lengthInSeconds: 100, elapsedSeconds: 100 - remaining },
			index: 0,
			isRunning: true,
			remainingSeconds: remaining,
			isOvertime: remaining < 0,
			formattedRemaining: '',
			isDurationActualForDisplay: false,
			...(colors ? { colors } : {}),
		},
		plan: { title: 'Sunday', items: [], activeItemIndex: 0 },
		messages: [],
		waypoints: [],
		schedules: { entries: [], nextId: null },
		settings: { hourFormatThreshold: 'over90Minutes', ...(settingsColors ? { timerColors: settingsColors } : {}) },
	}
}

describe('state, variables and feedback', () => {
	test('the item scale wins over the producer-wide one, which is the fallback', () => {
		const state = new ModuleState()
		state.applyState(snapshotWithTimer({ remaining: 5, settingsColors: STANDARD }))
		assert.equal(state.timerColor.colorHex, 'FFD60A')
		state.applyState(
			snapshotWithTimer({
				remaining: 5,
				colors: { ...STANDARD, stops: [{ value: 30, unit: 'seconds', colorHex: '00AAFF' }] },
				settingsColors: STANDARD,
			}),
		)
		assert.equal(state.timerColor.colorHex, '00AAFF')
	})

	test('no scale anywhere means no color, never an assumed red', () => {
		const state = new ModuleState()
		state.applyState(snapshotWithTimer({ remaining: -20 }))
		assert.equal(state.timerColor.colorHex, null)
		const values = getVariableValues(state)
		assert.equal(values.timer_color_hex, '')
		assert.equal(values.timer_color_level, 'none')
	})

	test('variables are defined and carry the live level', () => {
		const ids = getVariableDefinitions(new ModuleState()).map((v) => v.variableId)
		for (const id of ['timer_color_hex', 'timer_color_level', 'timer_color_effect']) assert.ok(ids.includes(id), id)
		const state = new ModuleState()
		state.applyState(snapshotWithTimer({ remaining: -5, settingsColors: STANDARD }))
		const values = getVariableValues(state)
		assert.equal(values.timer_color_hex, 'AA0000')
		assert.equal(values.timer_color_level, 'overtime_deep')
		assert.equal(values.timer_color_effect, 'pulse')
	})

	test('the feedback colors text or background and stays empty with no color', () => {
		const state = new ModuleState()
		const feedback = getFeedbackDefinitions(state).timerColor
		assert.equal(feedback.type, 'advanced')
		state.applyState(snapshotWithTimer({ remaining: 5, settingsColors: STANDARD }))
		assert.deepEqual(feedback.callback({ options: { target: 'text' } }), { color: 0xffd60a })
		const bg = feedback.callback({ options: { target: 'background' } })
		assert.equal(bg.bgcolor, 0xffd60a)
		assert.ok('color' in bg)
		state.applyState(snapshotWithTimer({ remaining: 90, settingsColors: STANDARD }))
		assert.deepEqual(feedback.callback({ options: { target: 'text' } }), {})
	})

	test('timer color presets exist and use the feedback', () => {
		const presets = getPresetDefinitions(new ModuleState())
		for (const id of ['timer_color_text', 'timer_color_background', 'timer_color_level']) {
			assert.ok(presets[id].feedbacks.some((f) => f.feedbackId === 'timerColor'), id)
		}
		assert.equal(presets.timer_colors_reset.steps[0].down[0].actionId, 'timerColorsReset')
	})
})

describe('actions', () => {
	function harness(api = {}) {
		const state = new ModuleState()
		state.applyState(snapshotWithTimer({ remaining: 50 }))
		const defs = getActionDefinitions({ api, state, log: () => {}, refresh: () => {} })
		return { defs }
	}

	test('parseScheduleTarget reads event:<id> and rehearsal:<id>, and clears otherwise', () => {
		assert.deepEqual(parseScheduleTarget('event:abc'), { targetKind: 'event', targetId: 'abc' })
		assert.deepEqual(parseScheduleTarget('rehearsal:x:y'), { targetKind: 'rehearsal', targetId: 'x:y' })
		assert.deepEqual(parseScheduleTarget(''), { targetKind: '', targetId: '' })
		assert.deepEqual(parseScheduleTarget('nonsense'), { targetKind: '', targetId: '' })
	})

	test('Create Schedule sends the target and start-first flag', async () => {
		const calls = []
		const { defs } = harness({ createSchedule: async (body) => calls.push(body) })
		await defs.scheduleCreate.callback({
			options: {
				title: 'Sunday',
				startsAt: '2026-12-06T10:00:00-05:00',
				minutes: 30,
				recurrence: 'weekly',
				isEnabled: true,
				target: 'event:t1',
				startsFirstItem: true,
			},
		})
		assert.equal(calls.length, 1)
		assert.equal(calls[0].targetKind, 'event')
		assert.equal(calls[0].targetId, 't1')
		assert.equal(calls[0].startsFirstItem, true)
	})

	test('Set Schedule Target Time leaves the start flag alone unless told', async () => {
		const calls = []
		const { defs } = harness({ updateSchedule: async (id, body) => calls.push([id, body]) })
		await defs.scheduleSetTarget.callback({ options: { scheduleId: 's1', target: 'rehearsal:r1', startsFirstItem: 'keep' } })
		await defs.scheduleSetTarget.callback({ options: { scheduleId: 's1', target: '', startsFirstItem: 'yes' } })
		assert.deepEqual(calls[0], ['s1', { targetKind: 'rehearsal', targetId: 'r1' }])
		assert.deepEqual(calls[1], ['s1', { targetKind: '', targetId: '', startsFirstItem: true }])
	})

	test('Name Plan, Unlink and Reset Timer Colors call the API', async () => {
		const calls = []
		const { defs } = harness({
			setPlanTitle: async (title) => calls.push(['title', title]),
			unlinkPco: async () => calls.push(['unlink']),
			updateSettings: async (body) => calls.push(['settings', body]),
		})
		await defs.planSetTitle.callback({ options: { title: '  Easter  ' } })
		await defs.pcoUnlink.callback({ options: {} })
		await defs.timerColorsReset.callback({ options: {} })
		assert.deepEqual(calls, [['title', 'Easter'], ['unlink'], ['settings', { timerColors: {} }]])
	})
})
