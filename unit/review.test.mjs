import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { inflateSync } from 'node:zlib'

const { ModuleState, RUNDOWN_ROWS } = await import('../dist/state.js')
const { progressBarPng } = await import('../dist/progress.js')
const { getPresetDefinitions } = await import('../dist/presets.js')
const { getVariableValues } = await import('../dist/variables.js')
const { getFeedbackDefinitions } = await import('../dist/feedbacks.js')
const { getActionDefinitions } = await import('../dist/actions.js')

function item(id, lengthInSeconds, extra = {}) {
	return { id, title: `Item ${id}`, itemType: 'item', lengthInSeconds, elapsedSeconds: 0, ...extra }
}

function timer(remainingSeconds, it, extra = {}) {
	return { item: it, index: 0, isRunning: true, remainingSeconds, isOvertime: remainingSeconds < 0, ...extra }
}

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

describe('revision guard', () => {
	test('a lower rev is ignored, an equal or higher one applied, a missing one accepted', () => {
		const state = new ModuleState()
		assert.equal(state.applyState(snap({ rev: 5, appMode: 'a' })), true)
		assert.equal(state.applyState(snap({ rev: 4, appMode: 'b' })), false)
		assert.equal(state.snapshot.appMode, 'a')
		assert.equal(state.applyState(snap({ rev: 5, appMode: 'c' })), false)
		assert.equal(state.applyState(snap({ rev: 6, appMode: 'c' })), true)
		assert.equal(state.applyState(snap({ rev: undefined, appMode: 'd' })), true)
		assert.equal(state.rev, 6)
	})

	test('resetRev lets a restarted app, counting from 1 again, through', () => {
		const state = new ModuleState()
		state.applyState(snap({ rev: 50 }))
		state.resetRev()
		assert.equal(state.applyState(snap({ rev: 1 })), true)
	})

	test('a timer event merges into the held snapshot unless it is older', () => {
		const state = new ModuleState()
		assert.equal(state.applyTimer({ rev: 1, timer: null }), false)
		state.applyState(snap({ rev: 10 }))
		const t = timer(30, item('a', 60))
		assert.equal(state.applyTimer({ rev: 11, timer: t }), true)
		assert.equal(state.timer.remainingSeconds, 30)
		assert.equal(state.snapshot.plan.title, 'Sunday')
		assert.equal(state.applyTimer({ rev: 9, timer: null }), false)
		assert.equal(state.timer.remainingSeconds, 30)
		assert.equal(state.rev, 11)
	})

	test('serverNowMs yields a clock offset', () => {
		const state = new ModuleState(() => 1000)
		state.applyState(snap({ serverNowMs: 6000 }))
		assert.equal(state.nowMs, 6000)
	})
})

describe('definition signature', () => {
	const base = () =>
		snap({
			roles: [{ id: 'r1', name: 'Host' }],
			plan: { title: 'x', items: [item('a', 60), item('b', 120)], activeItemIndex: 0 },
		})

	test('a ticking timer or active index does not change it', () => {
		const state = new ModuleState()
		state.applyState(base())
		const before = state.dynamicSignature()
		state.applyState({
			...base(),
			rev: 2,
			timer: timer(10, item('a', 60)),
			plan: { ...base().plan, activeItemIndex: 1 },
		})
		assert.equal(state.dynamicSignature(), before)
	})

	test('renames, new items and length changes do', () => {
		const state = new ModuleState()
		state.applyState(base())
		const before = state.dynamicSignature()
		state.applyState({ ...base(), rev: 2, roles: [{ id: 'r1', name: 'Hosts' }] })
		const renamed = state.dynamicSignature()
		assert.notEqual(renamed, before)
		state.applyState({
			...base(),
			rev: 3,
			plan: { title: 'x', items: [item('a', 61), item('b', 120)], activeItemIndex: 0 },
		})
		assert.notEqual(state.dynamicSignature(), before)
		state.applyState({ ...base(), rev: 4, schedules: { entries: [{ id: 's', title: 'Nine' }], nextId: 's' } })
		assert.notEqual(state.dynamicSignature(), before)
	})
})

describe('service timing', () => {
	const NOW = Date.UTC(2026, 0, 1, 12, 0, 0)

	function loaded(schedules) {
		const state = new ModuleState(() => NOW)
		const items = [item('a', 600, { elapsedSeconds: 300 }), item('b', 120), item('c', 180)]
		state.applyState(
			snap({
				timer: timer(300, items[0]),
				plan: { title: 'x', items, activeItemIndex: 0 },
				...(schedules ? { schedules } : {}),
			}),
		)
		return state
	}

	test('remaining total is the live item plus everything after it', () => {
		const state = loaded()
		assert.equal(state.serviceRemainingSeconds, 300 + 120 + 180)
		assert.equal(state.projectedEndMs, NOW + 600_000)
	})

	test('overtime counts as zero remaining', () => {
		const state = new ModuleState(() => NOW)
		const items = [item('a', 60), item('b', 100)]
		state.applyState(snap({ timer: timer(-30, items[0]), plan: { items, activeItemIndex: 0 } }))
		assert.equal(state.serviceRemainingSeconds, 100)
	})

	test('projected end text is local HH:MM', () => {
		const state = loaded()
		const end = new Date(NOW + 600_000)
		const expected = `${String(end.getHours()).padStart(2, '0')}:${String(end.getMinutes()).padStart(2, '0')}`
		assert.equal(state.projectedEndText, expected)
	})

	test('over/under is blank without a schedule, signed against startsAt + planned total with one', () => {
		assert.equal(loaded().serviceOverUnderText, '')
		const start = new Date(NOW - 5 * 60_000).toISOString()
		const on = loaded({ entries: [{ id: 's', title: 'S', startsAt: start }], nextId: 's' })
		assert.equal(on.serviceOverUnderText, '+00:00')
		const early = new Date(NOW - 4 * 60_000).toISOString()
		const over = loaded({ entries: [{ id: 's', title: 'S', startsAt: early }], nextId: 's' })
		assert.equal(over.serviceOverUnderText, '-01:00')
		const late = new Date(NOW - 7 * 60_000).toISOString()
		const under = loaded({ entries: [{ id: 's', title: 'S', startsAt: late }], nextId: 's' })
		assert.equal(under.serviceOverUnderText, '+02:00')
	})

	test('no timer gives blank values', () => {
		const state = new ModuleState(() => NOW)
		state.applyState(snap())
		assert.equal(state.projectedEndText, '')
		assert.equal(state.serviceRemainingSeconds, null)
	})

	test('progress is elapsed over length, clamped to 0-100', () => {
		const state = new ModuleState()
		state.applyState(snap({ timer: timer(1, item('a', 600, { elapsedSeconds: 150 })) }))
		assert.equal(state.activeItemProgressPct, 25)
		state.applyState(snap({ rev: 2, timer: timer(1, item('a', 100, { elapsedSeconds: 250 })) }))
		assert.equal(state.activeItemProgressPct, 100)
		state.applyState(snap({ rev: 3, timer: timer(1, item('a', 0, { elapsedSeconds: 5 })) }))
		assert.equal(state.activeItemProgressPct, 0)
	})
})

describe('rundown paging', () => {
	function planOf(n, active = 0) {
		const items = Array.from({ length: n }, (_, i) => item(`i${i}`, 60 + i))
		return snap({ plan: { title: 'x', items, activeItemIndex: active } })
	}

	test('pages clamp at both ends', () => {
		const state = new ModuleState()
		state.applyState(planOf(20))
		assert.equal(state.rundownPageCount, 3)
		state.pageRundown(-1)
		assert.equal(state.rundownPageIndex, 0)
		state.pageRundown(1)
		state.pageRundown(1)
		state.pageRundown(1)
		assert.equal(state.rundownPageIndex, 2)
		assert.equal(state.rundownRow(1).id, 'i16')
		assert.equal(state.rundownRow(5), undefined)
	})

	test('a shrinking plan pulls the page back in range', () => {
		const state = new ModuleState()
		state.applyState(planOf(20))
		state.pageRundown(2)
		state.applyState({ ...planOf(5), rev: 2 })
		assert.equal(state.rundownPageIndex, 0)
		assert.equal(state.rundownRow(1).id, 'i0')
	})

	test('the active row highlights only on the page that holds the live item', () => {
		const state = new ModuleState()
		state.applyState(planOf(20, 9))
		assert.equal(state.isRundownRowActive(2), false)
		state.pageRundown(1)
		assert.equal(state.isRundownRowActive(2), true)
		assert.equal(state.isRundownRowActive(1), false)
	})

	test('row variables follow the page', () => {
		const state = new ModuleState()
		state.applyState(planOf(10))
		let values = getVariableValues(state)
		assert.equal(values.rundown_row_1_title, 'Item i0')
		assert.equal(values.rundown_row_1_length, '01:00')
		assert.equal(values.rundown_page, 1)
		assert.equal(values.rundown_page_count, 2)
		state.pageRundown(1)
		values = getVariableValues(state)
		assert.equal(values.rundown_row_1_title, 'Item i8')
		assert.equal(values.rundown_row_3_title, '')
		assert.equal(RUNDOWN_ROWS, 8)
	})
})

describe('staleness', () => {
	test('stale only when connected and quiet for more than 7.5s', () => {
		let now = 0
		const state = new ModuleState(() => now)
		assert.equal(state.isStale, false)
		state.setSocketConnected(true)
		now = 7500
		assert.equal(state.isStale, false)
		now = 7501
		assert.equal(state.isStale, true)
		state.markFrame()
		assert.equal(state.isStale, false)
		now = 20000
		state.setSocketConnected(false)
		assert.equal(state.isStale, false)
	})

	test('the connectionStale feedback follows it', () => {
		let now = 0
		const state = new ModuleState(() => now)
		const feedback = getFeedbackDefinitions(state).connectionStale
		state.setSocketConnected(true)
		assert.equal(feedback.callback({ options: {} }), false)
		now = 9000
		assert.equal(feedback.callback({ options: {} }), true)
	})
})

describe('progress bar image', () => {
	test('is a valid 72x72 RGBA PNG whose filled width grows with the percentage', () => {
		const decode = (b64) => {
			const png = Buffer.from(b64, 'base64')
			assert.equal(png.subarray(1, 4).toString('ascii'), 'PNG')
			assert.equal(png.readUInt32BE(16), 72)
			const idatLen = png.readUInt32BE(33)
			return inflateSync(png.subarray(41, 41 + idatLen))
		}
		const filled = (raw) => {
			let count = 0
			for (let y = 0; y < 72; y++) {
				for (let x = 0; x < 72; x++) if (raw[y * 289 + 1 + x * 4 + 3] === 255) count++
			}
			return count
		}
		assert.ok(filled(decode(progressBarPng(0))) < filled(decode(progressBarPng(50))))
		assert.ok(filled(decode(progressBarPng(50))) < filled(decode(progressBarPng(100))))
		assert.equal(progressBarPng(150), progressBarPng(100))
	})
})

describe('preset config gating', () => {
	const redOnOvertime = (preset) => preset.feedbacks.some((f) => f.feedbackId === 'timerOvertime')

	test('countdown presets carry the overtime-red feedback only when enabled', () => {
		const state = new ModuleState()
		const on = getPresetDefinitions(state, { overtimeRed: true })
		const off = getPresetDefinitions(state, { overtimeRed: false })
		for (const id of ['active_item_status', 'countdown_stages']) {
			assert.equal(redOnOvertime(on[id]), true, id)
			assert.equal(redOnOvertime(off[id]), false, id)
		}
	})

	test('countdown stages go amber at 60s then red at 30s', () => {
		const stages = getPresetDefinitions(new ModuleState())
			.countdown_stages.feedbacks.filter((f) => f.feedbackId === 'timerUnderThreshold')
			.map((f) => f.options.thresholdSeconds)
		assert.deepEqual(stages, [60, 30])
	})

	test('the new preset packs exist', () => {
		const presets = getPresetDefinitions(new ModuleState())
		assert.equal(Object.values(presets).filter((p) => p.category === 'Timer Entry').length, 20)
		assert.equal(Object.keys(presets).filter((id) => id.startsWith('rundown_row_')).length, 8)
		for (const id of [
			'timer_plus_10',
			'timer_minus_10',
			'plan_next_hold',
			'waypoint_next',
			'status_connection_stale',
		]) {
			assert.ok(presets[id], id)
		}
		assert.deepEqual(presets.plan_next_hold.steps[0].down[0].options, { startTimer: false })
	})
})

describe('PCO service type and waypoint unassign actions', () => {
	function run(actionId, options) {
		const calls = []
		const api = {
			selectPcoServiceType: async (id) => calls.push(['select', id]),
			setPcoDefaultServiceType: async (id) => calls.push(['default', id]),
			assignWaypoint: async (ref, itemId) => calls.push(['assign', ref, itemId]),
		}
		const state = new ModuleState()
		const defs = getActionDefinitions({ api, state, log: () => {}, refresh: () => {} })
		return defs[actionId].callback({ options }, {}).then(() => calls)
	}

	test('select service type selects, and clears when asked (old saved actions still select)', async () => {
		assert.deepEqual(await run('pcoSelectServiceType', { serviceTypeId: 'st-1' }), [['select', 'st-1']])
		assert.deepEqual(await run('pcoSelectServiceType', { serviceTypeId: 'st-1', clear: false }), [['select', 'st-1']])
		assert.deepEqual(await run('pcoSelectServiceType', { serviceTypeId: 'st-1', clear: true }), [['select', null]])
	})

	test('set default service type selects or clears', async () => {
		assert.deepEqual(await run('pcoSetDefaultServiceType', { serviceTypeId: 'st-2' }), [['default', 'st-2']])
		assert.deepEqual(await run('pcoSetDefaultServiceType', { serviceTypeId: 'st-2', clear: true }), [['default', null]])
	})

	test('unassign waypoint sends a null item id', async () => {
		assert.deepEqual(await run('waypointUnassign', { waypoint: 'song-1' }), [['assign', 'song-1', null]])
	})
})
