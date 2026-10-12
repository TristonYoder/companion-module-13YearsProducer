import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

const { ModuleState, ACTION_ERROR_HOLD_MS, MAX_INDEXED_ROLES, formatMinutesSeconds } = await import('../dist/state.js')
const { getActionDefinitions, startTimerOption, isoWithoutFraction } = await import('../dist/actions.js')
const { getVariableDefinitions, getVariableValues } = await import('../dist/variables.js')
const { getFeedbackDefinitions } = await import('../dist/feedbacks.js')
const { getPresetDefinitions } = await import('../dist/presets.js')
const { ApiError } = await import('../dist/api.js')

function snap(overrides = {}) {
	return {
		rev: 1,
		roles: [],
		selectedRoleIds: [],
		timer: null,
		plan: { title: 'Sunday', items: [], activeItemIndex: 0 },
		messages: [],
		waypoints: [],
		schedules: { entries: [], nextId: null },
		settings: { hourFormatThreshold: 'over90Minutes' },
		...overrides,
	}
}

const role = (id, name, state = 'OFF', extra = {}) => ({ id, name, state, personName: null, ...extra })

function harness({ api = {}, snapshot = snap(), clock } = {}) {
	const state = new ModuleState(clock)
	state.applyState(snapshot)
	const logs = []
	let refreshes = 0
	const defs = getActionDefinitions({
		api,
		state,
		log: (level, message) => logs.push([level, message]),
		refresh: () => refreshes++,
	})
	return { state, defs, logs, refreshes: () => refreshes }
}

describe('startTimer default', () => {
	test('a missing value means true, an explicit one is respected', () => {
		assert.equal(startTimerOption({}), true)
		assert.equal(startTimerOption({ startTimer: undefined }), true)
		assert.equal(startTimerOption({ startTimer: null }), true)
		assert.equal(startTimerOption({ startTimer: true }), true)
		assert.equal(startTimerOption({ startTimer: false }), false)
	})

	test('Plan Next / Previous / Next Waypoint / Go To Waypoint send true for a saved button with no value', async () => {
		const sent = []
		const api = {
			planNext: async (v) => sent.push(['next', v]),
			planPrevious: async (v) => sent.push(['previous', v]),
			waypointNext: async (v) => sent.push(['waypointNext', v]),
			fireWaypoint: async (ref, v) => sent.push(['go', ref, v]),
		}
		const { defs } = harness({ api })
		await defs.planNext.callback({ options: {} }, {})
		await defs.planPrevious.callback({ options: {} }, {})
		await defs.waypointNext.callback({ options: {} }, {})
		await defs.waypointGo.callback({ options: { waypoint: 'sermon' } }, {})
		await defs.planNext.callback({ options: { startTimer: false } }, {})
		assert.deepEqual(sent, [
			['next', true],
			['previous', true],
			['waypointNext', true],
			['go', 'sermon', true],
			['next', false],
		])
	})
})

describe('repeat-ignore window on Plan Next / Previous', () => {
	test('default 0 never ignores', async () => {
		let n = 0
		const { defs } = harness({ api: { planNext: async () => n++ } })
		assert.equal(defs.planNext.options.find((o) => o.id === 'ignoreRepeatMs').default, 0)
		await defs.planNext.callback({ options: {} }, {})
		await defs.planNext.callback({ options: { ignoreRepeatMs: 0 } }, {})
		assert.equal(n, 2)
	})

	test('presses inside the window are dropped; the window runs from the last accepted press', async () => {
		let now = 1000
		const sent = []
		const api = { planNext: async () => sent.push(now), planPrevious: async () => sent.push(`p${now}`) }
		const { defs, logs } = harness({ api, clock: () => now })
		const press = (id) => defs[id].callback({ options: { ignoreRepeatMs: 500 } }, {})
		await press('planNext')
		now = 1400
		await press('planNext')
		now = 1499
		await press('planNext')
		now = 1500
		await press('planNext')
		assert.deepEqual(sent, [1000, 1500])
		assert.equal(logs.length, 0)
	})

	test('Next and Previous have independent windows', async () => {
		let now = 0
		const sent = []
		const api = { planNext: async () => sent.push('n'), planPrevious: async () => sent.push('p') }
		const { defs } = harness({ api, clock: () => now })
		await defs.planNext.callback({ options: { ignoreRepeatMs: 500 } }, {})
		now = 100
		await defs.planPrevious.callback({ options: { ignoreRepeatMs: 500 } }, {})
		assert.deepEqual(sent, ['n', 'p'])
	})
})

describe('action feedback', () => {
	test('a failed press sets last_action_error and actionFailed for 10 s', async () => {
		let now = 5000
		const api = {
			planNext: async () => {
				throw new ApiError(409, 'No plan is loaded')
			},
		}
		const { defs, state, refreshes } = harness({ api, clock: () => now })
		const feedback = getFeedbackDefinitions(state).actionFailed
		assert.equal(feedback.callback({ options: {} }), false)
		assert.equal(getVariableValues(state).last_action_error, '')

		await defs.planNext.callback({ options: {} }, {})
		assert.equal(refreshes(), 1)
		assert.equal(getVariableValues(state).last_action_error, 'No plan is loaded')
		assert.equal(feedback.callback({ options: {} }), true)

		now += ACTION_ERROR_HOLD_MS
		assert.equal(state.actionFailed, true)
		now += 1
		assert.equal(getVariableValues(state).last_action_error, '')
		assert.equal(feedback.callback({ options: {} }), false)
	})

	test('an explained failure shows the explanation; a non-API error shows its message', async () => {
		const api = {
			fireWaypoint: async () => {
				throw new ApiError(409, 'conflict', 'sermon')
			},
			clearAllCues: async () => {
				throw new Error('boom')
			},
		}
		const { defs, state } = harness({ api })
		await defs.waypointGo.callback({ options: { waypoint: 'sermon' } }, {})
		assert.match(state.currentActionError, /"sermon" exists, but nothing/)
		await defs.clearAllCues.callback({ options: {} }, {})
		assert.equal(state.currentActionError, 'boom')
	})

	test('the variable and feedback are defined', () => {
		const state = new ModuleState()
		assert.ok(getVariableDefinitions(state).some((d) => d.variableId === 'last_action_error'))
		assert.equal(getFeedbackDefinitions(state).actionFailed.type, 'boolean')
	})
})

describe('per-role presets', () => {
	const roles = [role('11111111-aaaa', 'Host'), role('22222222-bbbb', 'Band', 'GO')]
	const stateWith = (r) => {
		const state = new ModuleState()
		state.applyState(snap({ roles: r }))
		return state
	}

	test('every role gets a cycle button and Standby / Go / Clear buttons, keyed by role id', () => {
		const presets = getPresetDefinitions(stateWith(roles))
		for (const r of roles) {
			const cycle = presets[`role_cycle_${r.id}`]
			assert.ok(cycle, `cycle for ${r.name}`)
			assert.deepEqual(cycle.steps[0].down, [{ actionId: 'cycleRoleCue', options: { roleId: r.id } }])
			assert.deepEqual(cycle.feedbacks, [{ feedbackId: 'roleCueColor', options: { roleId: r.id } }])
			assert.equal(cycle.style.text, r.name)
			for (const [key, cueState] of [
				['standby', 'STANDBY'],
				['go', 'GO'],
				['off', 'OFF'],
			]) {
				const preset = presets[`role_${key}_${r.id}`]
				assert.deepEqual(preset.steps[0].down, [
					{ actionId: 'fireRoleCue', options: { roleId: r.id, state: cueState } },
				])
				assert.equal(preset.feedbacks[0].feedbackId, 'roleCueIs')
				assert.deepEqual(preset.feedbacks[0].options, { roleId: r.id, state: cueState })
			}
		}
	})

	test('ids are stable under a rename and follow additions and removals', () => {
		const before = Object.keys(getPresetDefinitions(stateWith(roles))).filter((k) => k.startsWith('role_'))
		const renamed = Object.keys(getPresetDefinitions(stateWith([role('11111111-aaaa', 'Emcee'), roles[1]]))).filter(
			(k) => k.startsWith('role_'),
		)
		assert.deepEqual(renamed, before)
		const fewer = Object.keys(getPresetDefinitions(stateWith([roles[0]]))).filter((k) => k.startsWith('role_'))
		assert.equal(fewer.length, 4)
		assert.equal(before.length, 8)
		assert.equal(Object.keys(getPresetDefinitions(stateWith([]))).filter((k) => k.startsWith('role_')).length, 0)
	})

	test('every preset the module defines points at an action and feedback that exists', () => {
		const state = stateWith(roles)
		const presets = getPresetDefinitions(state)
		const actions = getActionDefinitions({ api: {}, state, log: () => {}, refresh: () => {} })
		const feedbacks = getFeedbackDefinitions(state)
		for (const [id, preset] of Object.entries(presets)) {
			for (const step of preset.steps) {
				for (const a of step.down) assert.ok(actions[a.actionId], `${id} → action ${a.actionId}`)
			}
			for (const f of preset.feedbacks) assert.ok(feedbacks[f.feedbackId], `${id} → feedback ${f.feedbackId}`)
		}
	})

	test('the connection health button shows state, protocol and round trip', () => {
		const preset = getPresetDefinitions(stateWith([])).status_connection_health
		assert.match(preset.style.text, /connection_status/)
		assert.match(preset.style.text, /sync_quality/)
		assert.match(preset.style.text, /sync_rtt_ms/)
		assert.deepEqual(
			preset.feedbacks.map((f) => f.feedbackId),
			['connectionLost', 'connectionStale'],
		)
	})
})

describe('roleSelected feedback', () => {
	test('follows the selection', () => {
		const state = new ModuleState()
		state.applyState(snap({ roles: [role('a', 'A'), role('b', 'B')], selectedRoleIds: ['b'] }))
		const feedback = getFeedbackDefinitions(state).roleSelected
		assert.equal(feedback.type, 'boolean')
		assert.equal(feedback.callback({ options: { roleId: 'a' } }), false)
		assert.equal(feedback.callback({ options: { roleId: 'b' } }), true)
	})
})

describe('variables', () => {
	test('index-based role variables sit beside the slug ones and cap at 16', () => {
		const state = new ModuleState()
		const roles = Array.from({ length: 20 }, (_, i) =>
			role(`r${i}`, `Role ${i}`, i === 1 ? 'GO' : 'OFF', { personName: i === 0 ? 'Pat' : null }),
		)
		state.applyState(snap({ roles }))
		const values = getVariableValues(state)
		const ids = new Set(getVariableDefinitions(state).map((d) => d.variableId))
		assert.equal(values.role_1_name, 'Role 0')
		assert.equal(values.role_1_person, 'Pat')
		assert.equal(values.role_2_state, 'GO')
		assert.equal(values.role_2_label, 'Go!')
		assert.equal(values.role_role_0_name, 'Role 0')
		assert.equal(values.role_role_1_name, 'Role 1')
		assert.equal(values.role_16_name, 'Role 15')
		assert.equal(values.role_17_name, undefined)
		assert.ok(ids.has('role_16_state') && !ids.has('role_17_state') && ids.has('role_role_19_name'))
		assert.equal(MAX_INDEXED_ROLES, 16)
		for (const key of Object.keys(values)) assert.ok(ids.has(key), `${key} has a definition`)
	})

	test('m:ss formatting', () => {
		assert.equal(formatMinutesSeconds(0), '0:00')
		assert.equal(formatMinutesSeconds(72), '1:12')
		assert.equal(formatMinutesSeconds(4500), '75:00')
		assert.equal(formatMinutesSeconds(-5), '0:00')
	})

	function running(now, { elapsedMs, lengthInSeconds = 300, anchorMs = now.value, isRunning = true, v2 = true } = {}) {
		const state = new ModuleState(() => now.value)
		if (v2) state.setProtoVersion(2)
		const anchor = {
			itemId: 'a',
			lengthInSeconds,
			elapsedMs,
			anchorMs,
			isRunning,
			isDurationActual: false,
		}
		state.applyState(
			snap({
				timer: {
					item: { id: 'a', title: 'A', itemType: 'item', lengthInSeconds, elapsedSeconds: 0 },
					index: 0,
					isRunning,
					remainingSeconds: 11,
					isOvertime: false,
					formattedRemaining: '00:11',
					isDurationActualForDisplay: false,
					anchor,
				},
			}),
		)
		return state
	}

	test('elapsed, length, overtime text and the end time', () => {
		const now = { value: Date.UTC(2026, 0, 1, 12, 0, 0) }
		const state = running(now, { elapsedMs: 65_000 })
		let values = getVariableValues(state)
		assert.equal(values.active_item_elapsed, '1:05')
		assert.equal(values.active_item_length, '5:00')
		assert.equal(values.active_item_overtime_text, '')
		const end = new Date(now.value + 235_000)
		const pad = (n) => String(n).padStart(2, '0')
		assert.equal(values.item_ends_at, `${pad(end.getHours())}:${pad(end.getMinutes())}:${pad(end.getSeconds())}`)

		now.value += 235_000 + 72_000
		values = getVariableValues(state)
		assert.equal(values.active_item_overtime_text, '+1:12')
		assert.equal(values.active_item_elapsed, '6:12')
		assert.equal(values.item_ends_at, '')
	})

	test('item_ends_at holds still between ticks and follows the producer clock offset', () => {
		const local = { value: 1_000_000 }
		const state = new ModuleState(() => local.value)
		state.setProtoVersion(2)
		state.sync.addSample(local.value, local.value + 5000, local.value + 5000, local.value)
		const producerNow = local.value + 5000
		state.applyState(
			snap({
				timer: {
					item: { id: 'a', title: 'A', itemType: 'item', lengthInSeconds: 60, elapsedSeconds: 0 },
					index: 0,
					isRunning: true,
					remainingSeconds: 60,
					isOvertime: false,
					formattedRemaining: '01:00',
					isDurationActualForDisplay: false,
					anchor: {
						itemId: 'a',
						lengthInSeconds: 60,
						elapsedMs: 0,
						anchorMs: producerNow,
						isRunning: true,
						isDurationActual: false,
					},
				},
			}),
		)
		const first = state.itemEndsAtMs
		local.value += 3300
		assert.equal(state.itemEndsAtMs, first)
		assert.equal(first, producerNow + 60_000)
	})

	test('a paused timer has no end time; blank without a timer; legacy uses the pushed remaining', () => {
		const now = { value: 10_000_000 }
		assert.equal(getVariableValues(running(now, { elapsedMs: 0, isRunning: false })).item_ends_at, '')
		const none = new ModuleState(() => now.value)
		none.applyState(snap())
		const blank = getVariableValues(none)
		assert.deepEqual(
			[blank.active_item_elapsed, blank.active_item_length, blank.active_item_overtime_text, blank.item_ends_at],
			['', '', '', ''],
		)
		const legacy = running(now, { elapsedMs: 0, v2: false })
		assert.equal(legacy.itemEndsAtMs, now.value + 11_000)
	})

	test('sync_quality: legacy, v2 before a sample, v2 with ±rtt/2', () => {
		const state = new ModuleState(() => 5000)
		assert.equal(getVariableValues(state).sync_quality, 'legacy')
		state.setProtoVersion(2)
		assert.equal(getVariableValues(state).sync_quality, 'v2')
		state.sync.addSample(0, 40, 40, 30)
		assert.equal(getVariableValues(state).sync_quality, 'v2 ±15 ms')
		state.setProtoVersion(1)
		assert.equal(getVariableValues(state).sync_quality, 'legacy')
	})
})

describe('dropdown staleness (definition signature covers Planning Center)', () => {
	const pco = (extra = {}) => ({
		isConnected: true,
		selectedServiceTypeId: null,
		defaultServiceTypeId: null,
		serviceTypes: [{ id: 'st1', name: 'Sunday' }],
		plans: [{ id: 'p1', title: 'Oct 12', dates: null }],
		noteCategories: [],
		...extra,
	})
	const signatureAfter = (extra, planExtra = {}) => {
		const state = new ModuleState()
		state.applyState(snap({ pco: pco(), plan: { title: 'x', items: [], activeItemIndex: 0 } }))
		const before = state.dynamicSignature()
		state.applyState(
			snap({ rev: 2, pco: pco(extra), plan: { title: 'x', items: [], activeItemIndex: 0, ...planExtra } }),
		)
		return [before, state.dynamicSignature()]
	}

	test('new service types, new plans, renamed plans and a changed selection all change it', () => {
		for (const extra of [
			{
				serviceTypes: [
					{ id: 'st1', name: 'Sunday' },
					{ id: 'st2', name: 'Wednesday' },
				],
			},
			{ serviceTypes: [{ id: 'st1', name: 'Sunday AM' }] },
			{
				plans: [
					{ id: 'p1', title: 'Oct 12' },
					{ id: 'p2', title: 'Oct 19' },
				],
			},
			{ plans: [{ id: 'p1', title: 'Oct 12 (edited)' }] },
			{ selectedServiceTypeId: 'st1' },
			{ defaultServiceTypeId: 'st1' },
		]) {
			const [before, after] = signatureAfter(extra)
			assert.notEqual(after, before, JSON.stringify(extra))
		}
		const [before, after] = signatureAfter({}, { pcoPlanId: 'p1' })
		assert.notEqual(after, before)
	})

	test('an unrelated pco field does not', () => {
		const [before, after] = signatureAfter({ userName: 'Pat', lastError: 'x' })
		assert.equal(after, before)
	})

	test('the Select / Sync dropdowns carry the refreshed choices', () => {
		const state = new ModuleState()
		state.applyState(
			snap({ pco: pco({ serviceTypes: [{ id: 'st9', name: 'Easter' }], plans: [{ id: 'p9', title: 'Apr 5' }] }) }),
		)
		const defs = getActionDefinitions({ api: {}, state, log: () => {}, refresh: () => {} })
		const choices = (action, id) => defs[action].options.find((o) => o.id === id).choices
		assert.deepEqual(choices('pcoSelectServiceType', 'serviceTypeId'), [{ id: 'st9', label: 'Easter' }])
		assert.deepEqual(choices('pcoSync', 'planId'), [{ id: 'p9', label: 'Apr 5' }])
	})
})

describe('API capability actions', () => {
	test('Plan Update Item can set a note, merged into the item’s other notes', async () => {
		const sent = []
		const items = [
			{
				id: 'i1',
				title: 'Song',
				itemType: 'song',
				lengthInSeconds: 60,
				elapsedSeconds: 0,
				notes: { keep: 'k', n1: 'old' },
			},
		]
		const { defs } = harness({
			api: { updatePlanItem: async (id, body) => sent.push([id, body]) },
			snapshot: snap({ plan: { title: 'x', items, activeItemIndex: 0 } }),
		})
		await defs.planUpdateItem.callback(
			{ options: { itemId: 'i1', title: '', itemType: '', lengthInSeconds: 0, noteCategoryId: 'n1', noteText: 'new' } },
			{},
		)
		await defs.planUpdateItem.callback({ options: { itemId: 'i1', title: 'Hymn', lengthInSeconds: 0 } }, {})
		await defs.planUpdateItem.callback({ options: { itemId: 'i1', noteCategoryId: 'n1', noteText: '' } }, {})
		assert.deepEqual(sent, [
			['i1', { notes: { keep: 'k', n1: 'new' } }],
			['i1', { title: 'Hymn' }],
			['i1', { notes: { keep: 'k', n1: '' } }],
		])
	})

	test('Send Message can be sent as a role', async () => {
		const sent = []
		const { defs } = harness({ api: { sendMessage: async (b) => sent.push(b) } })
		await defs.sendMessage.callback(
			{ options: { text: 'hi', targetRoleId: 'a', senderRoleId: 'b', isHighPriority: true } },
			{},
		)
		await defs.sendMessage.callback(
			{ options: { text: 'yo', targetRoleId: '', senderRoleId: '', isHighPriority: false } },
			{},
		)
		assert.deepEqual(sent, [
			{ text: 'hi', targetRoleId: 'a', senderRoleId: 'b', isHighPriority: true },
			{ text: 'yo', targetRoleId: undefined, senderRoleId: undefined, isHighPriority: false },
		])
	})

	test('Create Schedule posts title, normalised ISO start, lead minutes, recurrence and enabled', async () => {
		const sent = []
		const { defs, state } = harness({ api: { createSchedule: async (b) => sent.push(b) } })
		await defs.scheduleCreate.callback(
			{
				options: {
					title: ' Sunday 10am ',
					startsAt: '2026-10-18T10:00:00-04:00',
					minutes: 45,
					recurrence: 'weekly',
					isEnabled: false,
				},
			},
			{},
		)
		assert.deepEqual(sent, [
			{
				title: 'Sunday 10am',
				startsAt: '2026-10-18T14:00:00Z',
				goLiveOffsetMinutes: 45,
				recurrence: 'weekly',
				isEnabled: false,
			},
		])
		assert.equal(state.currentActionError, '')
	})

	test('Create Schedule rejects a missing title or an unreadable start without calling the API', async () => {
		const sent = []
		const { defs, state } = harness({ api: { createSchedule: async (b) => sent.push(b) } })
		await defs.scheduleCreate.callback({ options: { title: '', startsAt: '2026-10-18T10:00:00Z' } }, {})
		assert.match(state.currentActionError, /needs a title/)
		await defs.scheduleCreate.callback({ options: { title: 'X', startsAt: 'next sunday' } }, {})
		assert.match(state.currentActionError, /ISO-8601/)
		assert.equal(sent.length, 0)
		assert.equal(isoWithoutFraction('2026-10-18T10:00:00.250Z'), '2026-10-18T10:00:00Z')
		assert.equal(isoWithoutFraction('junk'), null)
	})

	test('Update Role can clear the person and replace note categories', async () => {
		const sent = []
		const { defs } = harness({ api: { updateRole: async (id, b) => sent.push([id, b]) } })
		const run = (options) => defs.updateRole.callback({ options: { roleId: 'r1', ...options } }, {})
		await run({ name: '', personName: 'Pat' })
		await run({ personName: 'Pat', clearPerson: true })
		await run({ setNoteCategories: true, assignedNoteCategories: ['n1', 'n2'] })
		await run({ setNoteCategories: true, assignedNoteCategories: [] })
		await run({ setNoteCategories: false, assignedNoteCategories: ['n1'] })
		assert.deepEqual(sent, [
			['r1', { personName: 'Pat' }],
			['r1', { personName: '' }],
			['r1', { assignedNoteCategories: ['n1', 'n2'] }],
			['r1', { assignedNoteCategories: [] }],
			['r1', {}],
		])
	})
})
