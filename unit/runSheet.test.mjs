import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

const { ModuleState, formatClockParts } = await import('../dist/state.js')
const { ControlApi, ApiError } = await import('../dist/api.js')
const { getActionDefinitions } = await import('../dist/actions.js')
const { getFeedbackDefinitions } = await import('../dist/feedbacks.js')
const { getVariableDefinitions, getVariableValues } = await import('../dist/variables.js')
const { getPresetDefinitions } = await import('../dist/presets.js')
const { itemKeyText, itemBpmText, itemLeaderText, itemMusicLine, itemSequenceText } =
	await import('../dist/itemDetails.js')

function item(id, overrides = {}) {
	return {
		id,
		title: id.toUpperCase(),
		itemType: 'Item',
		sequence: 1,
		lengthInSeconds: 300,
		elapsedSeconds: 0,
		isRunning: false,
		servicePlanTitle: null,
		notes: {},
		noteIds: {},
		pcoServiceTypeId: null,
		pcoPlanId: null,
		isDurationActual: false,
		...overrides,
	}
}

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

const song = item('song', {
	itemType: 'Song',
	details: {
		servicePosition: 'during',
		keyName: 'G',
		key: { id: 'k', name: 'G', startingKey: 'A' },
		arrangement: { id: 'a', name: 'Default', bpm: 72, meter: '4/4', sequenceShort: ['V1', 'C', 'V2'] },
		customSequenceShort: [],
		leaders: [
			{ personId: '1', name: 'Sam Smith', firstName: 'Sam' },
			{ personId: '2', name: 'Pat Jones', firstName: 'Pat' },
		],
		itemTimes: [],
	},
})

function planOf(items, activeItemIndex = 0) {
	return { title: 'Sunday', items, activeItemIndex, isAtEndOfPlan: false, canLoadNextService: false }
}

function timerFor(active, extra = {}) {
	return {
		item: active,
		index: 0,
		isRunning: false,
		remainingSeconds: active.lengthInSeconds,
		isOvertime: false,
		formattedRemaining: '05:00',
		isDurationActualForDisplay: false,
		...extra,
	}
}

function stateWith(snapshot) {
	const state = new ModuleState()
	state.applyState(snapshot)
	return state
}

function setup(snapshot, reply = {}) {
	const state = stateWith(snapshot)
	const calls = []
	const api = Object.create(ControlApi.prototype)
	api.send = async (method, path, body) => {
		calls.push({ method, path, body })
		if (reply instanceof Error) throw reply
		return typeof reply === 'function' ? reply(method, path, body) : reply
	}
	const logs = []
	const deps = { api, state, log: (level, message) => logs.push({ level, message }), refresh: () => {} }
	return { state, calls, logs, actions: getActionDefinitions(deps) }
}

const ctx = { parseVariablesInString: async (s) => s }

describe('clock format', () => {
	test('formatClockParts follows the format, and 24-hour is the fallback', () => {
		assert.equal(formatClockParts(14, 5, null, 'twelveHour'), '2:05 PM')
		assert.equal(formatClockParts(0, 0, null, 'twelveHour'), '12:00 AM')
		assert.equal(formatClockParts(12, 30, 9, 'twelveHour'), '12:30:09 PM')
		assert.equal(formatClockParts(14, 5, null, 'twentyFourHour'), '14:05')
		assert.equal(formatClockParts(9, 5, 3, null), '09:05:03')
	})

	test('settings_clock_format reads the Producer, blank on an older one', () => {
		const newer = stateWith(baseSnapshot({ settings: { hourFormatThreshold: 'never', clockFormat: 'twelveHour' } }))
		assert.equal(newer.clockFormat, 'twelveHour')
		assert.equal(getVariableValues(newer).settings_clock_format, 'twelveHour')
		const older = stateWith(baseSnapshot({ settings: { hourFormatThreshold: 'never' } }))
		assert.equal(older.clockFormat, null)
		assert.equal(getVariableValues(older).settings_clock_format, '')
		const empty = stateWith(baseSnapshot({ settings: { hourFormatThreshold: 'never', clockFormat: '' } }))
		assert.equal(empty.clockFormat, null)
	})

	test('times of day use the producer UTC offset and its clock format', () => {
		const state = stateWith(baseSnapshot({ utcOffsetSeconds: -4 * 3600, settings: { clockFormat: 'twelveHour' } }))
		assert.equal(state.formatClockMs(Date.UTC(2026, 9, 18, 18, 30, 0)), '2:30 PM')
		assert.equal(state.formatClockMs(Date.UTC(2026, 9, 18, 18, 30, 7), true), '2:30:07 PM')
	})

	test('next_item_starts_at formats nextStartsAtMs only when the Producer sends it', () => {
		const next = item('b')
		const state = stateWith(
			baseSnapshot({
				utcOffsetSeconds: 0,
				settings: { clockFormat: 'twentyFourHour' },
				plan: planOf([item('a'), next]),
				timer: timerFor(item('a'), { nextItem: next, nextStartsAtMs: Date.UTC(2026, 9, 18, 10, 15) }),
			}),
		)
		assert.equal(getVariableValues(state).next_item_starts_at, '10:15')
		const without = stateWith(baseSnapshot({ plan: planOf([item('a'), next]), timer: timerFor(item('a')) }))
		assert.equal(getVariableValues(without).next_item_starts_at, '')
	})

	test('Set Clock Format toggle flips the current setting', async () => {
		const { actions, calls } = setup(baseSnapshot({ settings: { clockFormat: 'twelveHour' } }), {
			clockFormat: 'twentyFourHour',
		})
		await actions.setClockFormat.callback({ options: { format: 'toggle' } }, ctx)
		assert.deepEqual(calls, [{ method: 'PATCH', path: '/settings', body: { clockFormat: 'twentyFourHour' } }])
	})

	test('Set Clock Format toggle on an older Producer warns and sends nothing', async () => {
		const { actions, calls, logs } = setup(baseSnapshot({ settings: { hourFormatThreshold: 'never' } }))
		await actions.setClockFormat.callback({ options: { format: 'toggle' } }, ctx)
		assert.equal(calls.length, 0)
		assert.match(logs[0].message, /1\.7\.0/)
	})

	test('Set Clock Format warns when the reply has no clock format', async () => {
		const { actions, calls, logs } = setup(baseSnapshot(), { hourFormatThreshold: 'never' })
		await actions.setClockFormat.callback({ options: { format: 'twelveHour' } }, ctx)
		assert.deepEqual(calls[0].body, { clockFormat: 'twelveHour' })
		assert.equal(logs[0].level, 'warn')
	})

	test('Update Settings sends only the hour format threshold', async () => {
		const { actions, calls } = setup(baseSnapshot())
		await actions.updateSettings.callback({ options: { hourFormatThreshold: 'never' } }, ctx)
		assert.deepEqual(calls[0].body, { hourFormatThreshold: 'never' })
	})

	test('Update Role passes a clock format override, or default to clear it, and leaves it alone otherwise', async () => {
		const { actions, calls } = setup(baseSnapshot())
		await actions.updateRole.callback({ options: { roleId: 'r1', clockFormat: 'twentyFourHour' } }, ctx)
		await actions.updateRole.callback({ options: { roleId: 'r1', clockFormat: 'default' } }, ctx)
		await actions.updateRole.callback({ options: { roleId: 'r1', clockFormat: '' } }, ctx)
		await actions.updateRole.callback({ options: { roleId: 'r1' } }, ctx)
		assert.deepEqual(
			calls.map((c) => c.body),
			[{ clockFormat: 'twentyFourHour' }, { clockFormat: 'default' }, {}, {}],
		)
	})

	test('Clock Format Is feedback', () => {
		const state = stateWith(baseSnapshot({ settings: { clockFormat: 'twentyFourHour' } }))
		const feedbacks = getFeedbackDefinitions(state)
		assert.equal(feedbacks.clockFormatIs.callback({ options: { format: 'twentyFourHour' } }), true)
		assert.equal(feedbacks.clockFormatIs.callback({ options: { format: 'twelveHour' } }), false)
	})
})

describe('skips, rehearsal and actuals', () => {
	const eventTimes = {
		entries: [
			{ id: 't-1', displayName: 'Sunday 9:00 AM', pcoPlanTimeId: 'pt-1' },
			{ id: 't-2', displayName: 'Sunday 11:00 AM', pcoPlanTimeId: 'pt-2' },
		],
		liveId: 't-1',
		nextId: 't-2',
	}

	test('the skips key follows the live event time, adhoc without one, rehearsal while rehearsing', () => {
		const liveOps = { isRehearsalMode: false, actuals: [], skippedItemIds: {} }
		assert.equal(stateWith(baseSnapshot({ eventTimes, liveOps })).skipsKey, 't-1')
		assert.equal(stateWith(baseSnapshot({ liveOps })).skipsKey, 'adhoc')
		assert.equal(
			stateWith(baseSnapshot({ eventTimes, liveOps: { ...liveOps, isRehearsalMode: true } })).skipsKey,
			'rehearsal',
		)
	})

	test('a Producer without liveOps reports nothing skipped, no rehearsal and no actuals', () => {
		const state = stateWith(baseSnapshot({ plan: planOf([item('a'), item('b')]) }))
		const values = getVariableValues(state)
		assert.equal(state.liveOps, null)
		assert.equal(values.skipped_count, 0)
		assert.equal(values.rehearsal_mode, 'no')
		assert.equal(values.actuals_logging, 'no')
		assert.equal(values.actual_over_under, '')
		assert.equal(state.nextPlanItem().id, 'b')
	})

	test('next item prefers timer.nextItem, including null at the end', () => {
		const items = [item('a'), item('b'), item('c')]
		const state = stateWith(baseSnapshot({ plan: planOf(items), timer: timerFor(items[0], { nextItem: items[2] }) }))
		assert.equal(state.nextPlanItem().id, 'c')
		const atEnd = stateWith(baseSnapshot({ plan: planOf(items), timer: timerFor(items[0], { nextItem: null }) }))
		assert.equal(atEnd.nextPlanItem(), undefined)
	})

	test('without timer.nextItem the next item passes over headers, skipped and excluded items', () => {
		const items = [
			item('a'),
			item('h', { itemType: 'header' }),
			item('s'),
			item('x', { details: { itemTimes: [{ id: 'it', planTimeId: 'pt-1', exclude: true }] } }),
			item('d'),
		]
		const state = stateWith(
			baseSnapshot({
				eventTimes,
				plan: planOf(items),
				liveOps: { isRehearsalMode: false, actuals: [], skippedItemIds: { 't-1': ['s'], 't-2': ['d'] } },
			}),
		)
		assert.equal(state.nextPlanItem().id, 'd')
		assert.equal(state.isItemSkipped('s'), true)
		assert.equal(state.isItemSkipped('d'), false)
		assert.equal(state.isItemExcluded(items[3]), true)
	})

	test('time remaining leaves out skipped and excluded items', () => {
		const items = [
			item('a', { lengthInSeconds: 100 }),
			item('b', { lengthInSeconds: 200 }),
			item('c', { lengthInSeconds: 400, details: { itemTimes: [{ id: 'it', planTimeId: 'pt-1', exclude: true }] } }),
			item('d', { lengthInSeconds: 800 }),
		]
		const state = stateWith(
			baseSnapshot({
				eventTimes,
				plan: planOf(items),
				timer: timerFor(items[0], { remainingSeconds: 100 }),
				liveOps: { isRehearsalMode: false, actuals: [], skippedItemIds: { 't-1': ['b'] } },
			}),
		)
		assert.equal(state.serviceRemainingSeconds, 100 + 800)
	})

	test('rundown rows and the skipped feedbacks', () => {
		const items = [item('a'), item('b')]
		const state = stateWith(
			baseSnapshot({
				plan: planOf(items),
				timer: timerFor(items[0]),
				liveOps: { isRehearsalMode: false, actuals: [], skippedItemIds: { adhoc: ['b'] } },
			}),
		)
		const feedbacks = getFeedbackDefinitions(state)
		assert.equal(feedbacks.rundownRowSkipped.callback({ options: { rowIndex: 1 } }), false)
		assert.equal(feedbacks.rundownRowSkipped.callback({ options: { rowIndex: 2 } }), true)
		assert.equal(feedbacks.planItemSkipped.callback({ options: { itemId: 'b' } }), true)
		assert.equal(feedbacks.planItemSkipped.callback({ options: { itemId: '' } }), false)
		assert.equal(getVariableValues(state).skipped_count, 1)
	})

	test('Skip / Unskip Item resolves next, live and specific targets, and toggles from state', async () => {
		const items = [item('a'), item('b'), item('c')]
		const { actions, calls } = setup(
			baseSnapshot({
				plan: planOf(items),
				timer: timerFor(items[0], { nextItem: items[1] }),
				liveOps: { isRehearsalMode: false, actuals: [], skippedItemIds: { adhoc: ['c'] } },
			}),
		)
		await actions.planSkipItem.callback({ options: { target: 'next', mode: 'skip' } }, ctx)
		await actions.planSkipItem.callback({ options: { target: 'live', mode: 'toggle' } }, ctx)
		await actions.planSkipItem.callback({ options: { target: 'item', itemId: 'c', mode: 'toggle' } }, ctx)
		assert.deepEqual(calls, [
			{ method: 'POST', path: '/plan/items/b/skip', body: { skipped: true } },
			{ method: 'POST', path: '/plan/items/a/skip', body: { skipped: true } },
			{ method: 'POST', path: '/plan/items/c/skip', body: { skipped: false } },
		])
	})

	test('Skip / Unskip Item explains an older Producer and an unknown item', async () => {
		const older = setup(
			baseSnapshot({ plan: planOf([item('a')]), timer: timerFor(item('a')) }),
			new ApiError(404, 'Unknown path'),
		)
		await older.actions.planSkipItem.callback({ options: { target: 'live', mode: 'skip' } }, ctx)
		assert.match(older.state.currentActionError, /1\.7\.0/)
		const unknown = setup(baseSnapshot(), new ApiError(404, 'Unknown plan item id', 'zz'))
		await unknown.actions.planSkipItem.callback({ options: { target: 'item', itemId: 'zz', mode: 'skip' } }, ctx)
		assert.match(unknown.state.currentActionError, /not in the plan/)
	})

	test('Skip / Unskip Item warns when there is no next item', async () => {
		const { actions, calls, logs } = setup(
			baseSnapshot({ plan: planOf([item('a')]), timer: timerFor(item('a'), { nextItem: null }) }),
		)
		await actions.planSkipItem.callback({ options: { target: 'next', mode: 'skip' } }, ctx)
		assert.equal(calls.length, 0)
		assert.equal(logs[0].level, 'warn')
	})

	test('Rehearsal Mode toggles from state and sends a rehearsal time only when turning on', async () => {
		const liveOps = { isRehearsalMode: false, actuals: [], skippedItemIds: {} }
		const off = setup(baseSnapshot({ liveOps }))
		await off.actions.rehearsalMode.callback({ options: { mode: 'toggle', planTimeId: 'r-1' } }, ctx)
		await off.actions.rehearsalMode.callback({ options: { mode: 'on', planTimeId: '' } }, ctx)
		await off.actions.rehearsalMode.callback({ options: { mode: 'off', planTimeId: 'r-1' } }, ctx)
		assert.deepEqual(off.calls, [
			{ method: 'PUT', path: '/rehearsal', body: { enabled: true, planTimeId: 'r-1' } },
			{ method: 'PUT', path: '/rehearsal', body: { enabled: true } },
			{ method: 'PUT', path: '/rehearsal', body: { enabled: false } },
		])
		const on = setup(baseSnapshot({ liveOps: { ...liveOps, isRehearsalMode: true } }))
		await on.actions.rehearsalMode.callback({ options: { mode: 'toggle', planTimeId: 'r-1' } }, ctx)
		assert.deepEqual(on.calls[0].body, { enabled: false })
	})

	test('rehearsal variables, choices and feedback come from the plan context times', () => {
		const state = stateWith(
			baseSnapshot({
				utcOffsetSeconds: 0,
				settings: { clockFormat: 'twelveHour' },
				pco: {
					serviceTypes: [],
					plans: [],
					noteCategories: [],
					planContext: {
						times: [
							{ id: 'pt-1', name: '9 AM', timeType: 'service' },
							{ id: 'r-1', name: 'Run-through', timeType: 'rehearsal' },
							{ id: 'r-2', name: '', timeType: 'rehearsal', startsAt: '2026-10-17T19:00:00Z' },
						],
					},
				},
				liveOps: { isRehearsalMode: true, rehearsalPlanTimeId: 'r-2', actuals: [], skippedItemIds: {} },
			}),
		)
		assert.deepEqual(state.rehearsalTimeChoices(), [
			{ id: 'r-1', label: 'Run-through' },
			{ id: 'r-2', label: '7:00 PM' },
		])
		const values = getVariableValues(state)
		assert.equal(values.rehearsal_mode, 'yes')
		assert.equal(values.rehearsal_time, '7:00 PM')
		assert.equal(values.actuals_logging, 'no')
		assert.equal(getFeedbackDefinitions(state).rehearsalMode.callback({ options: {} }), true)
		const choices = getActionDefinitions({ state, api: {}, log: () => {}, refresh: () => {} }).rehearsalMode.options[1]
			.choices
		assert.deepEqual(
			choices.map((c) => c.id),
			['', 'r-1', 'r-2'],
		)
	})

	test('actual vs. planned sums finished items of the live event time only', () => {
		const items = [item('a', { lengthInSeconds: 300 }), item('b', { lengthInSeconds: 120 }), item('c')]
		const state = stateWith(
			baseSnapshot({
				eventTimes,
				plan: planOf(items, 2),
				settings: { hourFormatThreshold: 'never' },
				liveOps: {
					isRehearsalMode: false,
					actualsEventTimeId: 't-1',
					actuals: [
						{ itemId: 'a', eventTimeId: 't-1', startedAt: 'x', endedAt: 'y', lengthSeconds: 330 },
						{ itemId: 'b', eventTimeId: 't-1', startedAt: 'x', endedAt: 'y', lengthSeconds: 100 },
						{ itemId: 'c', eventTimeId: 't-1', startedAt: 'x', lengthSeconds: 40 },
						{ itemId: 'a', eventTimeId: 't-2', startedAt: 'x', endedAt: 'y', lengthSeconds: 900 },
						{ itemId: 'gone', eventTimeId: 't-1', startedAt: 'x', endedAt: 'y', lengthSeconds: 900 },
					],
					skippedItemIds: {},
				},
			}),
		)
		const values = getVariableValues(state)
		assert.equal(state.actualOverUnderSeconds, 10)
		assert.equal(values.actual_over_under, '+00:10')
		assert.equal(values.actuals_count, 3)
		assert.equal(values.actuals_logging, 'yes')
	})

	test('Save Actual Lengths posts and explains a 409', async () => {
		const ok = setup(baseSnapshot(), { count: 3 })
		await ok.actions.actualsSaveToPco.callback({ options: {} }, ctx)
		assert.deepEqual(ok.calls, [{ method: 'POST', path: '/plan/actuals/save-to-pco', body: undefined }])
		const none = setup(baseSnapshot(), new ApiError(409, 'No actual lengths to save'))
		await none.actions.actualsSaveToPco.callback({ options: {} }, ctx)
		assert.equal(none.state.currentActionError, 'Nothing saved: No actual lengths to save.')
	})
})

describe('item details', () => {
	test('key, BPM, sequence and leaders read like the pager details line', () => {
		assert.equal(itemKeyText(song), 'A')
		assert.equal(itemBpmText(song), '72')
		assert.equal(itemSequenceText(song), 'V1 C V2')
		assert.equal(itemLeaderText(song), 'Sam & Pat')
		assert.equal(itemMusicLine(song), 'A · 72 BPM · 4/4')
	})

	test('custom sequence wins, fractional BPM keeps one decimal, three leaders collapse', () => {
		const custom = item('x', {
			details: {
				keyName: 'D',
				arrangement: { id: 'a', bpm: 68.5, sequenceShort: ['V1'] },
				customSequenceShort: ['I', 'C'],
				leaders: [
					{ name: 'A', firstName: 'Ann' },
					{ name: 'B', firstName: 'Bo' },
					{ name: 'C', firstName: 'Cy' },
				],
			},
		})
		assert.equal(itemKeyText(custom), 'D')
		assert.equal(itemBpmText(custom), '68.5')
		assert.equal(itemSequenceText(custom), 'I C')
		assert.equal(itemLeaderText(custom), 'Ann + 2')
		assert.equal(itemMusicLine(custom), 'D · 68.5 BPM')
	})

	test('items without details, and headers, give blanks', () => {
		assert.equal(itemMusicLine(item('plain')), '')
		assert.equal(itemKeyText(item('h', { itemType: 'Header', details: song.details })), '')
		assert.equal(itemLeaderText(undefined), '')
	})

	test('active and next item detail variables', () => {
		const next = item('next', { details: { keyName: 'E', leaders: [] } })
		const state = stateWith(baseSnapshot({ plan: planOf([song, next]), timer: timerFor(song, { nextItem: next }) }))
		const values = getVariableValues(state)
		assert.equal(values.active_item_key, 'A')
		assert.equal(values.active_item_bpm, '72')
		assert.equal(values.active_item_meter, '4/4')
		assert.equal(values.active_item_arrangement, 'Default')
		assert.equal(values.active_item_leader, 'Sam & Pat')
		assert.equal(values.next_item_key, 'E')
		assert.equal(values.next_item_music, 'E')
		const ids = new Set(getVariableDefinitions(state).map((d) => d.variableId))
		for (const id of Object.keys(values)) assert.ok(ids.has(id), `${id} has a definition`)
	})
})

describe('presets', () => {
	test('every new preset refers to actions and feedbacks that exist', () => {
		const state = stateWith(baseSnapshot({ plan: planOf([item('a')]) }))
		const presets = getPresetDefinitions(state)
		const actions = getActionDefinitions({ state, api: {}, log: () => {}, refresh: () => {} })
		const feedbacks = getFeedbackDefinitions(state)
		for (const key of [
			'run_sheet_skip_next',
			'run_sheet_skip_live',
			'run_sheet_rehearsal',
			'run_sheet_actuals',
			'run_sheet_live_music',
			'clock_producer',
			'clock_format_12',
			'clock_format_24',
			'pco_save_actuals',
		]) {
			const preset = presets[key]
			assert.ok(preset, key)
			for (const step of preset.steps) for (const a of step.down) assert.ok(actions[a.actionId], a.actionId)
			for (const f of preset.feedbacks) assert.ok(feedbacks[f.feedbackId], f.feedbackId)
		}
	})
})

describe('event-named variables', () => {
	test('event_ variables and their deprecated service_ aliases carry the same values', () => {
		const items = [item('a', { lengthInSeconds: 100 }), item('b', { lengthInSeconds: 200 })]
		const state = stateWith(
			baseSnapshot({
				plan: planOf(items),
				settings: { hourFormatThreshold: 'never' },
				timer: timerFor(items[0], { remainingSeconds: 100 }),
			}),
		)
		const values = getVariableValues(state)
		assert.equal(values.event_remaining_total, '05:00')
		assert.equal(values.service_remaining_total, values.event_remaining_total)
		assert.equal(values.service_over_under, values.event_over_under)
		const names = new Map(getVariableDefinitions(state).map((d) => [d.variableId, d.name]))
		for (const id of ['event_remaining_total', 'event_over_under']) assert.doesNotMatch(names.get(id), /Deprecated/)
		for (const id of ['service_remaining_total', 'service_over_under']) assert.match(names.get(id), /\(Deprecated\)$/)
	})

	test('timing presets use the event_ variables', () => {
		const presets = getPresetDefinitions(stateWith(baseSnapshot()))
		assert.match(presets.timing_event_remaining.style.text, /event_remaining_total/)
		assert.match(presets.timing_event_over_under.style.text, /event_over_under/)
		const text = JSON.stringify(presets)
		assert.doesNotMatch(text, /service_remaining_total|service_over_under/)
	})
})
