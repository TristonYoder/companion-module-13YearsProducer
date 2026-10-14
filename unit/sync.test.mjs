import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

const {
	fnv1a64,
	canonicalRoles,
	canonicalTimer,
	canonicalMessages,
	canonicalPlan,
	computeHashes,
	mismatchedSections,
	anchorElapsedMs,
	anchorRemainingSeconds,
	msToNextBoundary,
	ClockSync,
	SYNC_SAMPLE_COUNT,
} = await import('../dist/sync.js')
const { ModuleState, STALE_AFTER_MS, STALE_AFTER_MS_V2 } = await import('../dist/state.js')
const { getVariableValues } = await import('../dist/variables.js')
const { getFeedbackDefinitions } = await import('../dist/feedbacks.js')

const US = '\u001f'
const RS = '\u001e'

function anchor(extra = {}) {
	return {
		itemId: 'item-1',
		lengthInSeconds: 300,
		elapsedMs: 120000,
		anchorMs: 1760000000000,
		isRunning: true,
		isDurationActual: false,
		...extra,
	}
}

function snap(extra = {}) {
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
		...extra,
	}
}

function activeTimer(a, extra = {}) {
	return {
		item: { id: a.itemId, title: 'Song', itemType: 'item', lengthInSeconds: a.lengthInSeconds, elapsedSeconds: 0 },
		index: 0,
		isRunning: a.isRunning,
		remainingSeconds: 999,
		isOvertime: false,
		formattedRemaining: '99:99',
		isDurationActualForDisplay: false,
		anchor: a,
		...extra,
	}
}

describe('FNV-1a 64 (spec test vectors)', () => {
	test('raw strings', () => {
		assert.equal(fnv1a64(''), 'cbf29ce484222325')
		assert.equal(fnv1a64('a'), 'af63dc4c8601ec8c')
		assert.equal(fnv1a64('foobar'), '85944171f73967e8')
	})

	test('canonical sections', () => {
		const roles = [
			{ id: 'host', name: 'Host', state: 'GO' },
			{ id: 'band', name: 'Band', state: 'OFF' },
		]
		assert.equal(canonicalRoles({ roles }), `host${US}Host${US}GO${RS}band${US}Band${US}OFF${RS}`)
		assert.equal(fnv1a64(canonicalRoles({ roles })), 'aded3b3c0e486304')

		assert.equal(fnv1a64(canonicalTimer(anchor())), '20a9d930a0849518')
		assert.equal(fnv1a64(canonicalTimer(null)), '3c0d17bad169557b')
		assert.equal(fnv1a64(canonicalTimer(undefined)), '3c0d17bad169557b')

		assert.equal(
			fnv1a64(
				canonicalMessages({
					messages: [
						{ id: 'm1', timestamp: '2026-01-01T10:00:00Z' },
						{ id: 'm2', timestamp: '2026-01-01T10:00:05Z' },
					],
				}),
			),
			'dddb4a3dc4d94432',
		)
		for (const ids of [
			['a', 'b'],
			['b', 'a'],
		]) {
			const messages = ids.map((id) => ({ id, timestamp: '2026-01-01T10:00:00Z' }))
			assert.equal(canonicalMessages({ messages }), `a${RS}b`)
			assert.equal(fnv1a64(canonicalMessages({ messages })), 'e5e7b9190438f91c')
		}

		const plan = {
			items: [
				{ id: 'i1', title: 'Song', lengthInSeconds: 300, isDurationActual: false },
				{ id: 'i2', title: 'Sermon', lengthInSeconds: 2700, isDurationActual: true },
			],
			activeItemIndex: 1,
		}
		assert.equal(fnv1a64(canonicalPlan({ plan })), '218cc3247b5ee3f9')
	})

	test('hashes cover non-ASCII as UTF-8 and are always 16 hex digits', () => {
		assert.match(fnv1a64('Café ☕'), /^[0-9a-f]{16}$/)
		assert.notEqual(fnv1a64('Café'), fnv1a64('Cafe'))
		assert.match(fnv1a64('\u0000'), /^[0-9a-f]{16}$/)
	})

	test('computeHashes and mismatchedSections', () => {
		const s = snap({ timer: activeTimer(anchor()) })
		const local = computeHashes(s)
		assert.equal(local.timer, '20a9d930a0849518')
		assert.deepEqual(mismatchedSections(local, { ...local }), [])
		assert.deepEqual(mismatchedSections(local, { ...local, plan: 'x', messages: 'y' }), ['plan', 'messages'])
		assert.deepEqual(mismatchedSections(local, { timer: local.timer }), [])
	})
})

describe('clock offset estimation', () => {
	test('offset and rtt follow the NTP formulas', () => {
		const sync = new ClockSync(() => 0)
		const sample = sync.addSample(1000, 1520, 1522, 1042)
		assert.equal(sample.rtt, 40)
		assert.equal(sample.offset, 500)
		assert.equal(sync.offsetMs, 500)
		assert.equal(sync.rttMs, 40)
	})

	test('the lowest-RTT sample wins, even against an asymmetric slow one', () => {
		const sync = new ClockSync(() => 0)
		sync.addSample(0, 500, 500, 10)
		sync.addSample(1000, 1500, 1500, 1210)
		assert.equal(sync.rttMs, 10)
		assert.equal(sync.offsetMs, 495)
	})

	test('a change under 20 ms moves 25% of the way; 20 ms or more jumps', () => {
		const sync = new ClockSync(() => 0)
		sync.addSample(0, 100, 100, 0)
		sync.addSample(0, 110, 110, 0)
		assert.equal(sync.offsetMs, 102.5)
		sync.addSample(0, 110, 110, 0)
		assert.ok(Math.abs(sync.offsetMs - 104.375) < 1e-9)
		sync.addSample(0, 300, 300, 0)
		assert.equal(sync.offsetMs, 300)
	})

	test('keeps only the last 8 samples', () => {
		const sync = new ClockSync(() => 0)
		sync.addSample(0, 50, 50, 1)
		for (let i = 0; i < SYNC_SAMPLE_COUNT - 1; i++) sync.addSample(0, 50, 50, 100)
		assert.equal(sync.rttMs, 1)
		sync.addSample(0, 50, 50, 100)
		assert.equal(sync.rttMs, 100)
		assert.equal(sync.offsetMs, 0)
	})

	test('producerNowMs adds the offset to the local clock; reset forgets it', () => {
		let now = 10000
		const sync = new ClockSync(() => now)
		assert.equal(sync.producerNowMs(), 10000)
		assert.equal(sync.hasOffset, false)
		sync.addSample(0, 700, 700, 0)
		assert.equal(sync.producerNowMs(), 10700)
		now = 10250
		assert.equal(sync.producerNowMs(), 10950)
		sync.reset()
		assert.equal(sync.offsetMs, null)
		assert.equal(sync.rttMs, null)
	})
})

describe('anchor arithmetic', () => {
	test('a running anchor advances with the producer clock', () => {
		const a = anchor()
		assert.equal(anchorElapsedMs(a, a.anchorMs), 120000)
		assert.equal(anchorElapsedMs(a, a.anchorMs + 999), 120999)
		assert.equal(anchorRemainingSeconds(a, a.anchorMs), 180)
		assert.equal(anchorRemainingSeconds(a, a.anchorMs + 999), 180)
		assert.equal(anchorRemainingSeconds(a, a.anchorMs + 1000), 179)
		assert.equal(anchorRemainingSeconds(a, a.anchorMs + 180000), 0)
		assert.equal(anchorRemainingSeconds(a, a.anchorMs + 181500), -1)
	})

	test('a paused anchor holds still; before the anchor never goes below zero', () => {
		const paused = anchor({ isRunning: false })
		assert.equal(anchorElapsedMs(paused, paused.anchorMs + 60000), 120000)
		const fresh = anchor({ elapsedMs: 500 })
		assert.equal(anchorElapsedMs(fresh, fresh.anchorMs - 5000), 0)
	})

	test('msToNextBoundary lands on anchorMs + k*1000, in (0, 1000]', () => {
		const a = anchor({ anchorMs: 10250 })
		assert.equal(msToNextBoundary(a, 10250), 1000)
		assert.equal(msToNextBoundary(a, 10251), 999)
		assert.equal(msToNextBoundary(a, 11249), 1)
		assert.equal(msToNextBoundary(a, 11250), 1000)
		assert.equal(msToNextBoundary(a, 9000), 250)
	})

	test('pause then resume through the state: frozen, then counting again', () => {
		let now = 1000000
		const state = new ModuleState(() => now)
		state.setProtoVersion(2)
		state.applyState(snap({ rev: 1, timer: activeTimer(anchor({ anchorMs: now, elapsedMs: 0, lengthInSeconds: 60 })) }))
		assert.equal(state.timerRemainingSeconds, 60)
		now += 10500
		assert.equal(state.timerRemainingSeconds, 50)
		assert.equal(state.timerElapsedSeconds, 10)

		const pausedAnchor = anchor({ anchorMs: now, elapsedMs: 10500, isRunning: false, lengthInSeconds: 60 })
		assert.equal(state.applyTimer({ rev: 2, timer: activeTimer(pausedAnchor, { isRunning: false }) }), true)
		now += 30000
		assert.equal(state.timerRemainingSeconds, 50)

		const resumed = anchor({ anchorMs: now, elapsedMs: 10500, isRunning: true, lengthInSeconds: 60 })
		state.applyTimer({ rev: 3, timer: activeTimer(resumed) })
		assert.equal(state.timerRemainingSeconds, 50)
		now += 50000
		assert.equal(state.timerRemainingSeconds, 0)
		now += 1000
		assert.equal(state.timerRemainingSeconds, -1)
		assert.equal(state.timerIsOvertime, true)
		assert.equal(state.timerFormattedRemaining, '+00:01')
	})

	test('the offset moves the anchor against the local clock', () => {
		let now = 5000
		const state = new ModuleState(() => now)
		state.setProtoVersion(2)
		state.sync.addSample(0, 2000, 2000, 0)
		state.applyState(snap({ timer: activeTimer(anchor({ anchorMs: 7000, elapsedMs: 0, lengthInSeconds: 60 })) }))
		assert.equal(state.nowMs, 7000)
		assert.equal(state.timerRemainingSeconds, 60)
		now = 6000
		assert.equal(state.timerRemainingSeconds, 59)
	})
})

describe('v2 vs legacy accessors', () => {
	test('legacy mode reads the pushed values, whatever the anchor says', () => {
		let now = 0
		const state = new ModuleState(() => now)
		state.applyState(
			snap({
				timer: activeTimer(anchor({ anchorMs: 0, elapsedMs: 0 }), {
					remainingSeconds: 42,
					isOvertime: false,
					formattedRemaining: '00:42',
				}),
			}),
		)
		now = 90000
		assert.equal(state.protoVersion, 1)
		assert.equal(state.timerRemainingSeconds, 42)
		assert.equal(state.timerIsOvertime, false)
		assert.equal(state.timerFormattedRemaining, '00:42')
		const values = getVariableValues(state)
		assert.equal(values.active_item_remaining_seconds, 42)
		assert.equal(values.active_item_remaining, '00:42')
		assert.equal(values.sync_offset_ms, '')
	})

	test('v2 drives variables and feedbacks from the anchor', () => {
		let now = 1000
		const state = new ModuleState(() => now)
		state.setProtoVersion(2)
		state.sync.addSample(0, 40, 40, 0)
		state.applyState(
			snap({
				timer: activeTimer(anchor({ anchorMs: 1040, elapsedMs: 0, lengthInSeconds: 60 })),
				plan: {
					title: 'Sunday',
					activeItemIndex: 0,
					items: [
						{ id: 'item-1', title: 'Song', lengthInSeconds: 60 },
						{ id: 'b', title: 'Next', lengthInSeconds: 120 },
					],
				},
			}),
		)
		let values = getVariableValues(state)
		assert.equal(values.active_item_remaining_seconds, 60)
		assert.equal(values.active_item_remaining, '01:00')
		assert.equal(values.active_item_is_overtime, 'no')
		assert.equal(values.active_item_progress_pct, 0)
		assert.equal(values.sync_offset_ms, 40)
		assert.equal(values.sync_rtt_ms, 0)

		const under = getFeedbackDefinitions(state).timerUnderThreshold
		const overtime = getFeedbackDefinitions(state).timerOvertime
		assert.equal(under.callback({ options: { thresholdSeconds: 30 } }), false)
		now += 31000
		assert.equal(under.callback({ options: { thresholdSeconds: 30 } }), true)
		assert.equal(getVariableValues(state).active_item_progress_pct, 52)
		now += 30000
		assert.equal(overtime.callback({ options: {} }), true)
		values = getVariableValues(state)
		assert.equal(values.active_item_remaining, '+00:01')
		assert.equal(values.active_item_is_overtime, 'yes')
	})

	test('projected end holds still between ticks', () => {
		let now = 1700000000000
		const state = new ModuleState(() => now)
		state.setProtoVersion(2)
		state.applyState(
			snap({
				timer: activeTimer(anchor({ anchorMs: now, elapsedMs: 0, lengthInSeconds: 60 })),
				plan: { title: 'x', activeItemIndex: 0, items: [{ id: 'item-1', title: 'a', lengthInSeconds: 60 }] },
			}),
		)
		const end = state.projectedEndMs
		now += 700
		assert.equal(state.projectedEndMs, end)
	})

	test('the Timer Entry preview uses the local remaining time', () => {
		let now = 0
		const state = new ModuleState(() => now)
		state.setProtoVersion(2)
		state.applyState(snap({ timer: activeTimer(anchor({ anchorMs: 0, elapsedMs: 0, lengthInSeconds: 600 })) }))
		state.appendTimerEntry('+30s')
		assert.equal(state.timerEntryPreview, '+00:30\n= 10:30')
		now = 100000
		assert.equal(state.timerEntryPreview, '+00:30\n= 08:50')
	})

	test('stale threshold is 8 s legacy, 5 s on v2', () => {
		let now = 0
		const state = new ModuleState(() => now)
		state.setSocketConnected(true)
		assert.equal(state.staleAfterMs, STALE_AFTER_MS)
		now = 8000
		assert.equal(state.isStale, false)
		now = 8001
		assert.equal(state.isStale, true)
		state.setProtoVersion(2)
		assert.equal(state.staleAfterMs, STALE_AFTER_MS_V2)
		state.markFrame()
		now = 13000
		assert.equal(state.isStale, false)
		now = 13002
		assert.equal(state.isStale, true)
		state.markFrame()
		assert.equal(state.isStale, false)
	})

	test('rev ordering: an older timer event is ignored, a restart (reset) is accepted', () => {
		let now = 0
		const state = new ModuleState(() => now)
		state.setProtoVersion(2)
		state.applyState(snap({ rev: 10, timer: activeTimer(anchor({ anchorMs: 0, elapsedMs: 0 })) }))
		const paused = anchor({ anchorMs: 0, elapsedMs: 5000, isRunning: false })
		assert.equal(state.applyTimer({ rev: 9, timer: activeTimer(paused) }), false)
		assert.equal(state.timerAnchor.isRunning, true)
		assert.equal(state.applyTimer({ rev: 11, timer: activeTimer(paused) }), true)
		assert.equal(state.timerAnchor.isRunning, false)
		state.resetRev()
		assert.equal(state.applyState(snap({ rev: 1 })), true)
		assert.equal(state.timer, null)
		assert.equal(state.timerRemainingSeconds, null)
	})

	test('dropping back to legacy forgets the offset', () => {
		const state = new ModuleState(() => 0)
		state.setProtoVersion(2)
		state.sync.addSample(0, 90, 90, 0)
		assert.equal(state.sync.hasOffset, true)
		state.setProtoVersion(1)
		assert.equal(state.sync.hasOffset, false)
	})
})

test('ControlSocket hands every server event type to its handler, digest included', async () => {
	const { ControlSocket } = await import('../dist/api.js')
	const seen = []
	const socket = new ControlSocket(() => ({ host: 'h', port: 1 }), {
		onHello: () => seen.push('hello'),
		onState: () => seen.push('state'),
		onMessage: () => seen.push('message'),
		onTimer: () => seen.push('timer'),
		onDigest: () => seen.push('digest'),
	})
	for (const event of ['hello', 'state', 'message', 'timer', 'digest']) {
		socket.handleMessage(JSON.stringify({ event, data: {} }))
	}
	assert.deepEqual(seen, ['hello', 'state', 'message', 'timer', 'digest'])
})
