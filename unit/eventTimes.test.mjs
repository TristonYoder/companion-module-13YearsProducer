import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

const { normalizeClockTime } = await import('../dist/timerEntry.js')
const { ModuleState } = await import('../dist/state.js')
const { ControlApi } = await import('../dist/api.js')
const { getActionDefinitions } = await import('../dist/actions.js')
const { getFeedbackDefinitions } = await import('../dist/feedbacks.js')
const { getVariableValues } = await import('../dist/variables.js')

function baseSnapshot(overrides = {}) {
	return {
		appMode: 'PRODUCER_CONTROL',
		network: {},
		roles: [],
		selectedRoleIds: [],
		timer: null,
		plan: { title: null, items: [], activeItemIndex: 0, isAtEndOfPlan: false },
		messages: [],
		pco: { serviceTypes: [], plans: [], noteCategories: [] },
		plotiphar: {},
		settings: {},
		waypoints: [],
		schedules: { entries: [], nextId: null },
		...overrides,
	}
}

const eventTimes = {
	entries: [
		{ id: 'a', displayName: 'Sunday 9:00 AM', startTime: '09:00', day: 'sunday' },
		{ id: 'b', displayName: 'Sunday 11:00 AM', startTime: '11:00', day: 'sunday' },
	],
	liveId: 'a',
	nextId: 'b',
}

function stateWith(snapshot) {
	const state = new ModuleState()
	state.applyState(snapshot)
	return state
}

function fakeApi() {
	const calls = []
	const api = Object.create(ControlApi.prototype)
	api.send = async (method, path, body) => {
		calls.push({ method, path, body })
		return {}
	}
	return { api, calls }
}

function setup(snapshot) {
	const state = stateWith(snapshot)
	const { api, calls } = fakeApi()
	const logs = []
	const deps = { api, state, log: (level, message) => logs.push({ level, message }), refresh: () => {} }
	return { state, calls, logs, actions: getActionDefinitions(deps), deps }
}

const ctx = { parseVariablesInString: async (s) => s }

describe('normalizeClockTime', () => {
	test('24-hour input is zero-padded', () => {
		assert.equal(normalizeClockTime('14:30'), '14:30')
		assert.equal(normalizeClockTime('9:05'), '09:05')
		assert.equal(normalizeClockTime(' 00:00 '), '00:00')
		assert.equal(normalizeClockTime('23:59'), '23:59')
	})

	test('12-hour input with AM/PM', () => {
		assert.equal(normalizeClockTime('2:30 PM'), '14:30')
		assert.equal(normalizeClockTime('2:30pm'), '14:30')
		assert.equal(normalizeClockTime('9 AM'), '09:00')
		assert.equal(normalizeClockTime('12:00 AM'), '00:00')
		assert.equal(normalizeClockTime('12:15 PM'), '12:15')
		assert.equal(normalizeClockTime('11:59 pm'), '23:59')
	})

	test('rejects bad input', () => {
		for (const bad of ['', 'noon', '24:00', '12:60', '13:00 PM', '0:30 AM', '930', '9', '12:5', '1:2:3', '-1:00']) {
			assert.equal(normalizeClockTime(bad), null, bad)
		}
		assert.equal(normalizeClockTime(undefined), null)
		assert.equal(normalizeClockTime(null), null)
	})
})

describe('event time state', () => {
	test('parses eventTimes', () => {
		const state = stateWith(baseSnapshot({ eventTimes }))
		assert.equal(state.eventTimeEntries.length, 2)
		assert.equal(state.liveEventTime?.displayName, 'Sunday 9:00 AM')
		assert.equal(state.nextEventTime?.id, 'b')
		assert.deepEqual(state.eventTimeChoices(), [
			{ id: 'a', label: 'Sunday 9:00 AM' },
			{ id: 'b', label: 'Sunday 11:00 AM' },
		])
	})

	test('a snapshot without eventTimes is empty, not an error', () => {
		const state = stateWith(baseSnapshot())
		assert.deepEqual(state.eventTimeEntries, [])
		assert.equal(state.liveEventTime, undefined)
		assert.equal(state.nextEventTime, undefined)
		assert.deepEqual(state.eventTimeChoices(), [])
	})

	test('liveId only: no next', () => {
		const state = stateWith(baseSnapshot({ eventTimes: { entries: eventTimes.entries, liveId: 'b' } }))
		assert.equal(state.liveEventTime?.id, 'b')
		assert.equal(state.nextEventTime, undefined)
	})

	test('dynamic signature changes when entries change', () => {
		const before = stateWith(baseSnapshot()).dynamicSignature()
		const after = stateWith(baseSnapshot({ eventTimes })).dynamicSignature()
		assert.notEqual(before, after)
	})

	test('variables', () => {
		const withTimes = getVariableValues(stateWith(baseSnapshot({ eventTimes })))
		assert.equal(withTimes.event_time_live, 'Sunday 9:00 AM')
		assert.equal(withTimes.event_time_next, 'Sunday 11:00 AM')
		assert.equal(withTimes.event_time_count, 2)
		const without = getVariableValues(stateWith(baseSnapshot()))
		assert.equal(without.event_time_live, '')
		assert.equal(without.event_time_next, '')
		assert.equal(without.event_time_count, 0)
	})

	test('hasNextEventTime feedback', () => {
		const run = (snapshot) => getFeedbackDefinitions(stateWith(snapshot)).hasNextEventTime.callback({ options: {} })
		assert.equal(run(baseSnapshot({ eventTimes })), true)
		assert.equal(run(baseSnapshot({ eventTimes: { ...eventTimes, nextId: null } })), false)
		assert.equal(run(baseSnapshot()), false)
	})
})

describe('event time and end-at actions', () => {
	test('dropdown lists entries by display name', () => {
		const { actions } = setup(baseSnapshot({ eventTimes }))
		const opt = actions.eventTimeSetLive.options[0]
		assert.equal(opt.allowCustom, true)
		assert.deepEqual(opt.choices, [
			{ id: 'a', label: 'Sunday 9:00 AM' },
			{ id: 'b', label: 'Sunday 11:00 AM' },
		])
	})

	test('set live posts the id', async () => {
		const { actions, calls } = setup(baseSnapshot({ eventTimes }))
		await actions.eventTimeSetLive.callback({ options: { eventTimeId: 'b' } }, ctx)
		assert.deepEqual(calls, [{ method: 'POST', path: '/event-times/live', body: { id: 'b' } }])
	})

	test('set live with an empty id warns and sends nothing', async () => {
		const { actions, calls, logs } = setup(baseSnapshot())
		await actions.eventTimeSetLive.callback({ options: { eventTimeId: ' ' } }, ctx)
		assert.equal(calls.length, 0)
		assert.equal(logs[0].level, 'warn')
	})

	test('next event time posts with no body', async () => {
		const { actions, calls } = setup(baseSnapshot({ eventTimes }))
		await actions.eventTimeNext.callback({ options: {} }, ctx)
		assert.deepEqual(calls, [{ method: 'POST', path: '/event-times/next', body: undefined }])
	})

	test('end at normalizes before sending', async () => {
		const { actions, calls } = setup(baseSnapshot())
		await actions.timerEndAt.callback({ options: { time: '2:30 PM' } }, ctx)
		await actions.timerEndAt.callback({ options: { time: '9:05' } }, ctx)
		assert.deepEqual(
			calls.map((c) => [c.path, c.body]),
			[
				['/timer/end-at', { time: '14:30' }],
				['/timer/end-at', { time: '09:05' }],
			],
		)
	})

	test('end at with bad input warns and sends nothing', async () => {
		const { actions, calls, logs } = setup(baseSnapshot())
		await actions.timerEndAt.callback({ options: { time: 'soon' } }, ctx)
		assert.equal(calls.length, 0)
		assert.equal(logs.length, 1)
		assert.equal(logs[0].level, 'warn')
	})
})
