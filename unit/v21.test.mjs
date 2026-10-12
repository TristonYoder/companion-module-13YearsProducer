// Unit tests for the sync protocol v2.1 amendments: producer epoch, monotonic
// clock-sample aging and bounds, strict rev gating, anchor bounds, and the
// session's reaction to a restart or a wake. No app required.
//
//   npm run test:unit
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

const { ClockSync, monotonicEpochNow, SYNC_MAX_AGE_MS } = await import('../dist/sync.js')
const { ModuleState, MAX_REV_JUMP } = await import('../dist/state.js')
const { SyncSession, SYNC_BURST_COUNT, SYNC_BURST_GAP_MS } = await import('../dist/session.js')
const { computeHashes } = await import('../dist/sync.js')

function anchor(extra = {}) {
	return {
		itemId: 'a',
		lengthInSeconds: 60,
		elapsedMs: 0,
		anchorMs: 0,
		isRunning: true,
		isDurationActual: false,
		...extra,
	}
}

function activeTimer(a) {
	return {
		item: { id: a.itemId, title: 'A', itemType: 'item', lengthInSeconds: a.lengthInSeconds, elapsedSeconds: 0 },
		index: 0,
		isRunning: a.isRunning,
		remainingSeconds: 7,
		isOvertime: false,
		formattedRemaining: '00:07',
		isDurationActualForDisplay: false,
		anchor: a,
	}
}

function snap(extra = {}) {
	return {
		rev: 1,
		roles: [{ id: 'host', name: 'Host', state: 'OFF' }],
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

describe('monotonic clock', () => {
	test('is epoch-based, close to Date.now, and never goes backwards', () => {
		const a = monotonicEpochNow()
		const b = monotonicEpochNow()
		assert.ok(b >= a)
		assert.ok(Math.abs(a - Date.now()) < 2000)
	})

	test('ModuleState and ClockSync default to it', () => {
		const state = new ModuleState()
		assert.ok(Math.abs(state.clock() - Date.now()) < 2000)
		assert.ok(Math.abs(state.sync.producerNowMs() - Date.now()) < 2000)
	})
})

describe('clock sample aging and bounds', () => {
	test('a sample older than 90 s is ignored', () => {
		let now = 0
		const sync = new ClockSync(() => now)
		sync.addSample(0, 100, 100, 0) // offset 100, rtt 0, received at 0
		assert.equal(sync.rttMs, 0)
		now = SYNC_MAX_AGE_MS
		assert.equal(sync.rttMs, 0)
		now = SYNC_MAX_AGE_MS + 1
		assert.equal(sync.rttMs, null)
	})

	test('an aged-out best no longer wins over a fresh, slower sample', () => {
		let now = 0
		const sync = new ClockSync(() => now)
		sync.addSample(0, 1000, 1000, 0) // rtt 0, offset 1000
		now = 100_000
		sync.addSample(now, now + 1030, now + 1030, now + 60) // rtt 60, offset 1000
		assert.equal(sync.rttMs, 60)
	})

	test('a fresh offset far from the held best discards the older samples', () => {
		const sync = new ClockSync(() => 1000)
		sync.addSample(0, 100, 100, 0) // offset 100, rtt 0: the best
		sync.addSample(0, 100, 100, 0)
		// Off by 400 ms with rtt 20: more than max(50, 40), so history goes.
		sync.addSample(0, 500, 500, 40) // offset 480, rtt 40
		assert.equal(sync.rttMs, 40)
		assert.equal(sync.offsetMs, 480)
	})

	test('a small change (within max(50 ms, 2 * rtt)) keeps the history', () => {
		const sync = new ClockSync(() => 1000)
		sync.addSample(0, 100, 100, 0)
		sync.addSample(0, 130, 130, 0) // 30 ms off, within 50
		assert.equal(sync.rttMs, 0)
		sync.addSample(0, 180, 180, 200) // offset 80 rtt 200: 20 ms off... within 2*rtt
		assert.equal(sync.rttMs, 0)
	})

	test('a negative rtt (millisecond rounding) is treated as 0', () => {
		const sync = new ClockSync(() => 1000)
		const sample = sync.addSample(0, 10, 15, 3) // (3-0)-(15-10) = -2
		assert.equal(sample.rtt, 0)
		assert.equal(sync.rttMs, 0)
	})

	test('an rtt above 10 s is ignored; so is an offset beyond a day', () => {
		const sync = new ClockSync(() => 1000)
		assert.equal(sync.addSample(0, 6000, 6000, 10_001), null)
		assert.equal(sync.hasOffset, false)
		assert.equal(sync.addSample(0, 86_400_001 * 2, 86_400_001 * 2, 0), null)
		assert.equal(sync.hasOffset, false)
		assert.notEqual(sync.addSample(0, 86_400_000, 86_400_000, 0), null)
		assert.equal(sync.hasOffset, true)
	})
})

describe('epoch', () => {
	function held() {
		let now = 1_000_000
		const state = new ModuleState(() => now)
		state.setProtoVersion(2)
		state.applyState(snap({ rev: 500, epoch: 11, timer: activeTimer(anchor({ anchorMs: now })) }))
		state.sync.addSample(now, now + 40, now + 40, now)
		return { state, advance: (ms) => (now += ms) }
	}

	test('the first epoch is just remembered', () => {
		const { state } = held()
		assert.equal(state.epoch, 11)
		assert.equal(state.rev, 500)
		assert.ok(state.timerAnchor)
		assert.equal(state.sync.hasOffset, true)
	})

	test('a new epoch on a timer event resets anchor, rev gate and samples, and takes the event', () => {
		const { state } = held()
		const calls = []
		state.onEpochChange = (needsState) => calls.push(needsState)
		const fresh = anchor({ itemId: 'z', anchorMs: 5 })
		assert.equal(state.applyTimer({ rev: 3, epoch: 12, timer: activeTimer(fresh) }), true)
		assert.equal(state.epoch, 12)
		assert.equal(state.rev, 3)
		assert.equal(state.sync.hasOffset, false)
		assert.equal(state.timerAnchor.itemId, 'z')
		assert.deepEqual(calls, [true])
	})

	test('a new epoch with no timer in the packet leaves no anchor to run from', () => {
		const { state } = held()
		state.observeEpoch(99)
		assert.equal(state.timerAnchor, null)
		assert.equal(state.rev, null)
	})

	test('a state event with a new epoch is taken whatever its rev, without asking for another fetch', () => {
		const { state } = held()
		const calls = []
		state.onEpochChange = (needsState) => calls.push(needsState)
		assert.equal(state.applyState(snap({ rev: 2, epoch: 12 })), true)
		assert.equal(state.rev, 2)
		assert.deepEqual(calls, [false])
	})

	test('the same epoch changes nothing; a packet without one is not a change', () => {
		const { state } = held()
		assert.equal(state.observeEpoch(11), false)
		assert.equal(state.observeEpoch(undefined), false)
		assert.equal(state.rev, 500)
	})

	test('hello with a new epoch rebases quietly', () => {
		const { state } = held()
		assert.equal(state.applyState(snap({ rev: 1, epoch: 77 }), { hello: true }), true)
		assert.equal(state.epoch, 77)
		assert.equal(state.rev, 1)
	})
})

describe('rev gate', () => {
	test('state and timer need a strictly greater rev', () => {
		const state = new ModuleState()
		assert.equal(state.applyState(snap({ rev: 5 })), true)
		assert.equal(state.applyState(snap({ rev: 5 })), false)
		assert.equal(state.applyTimer({ rev: 5, timer: null }), false)
		assert.equal(state.applyTimer({ rev: 6, timer: null }), true)
		assert.equal(state.applyState(snap({ rev: 6 })), false)
	})

	test('a catch-up read also takes an equal rev, never an older one', () => {
		const state = new ModuleState()
		state.applyState(snap({ rev: 5, appMode: 'a' }))
		assert.equal(state.applyState(snap({ rev: 5, appMode: 'b' }), { catchUp: true }), true)
		assert.equal(state.snapshot.appMode, 'b')
		assert.equal(state.applyState(snap({ rev: 4, appMode: 'c' }), { catchUp: true }), false)
	})

	test('a jump of more than 1,000,000 is ignored unless hello, catch-up or a new epoch', () => {
		const state = new ModuleState()
		state.applyState(snap({ rev: 10, epoch: 1 }))
		assert.equal(state.applyState(snap({ rev: 10 + MAX_REV_JUMP + 1 })), false)
		assert.equal(state.applyTimer({ rev: 10 + MAX_REV_JUMP + 1, timer: null }), false)
		assert.equal(state.applyState(snap({ rev: 10 + MAX_REV_JUMP })), true)
		assert.equal(state.applyState(snap({ rev: 5_000_000 }), { catchUp: true }), true)
		assert.equal(state.applyState(snap({ rev: 9_000_000 }), { hello: true }), true)
		assert.equal(state.applyState(snap({ rev: 20_000_000, epoch: 2 })), true)
	})

	test('a packet without a rev is always taken', () => {
		const state = new ModuleState()
		state.applyState(snap({ rev: 50 }))
		assert.equal(state.applyState(snap({ rev: undefined })), true)
		assert.equal(state.rev, 50)
	})
})

describe('anchor bounds', () => {
	test('an anchor outside the ranges is ignored; the timer still applies with its pushed values', () => {
		const state = new ModuleState()
		state.setProtoVersion(2)
		for (const bad of [
			{ lengthInSeconds: 604801 },
			{ lengthInSeconds: -1 },
			{ elapsedMs: 604800001 },
			{ elapsedMs: -5 },
			{ elapsedMs: Number.NaN },
		]) {
			const fresh = new ModuleState()
			fresh.setProtoVersion(2)
			fresh.applyState(snap({ rev: 1, timer: activeTimer(anchor(bad)) }))
			assert.equal(fresh.timerAnchor, null, JSON.stringify(bad))
			assert.equal(fresh.timerRemainingSeconds, 7)
		}
		state.applyState(snap({ rev: 1, timer: activeTimer(anchor({ lengthInSeconds: 604800, elapsedMs: 604800000 })) }))
		assert.ok(state.timerAnchor)
		assert.equal(state.applyTimer({ rev: 2, timer: activeTimer(anchor({ lengthInSeconds: 999999999 })) }), true)
		assert.equal(state.timerAnchor, null)
	})
})

// MARK: - Session

const flush = async () => {
	for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve))
}

class FakeClock {
	now = 1_000_000
	timers = []
	nextId = 1
	setTimeout = (fn, ms) => {
		const id = this.nextId++
		this.timers.push({ id, at: this.now + ms, fn })
		return id
	}
	clearTimeout = (id) => {
		this.timers = this.timers.filter((t) => t.id !== id)
	}
	async advance(ms) {
		const end = this.now + ms
		for (;;) {
			await flush()
			const due = this.timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at || a.id - b.id)[0]
			if (!due) break
			this.timers = this.timers.filter((t) => t !== due)
			this.now = Math.max(this.now, due.at)
			due.fn()
		}
		this.now = end
		await flush()
	}
}

function harness(snapshot = snap({ rev: 5, epoch: 1 })) {
	const clock = new FakeClock()
	const state = new ModuleState(() => clock.now)
	if (snapshot) state.applyState(snapshot)
	const calls = []
	const log = { adopted: [], fetches: 0 }
	const session = new SyncSession({
		state,
		scheduler: clock,
		sendCommand: async (op, body) => {
			calls.push({ op, at: clock.now })
			if (op === 'proto') return { status: 200, data: { version: 2 } }
			if (op === 'sync') return { status: 200, data: { t0: body.t0, t1: body.t0 + 25, t2: body.t0 + 25 } }
			return { status: 404 }
		},
		fetchState: async () => {
			log.fetches++
			return harness.next ?? snap({ rev: 9, epoch: 1 })
		},
		adopt: (s) => {
			log.adopted.push(s)
			state.applyState(s, { catchUp: true })
		},
		onChange: () => {},
	})
	return { clock, state, session, calls, log }
}

const syncs = (h) => h.calls.filter((c) => c.op === 'sync').length

describe('session: restart, wake, epoch', () => {
	async function ready() {
		const h = harness()
		await h.session.start()
		await h.clock.advance(SYNC_BURST_GAP_MS * SYNC_BURST_COUNT)
		assert.equal(syncs(h), SYNC_BURST_COUNT)
		return h
	}

	test('start clears old samples; a reconnect measures from scratch', async () => {
		const h = harness()
		h.state.sync.addSample(h.clock.now, h.clock.now + 9999, h.clock.now + 9999, h.clock.now)
		await h.session.start()
		assert.equal(h.state.sync.hasOffset, false)
		h.session.stop()
	})

	test('a wall clock pulling away from the monotonic one (sleep, a clock step) restarts sync with a fresh burst', async () => {
		const h = await ready()
		h.session.checkWake(5_000_000)
		await h.clock.advance(1000)
		h.session.checkWake(5_001_000) // in step: nothing
		assert.equal(syncs(h), SYNC_BURST_COUNT)
		await h.clock.advance(1000)
		h.session.checkWake(5_001_000 + 1000 + 3000) // wall moved 3 s more than the monotonic clock
		await h.clock.advance(SYNC_BURST_GAP_MS * SYNC_BURST_COUNT)
		assert.equal(syncs(h), SYNC_BURST_COUNT * 2)
		h.session.stop()
	})

	test('a long gap between housekeeping ticks restarts it too; a steady tick does not', async () => {
		const h = await ready()
		h.session.checkWake(0)
		await h.clock.advance(1000)
		h.session.checkWake(1000)
		assert.equal(syncs(h), SYNC_BURST_COUNT)
		await h.clock.advance(6000)
		h.session.checkWake(7000)
		await h.clock.advance(SYNC_BURST_GAP_MS * SYNC_BURST_COUNT)
		assert.equal(syncs(h), SYNC_BURST_COUNT * 2)
		h.session.stop()
	})

	test('restarting drops every held sample', async () => {
		const h = await ready()
		assert.equal(h.state.sync.hasOffset, true)
		h.session.restartSync()
		assert.equal(h.state.sync.hasOffset, false)
		h.session.stop()
	})

	test('a digest with a new epoch restarts sync and fetches state once, whatever the hashes', async () => {
		const h = await ready()
		const matching = computeHashes(h.state.snapshot)
		harness.next = snap({ rev: 2, epoch: 2, appMode: 'fresh' })
		await h.session.handleDigest({ rev: 2, epoch: 2, hashes: matching })
		await h.clock.advance(SYNC_BURST_GAP_MS * SYNC_BURST_COUNT)
		harness.next = undefined
		assert.equal(h.log.fetches, 1)
		assert.equal(h.state.snapshot.appMode, 'fresh')
		assert.equal(h.state.epoch, 2)
		assert.equal(h.state.rev, 2)
		assert.equal(syncs(h), SYNC_BURST_COUNT * 2)
		h.session.stop()
	})

	test('a timer event with a new epoch does the same', async () => {
		const h = await ready()
		harness.next = snap({ rev: 4, epoch: 2, appMode: 'fresh' })
		h.state.applyTimer({ rev: 3, epoch: 2, timer: null })
		await h.clock.advance(SYNC_BURST_GAP_MS * SYNC_BURST_COUNT)
		harness.next = undefined
		assert.equal(h.log.fetches, 1)
		assert.equal(h.state.snapshot.appMode, 'fresh')
		assert.equal(syncs(h), SYNC_BURST_COUNT * 2)
		h.session.stop()
	})

	test('a digest repeating the held rev is verified (no gate advance); a lower or wildly higher one is ignored', async () => {
		const h = await ready()
		const bad = { ...computeHashes(h.state.snapshot), roles: '0000000000000000' }
		await h.session.handleDigest({ rev: 4, epoch: 1, hashes: bad })
		assert.equal(h.log.fetches, 0)
		await h.session.handleDigest({ rev: 5 + MAX_REV_JUMP + 1, epoch: 1, hashes: bad })
		assert.equal(h.log.fetches, 0)
		await h.session.handleDigest({ rev: 5, epoch: 1, hashes: bad })
		assert.equal(h.log.fetches, 1)
		assert.equal(h.state.rev, 9)
		h.session.stop()
	})

	test('a catch-up fetch at the held rev is adopted', async () => {
		const h = await ready()
		const bad = { ...computeHashes(h.state.snapshot), plan: '0000000000000000' }
		harness.next = snap({ rev: 5, epoch: 1, appMode: 'same-rev' })
		await h.session.handleDigest({ rev: 5, epoch: 1, hashes: bad })
		harness.next = undefined
		assert.equal(h.state.snapshot.appMode, 'same-rev')
		h.session.stop()
	})
})
