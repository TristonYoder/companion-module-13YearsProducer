import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

const { parseClock, parseEndAt, secondsUntilClockTime, endAtTimeText } = await import('../dist/timerEntry.js')
const { ModuleState } = await import('../dist/state.js')
const { ControlApi, ApiError } = await import('../dist/api.js')
const { getActionDefinitions } = await import('../dist/actions.js')
const { getFeedbackDefinitions } = await import('../dist/feedbacks.js')
const { getVariableValues } = await import('../dist/variables.js')
const { getPresetDefinitions } = await import('../dist/presets.js')

const NOW = Date.UTC(2026, 9, 18, 18, 0, 0)
const EDT = -4 * 3600

function snapshot(settings = {}) {
	return {
		appMode: 'PRODUCER_CONTROL',
		utcOffsetSeconds: EDT,
		network: {},
		roles: [],
		selectedRoleIds: [],
		timer: null,
		plan: { title: null, items: [], activeItemIndex: 0, isAtEndOfPlan: false },
		messages: [],
		pco: { serviceTypes: [], plans: [], noteCategories: [] },
		plotiphar: {},
		settings: { hourFormatThreshold: 'over60Minutes', ...settings },
		waypoints: [],
		schedules: { entries: [], nextId: null },
	}
}

function setup(settings, reply = {}) {
	const state = new ModuleState(() => NOW)
	state.applyState(snapshot(settings))
	const calls = []
	const api = Object.create(ControlApi.prototype)
	api.send = async (method, path, body) => {
		calls.push({ method, path, body })
		if (reply instanceof Error) throw reply
		return reply
	}
	const deps = { api, state, log: () => {}, refresh: () => {} }
	return { state, calls, actions: getActionDefinitions(deps) }
}

const ctx = { parseVariablesInString: async (s) => s }

function type(actions, text) {
	return Promise.all([...text].map((key) => actions.timerEntryAppend.callback({ options: { key } }, ctx)))
}

describe('parseClock (TimerInputParser.parseClock)', () => {
	test('digits without a colon: up to two are the hour, the last two of three or four are minutes', () => {
		assert.deepEqual(parseClock('7'), { hour: 7, minute: 0 })
		assert.deepEqual(parseClock('14'), { hour: 14, minute: 0 })
		assert.deepEqual(parseClock('930'), { hour: 9, minute: 30 })
		assert.deepEqual(parseClock('1430'), { hour: 14, minute: 30 })
		assert.deepEqual(parseClock('0005'), { hour: 0, minute: 5 })
	})

	test('a colon splits hour and minutes', () => {
		assert.deepEqual(parseClock('9:30'), { hour: 9, minute: 30 })
		assert.deepEqual(parseClock('9:'), { hour: 9, minute: 0 })
		assert.deepEqual(parseClock('7:5'), { hour: 7, minute: 5 })
	})

	test('out-of-range and malformed input is rejected', () => {
		for (const raw of ['', '24', '2400', '1260', '12345', ':30', '9:300', '9:3:0', '1h']) {
			assert.equal(parseClock(raw), null, raw)
		}
	})
})

describe('parseEndAt', () => {
	test('without AM/PM the hour is 24-hour', () => {
		assert.deepEqual(parseEndAt('1430', null), { kind: 'endAt', hour: 14, minute: 30 })
		assert.deepEqual(parseEndAt('0', null), { kind: 'endAt', hour: 0, minute: 0 })
	})

	test('with AM/PM the hour must be 1-12', () => {
		assert.deepEqual(parseEndAt('230', 'pm'), { kind: 'endAt', hour: 14, minute: 30 })
		assert.deepEqual(parseEndAt('12', 'am'), { kind: 'endAt', hour: 0, minute: 0 })
		assert.deepEqual(parseEndAt('12', 'pm'), { kind: 'endAt', hour: 12, minute: 0 })
		assert.deepEqual(parseEndAt('1145', 'am'), { kind: 'endAt', hour: 11, minute: 45 })
		assert.equal(parseEndAt('13', 'pm'), null)
		assert.equal(parseEndAt('0', 'am'), null)
	})

	test('endAtTimeText pads to HH:mm', () => {
		assert.equal(endAtTimeText({ hour: 7, minute: 5 }), '07:05')
	})
})

describe('secondsUntilClockTime (next occurrence)', () => {
	test('a time later today counts down to it', () => {
		assert.equal(secondsUntilClockTime(15, 30, NOW, EDT), 5400)
	})

	test('a time that has passed today means tomorrow', () => {
		assert.equal(secondsUntilClockTime(13, 0, NOW, EDT), 23 * 3600)
		assert.equal(secondsUntilClockTime(7, 0, Date.UTC(2026, 9, 19, 1, 0), EDT), 10 * 3600)
	})

	test('right now is zero', () => {
		assert.equal(secondsUntilClockTime(14, 0, NOW, EDT), 0)
	})
})

describe('End @ on the keypad', () => {
	test('switching End @ either way empties the entry and the AM/PM choice', async () => {
		const { state, actions } = setup()
		await type(actions, '45')
		await actions.timerEntryEndAt.callback({ options: { mode: 'toggle' } }, ctx)
		assert.equal(state.timerEntryEndAt, true)
		assert.equal(state.timerEntryBuffer, '')
		await type(actions, '3')
		await actions.timerEntryMeridiem.callback({ options: { meridiem: 'pm' } }, ctx)
		await actions.timerEntryEndAt.callback({ options: { mode: 'toggle' } }, ctx)
		assert.equal(state.timerEntryEndAt, false)
		assert.equal(state.timerEntryBuffer, '')
		assert.equal(state.timerEntryMeridiem, null)
	})

	test('in End @ the h/m/s and sign keys do nothing, digits and colon type', async () => {
		const { state, actions } = setup()
		await actions.timerEntryEndAt.callback({ options: { mode: 'on' } }, ctx)
		await type(actions, '3h:m30s')
		await actions.timerEntrySign.callback({ options: { sign: '+' } }, ctx)
		assert.equal(state.timerEntryBuffer, '3:30')
		assert.equal(state.timerEntrySign, null)
	})

	test('AM/PM toggles only in End @, and pressing the picked one clears it', async () => {
		const { state, actions } = setup()
		await actions.timerEntryMeridiem.callback({ options: { meridiem: 'am' } }, ctx)
		assert.equal(state.timerEntryMeridiem, null)
		await actions.timerEntryEndAt.callback({ options: { mode: 'on' } }, ctx)
		await actions.timerEntryMeridiem.callback({ options: { meridiem: 'am' } }, ctx)
		assert.equal(state.timerEntryMeridiem, 'am')
		await actions.timerEntryMeridiem.callback({ options: { meridiem: 'pm' } }, ctx)
		assert.equal(state.timerEntryMeridiem, 'pm')
		await actions.timerEntryMeridiem.callback({ options: { meridiem: 'pm' } }, ctx)
		assert.equal(state.timerEntryMeridiem, null)
	})

	test('the preview shows the target in the clock format and the remaining time', async () => {
		const { state, actions } = setup({ clockFormat: 'twelveHour' })
		await actions.timerEntryEndAt.callback({ options: { mode: 'on' } }, ctx)
		assert.equal(state.timerEntryPreview, 'End @')
		await type(actions, '330')
		await actions.timerEntryMeridiem.callback({ options: { meridiem: 'pm' } }, ctx)
		assert.equal(state.timerEntryPreview, 'End @ 3:30 PM\n→ 1:30:00 remaining')
		const values = getVariableValues(state)
		assert.equal(values.timer_entry_result, '1:30:00')
		assert.equal(values.timer_entry_result_seconds, 5400)
		assert.equal(values.timer_entry_end_at, 'yes')
	})

	test('24-hour clock format, and a passed time means tomorrow', async () => {
		const { state, actions } = setup({ clockFormat: 'twentyFourHour' })
		await actions.timerEntryEndAt.callback({ options: { mode: 'on' } }, ctx)
		await type(actions, '1300')
		assert.equal(state.timerEntryPreview, 'End @ 13:00\n→ 23:00:00 remaining')
	})

	test('an hour outside 1-12 with AM/PM is not committable', async () => {
		const { state, actions } = setup()
		await actions.timerEntryEndAt.callback({ options: { mode: 'on' } }, ctx)
		await type(actions, '1430')
		assert.notEqual(state.timerEntryAction, null)
		await actions.timerEntryMeridiem.callback({ options: { meridiem: 'pm' } }, ctx)
		assert.equal(state.timerEntryAction, null)
		assert.equal(getFeedbackDefinitions(state).timerEntryCommittable.callback({ options: {} }), false)
	})

	test('Enter sends End At with HH:mm and leaves End @', async () => {
		const { state, actions, calls } = setup()
		await actions.timerEntryEndAt.callback({ options: { mode: 'on' } }, ctx)
		await type(actions, '930')
		await actions.timerEntryMeridiem.callback({ options: { meridiem: 'pm' } }, ctx)
		await actions.timerEntryCommit.callback({ options: {} }, ctx)
		assert.deepEqual(calls, [{ method: 'POST', path: '/timer/end-at', body: { time: '21:30' } }])
		assert.equal(state.timerEntryEndAt, false)
		assert.equal(state.timerEntryBuffer, '')
	})

	test('a failed End At keeps the entry and explains it', async () => {
		const busy = setup({}, new ApiError(409, 'No active item'))
		await busy.actions.timerEntryEndAt.callback({ options: { mode: 'on' } }, ctx)
		await type(busy.actions, '1530')
		await busy.actions.timerEntryCommit.callback({ options: {} }, ctx)
		assert.equal(busy.state.timerEntryEndAt, true)
		assert.equal(busy.state.timerEntryBuffer, '1530')
		assert.equal(busy.state.currentActionError, 'There is no active item to set an end time on.')

		const older = setup({}, new ApiError(404, 'Unknown path'))
		await older.actions.timerEntryEndAt.callback({ options: { mode: 'on' } }, ctx)
		await type(older.actions, '1530')
		await older.actions.timerEntryCommit.callback({ options: {} }, ctx)
		assert.match(older.state.currentActionError, /1\.6\.0/)
	})

	test('Enter with nothing valid sends nothing and leaves End @', async () => {
		const { state, actions, calls } = setup()
		await actions.timerEntryEndAt.callback({ options: { mode: 'on' } }, ctx)
		await type(actions, '99')
		await actions.timerEntryCommit.callback({ options: {} }, ctx)
		assert.equal(calls.length, 0)
		assert.equal(state.timerEntryEndAt, false)
	})

	test('Clear keeps End @, as the app keypad does', async () => {
		const { state, actions } = setup()
		await actions.timerEntryEndAt.callback({ options: { mode: 'on' } }, ctx)
		await type(actions, '12')
		await actions.timerEntryClear.callback({ options: {} }, ctx)
		assert.equal(state.timerEntryBuffer, '')
		assert.equal(state.timerEntryEndAt, true)
	})

	test('normal entry is unchanged outside End @', async () => {
		const { calls, actions } = setup()
		await type(actions, '130')
		await actions.timerEntryCommit.callback({ options: {} }, ctx)
		assert.deepEqual(calls, [{ method: 'POST', path: '/timer/remaining', body: { input: '130' } }])
	})

	test('feedbacks and presets: End @ key, and −/+ turn into AM/PM', () => {
		const state = new ModuleState(() => NOW)
		state.applyState(snapshot())
		state.setTimerEntryEndAt(true)
		state.setTimerEntryMeridiem('am')
		const feedbacks = getFeedbackDefinitions(state)
		assert.equal(feedbacks.timerEntryEndAt.callback({ options: {} }), true)
		assert.equal(feedbacks.timerEntryMeridiemIs.callback({ options: { meridiem: 'am' } }), true)
		assert.equal(feedbacks.timerEntryMeridiemIs.callback({ options: { meridiem: 'pm' } }), false)

		const presets = getPresetDefinitions(state)
		assert.equal(presets.timer_entry_key_end_at.steps[0].down[0].actionId, 'timerEntryEndAt')
		const minus = presets.timer_entry_key_minus
		assert.deepEqual(
			minus.steps[0].down.map((a) => a.actionId),
			['timerEntrySign', 'timerEntryMeridiem'],
		)
		assert.deepEqual(
			minus.feedbacks.map((f) => f.feedbackId),
			['timerEntrySignIs', 'timerEntryEndAt', 'timerEntryMeridiemIs'],
		)
		assert.ok(minus.feedbacks[1].style.png64)
	})
})
