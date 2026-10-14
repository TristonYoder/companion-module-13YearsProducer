import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

const { SyncSession, SYNC_BURST_COUNT, SYNC_BURST_GAP_MS, SYNC_INTERVAL_MS, COMMAND_TIMEOUT_MS } =
	await import('../dist/session.js')
const { ModuleState } = await import('../dist/state.js')
const { computeHashes } = await import('../dist/sync.js')

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

function harness({ producerOffset = 0, oneWay = 0, proto = 200, snapshot = snap() } = {}) {
	const clock = new FakeClock()
	const state = new ModuleState(() => clock.now)
	if (snapshot) state.applyState(snapshot)
	const calls = []
	const log = { changes: 0, adopted: [], fetches: 0, protocol: [] }
	const session = new SyncSession({
		state,
		scheduler: clock,
		sendCommand: async (op, body) => {
			calls.push({ op, body, at: clock.now })
			if (op === 'proto') return proto === 'hang' ? new Promise(() => {}) : { status: proto, data: { version: 2 } }
			if (op === 'sync') {
				const t1 = body.t0 + oneWay + producerOffset
				clock.now += oneWay * 2
				return { status: 200, data: { t0: body.t0, t1, t2: t1 } }
			}
			return { status: 404 }
		},
		fetchState: async () => {
			log.fetches++
			return harness.nextState ?? snap({ rev: 2 })
		},
		adopt: (s) => {
			log.adopted.push(s)
			state.applyState(s)
		},
		onChange: () => log.changes++,
		onProtocol: (v) => log.protocol.push(v),
	})
	return { clock, state, session, calls, log }
}

describe('proto negotiation', () => {
	test('sends proto {version: 2} first and switches to v2 on 200', async () => {
		const h = harness()
		await h.session.start()
		assert.deepEqual(h.calls[0], { op: 'proto', body: { version: 2 }, at: h.clock.now })
		assert.equal(h.state.protoVersion, 2)
		assert.deepEqual(h.log.protocol, [2])
		h.session.stop()
	})

	test('an app that answers proto with an error stays legacy: no sync traffic, legacy stale threshold and pushed timer', async () => {
		const h = harness({ proto: 404, snapshot: snap({ timer: activeTimer(anchor()) }) })
		await h.session.start()
		await h.clock.advance(120000)
		assert.deepEqual(
			h.calls.map((c) => c.op),
			['proto'],
		)
		assert.equal(h.state.protoVersion, 1)
		assert.equal(h.state.staleAfterMs, 8000)
		assert.equal(h.state.timerRemainingSeconds, 7)
		assert.equal(h.state.sync.hasOffset, false)
		assert.equal(h.log.changes, 0)
		assert.equal(h.clock.timers.length, 0)
	})

	test('a proto that never answers times out into legacy', async () => {
		const h = harness({ proto: 'hang' })
		const started = h.session.start()
		await h.clock.advance(COMMAND_TIMEOUT_MS + 1)
		await started
		assert.equal(h.state.protoVersion, 1)
	})

	test('stop() drops back to legacy and cancels every timer', async () => {
		const h = harness({ snapshot: snap({ timer: activeTimer(anchor({ anchorMs: 1_000_000 })) }) })
		await h.session.start()
		await h.clock.advance(500)
		h.session.stop()
		assert.equal(h.state.protoVersion, 1)
		assert.deepEqual(h.log.protocol, [2, 1])
		assert.equal(h.clock.timers.length, 0)
		const calls = h.calls.length
		await h.clock.advance(120000)
		assert.equal(h.calls.length, calls)
	})
})

describe('clock sync scheduling', () => {
	test('a burst of 5 samples 100 ms apart on connect, then one every 30 s', async () => {
		const h = harness()
		await h.session.start()
		const t0 = h.clock.now
		await h.clock.advance(SYNC_BURST_GAP_MS * SYNC_BURST_COUNT)
		let syncs = h.calls.filter((c) => c.op === 'sync')
		assert.equal(syncs.length, SYNC_BURST_COUNT)
		assert.deepEqual(
			syncs.map((c) => c.at - t0),
			[0, 100, 200, 300, 400],
		)
		await h.clock.advance(SYNC_INTERVAL_MS - 150)
		assert.equal(h.calls.filter((c) => c.op === 'sync').length, SYNC_BURST_COUNT)
		await h.clock.advance(100)
		assert.equal(h.calls.filter((c) => c.op === 'sync').length, SYNC_BURST_COUNT + 1)
		await h.clock.advance(SYNC_INTERVAL_MS)
		assert.equal(h.calls.filter((c) => c.op === 'sync').length, SYNC_BURST_COUNT + 2)
		h.session.stop()
	})

	test('measures the offset and the round trip', async () => {
		const h = harness({ producerOffset: 750, oneWay: 15 })
		await h.session.start()
		await h.clock.advance(1000)
		assert.ok(Math.abs(h.state.sync.offsetMs - 750) < 1e-9)
		assert.equal(h.state.sync.rttMs, 30)
		assert.equal(h.state.producerNowMs(), h.clock.now + 750)
		h.session.stop()
	})
})

describe('local timer tick', () => {
	test('fires on anchorMs + k*1000 of the producer clock, whatever the offset', async () => {
		const offset = 333
		const h = harness({ producerOffset: offset })
		const producerNow = h.clock.now + offset
		const a = anchor({ anchorMs: producerNow - 600, lengthInSeconds: 10 })
		h.state.applyState(snap({ rev: 2, timer: activeTimer(a) }))
		await h.session.start()
		await h.clock.advance(SYNC_BURST_GAP_MS * SYNC_BURST_COUNT)
		h.log.changes = 0

		const seen = []
		const samples = []
		for (let i = 0; i < 4; i++) {
			const before = h.log.changes
			let guard = 0
			while (h.log.changes === before && guard++ < 1500) await h.clock.advance(1)
			samples.push({ producer: h.clock.now + offset, remaining: h.state.timerRemainingSeconds })
			seen.push((h.clock.now + offset - a.anchorMs) % 1000)
		}
		for (const s of seen) assert.ok(s === 0 || s === 1, `tick landed ${s} ms off the boundary`)
		const remainings = samples.map((s) => s.remaining)
		for (let i = 1; i < remainings.length; i++) assert.equal(remainings[i], remainings[i - 1] - 1)
		h.session.stop()
	})

	test('does not tick while paused, and rearms when an anchor starts running', async () => {
		const h = harness({ snapshot: snap({ timer: activeTimer(anchor({ isRunning: false, anchorMs: 0 })) }) })
		await h.session.start()
		await h.clock.advance(SYNC_BURST_GAP_MS * SYNC_BURST_COUNT)
		h.log.changes = 0
		await h.clock.advance(5000)
		assert.equal(h.log.changes, 0)

		h.state.applyTimer({ rev: 2, timer: activeTimer(anchor({ anchorMs: h.clock.now, elapsedMs: 0 })) })
		h.session.scheduleTick()
		await h.clock.advance(3000)
		assert.equal(h.log.changes, 3)
		assert.equal(h.state.timerRemainingSeconds, 57)
		h.session.stop()
	})

	test('legacy never schedules a tick', async () => {
		const h = harness({ proto: 404, snapshot: snap({ timer: activeTimer(anchor()) }) })
		await h.session.start()
		h.session.scheduleTick()
		assert.equal(h.clock.timers.length, 0)
	})
})

describe('digest', () => {
	async function ready(snapshot = snap({ rev: 5, timer: activeTimer(anchor({ anchorMs: 1 })) })) {
		const h = harness({ snapshot })
		await h.session.start()
		await h.clock.advance(SYNC_BURST_GAP_MS * SYNC_BURST_COUNT)
		return h
	}

	test('matching hashes cost nothing', async () => {
		const h = await ready()
		await h.session.handleDigest({ rev: 5, hashes: computeHashes(h.state.snapshot) })
		assert.equal(h.log.fetches, 0)
		h.session.stop()
	})

	test('any differing section triggers exactly one GET /v1/state, adopted through the rev guard', async () => {
		const h = await ready()
		const hashes = { ...computeHashes(h.state.snapshot), messages: 'ffffffffffffffff' }
		harness.nextState = snap({ rev: 6, roles: [{ id: 'host', name: 'Host', state: 'GO' }] })
		await h.session.handleDigest({ rev: 6, hashes })
		assert.equal(h.log.fetches, 1)
		assert.equal(h.log.adopted.length, 1)
		assert.equal(h.state.roles[0].state, 'GO')
		assert.equal(h.state.rev, 6)
		harness.nextState = undefined
		h.session.stop()
	})

	test('digests arriving while the fetch is in flight do not stack fetches', async () => {
		const h = await ready()
		const hashes = { ...computeHashes(h.state.snapshot), roles: '0000000000000000' }
		await Promise.all([
			h.session.handleDigest({ rev: 5, hashes }),
			h.session.handleDigest({ rev: 5, hashes }),
			h.session.handleDigest({ rev: 5, hashes }),
		])
		assert.equal(h.log.fetches, 1)
		h.session.stop()
	})

	test('a digest older than the held rev is ignored; a stale fetch cannot roll the state back', async () => {
		const h = await ready()
		await h.session.handleDigest({ rev: 4, hashes: { roles: '0000000000000000' } })
		assert.equal(h.log.fetches, 0)
		const hashes = { ...computeHashes(h.state.snapshot), plan: '1111111111111111' }
		harness.nextState = snap({ rev: 3, appMode: 'old' })
		await h.session.handleDigest({ rev: 5, hashes })
		assert.equal(h.log.fetches, 1)
		assert.equal(h.state.snapshot.appMode, undefined)
		assert.equal(h.state.rev, 5)
		harness.nextState = undefined
		h.session.stop()
	})

	test('without a snapshot a digest fetches one', async () => {
		const h = await ready(null)
		await h.session.handleDigest({ rev: 1, hashes: computeHashes(snap()) })
		assert.equal(h.log.fetches, 1)
		h.session.stop()
	})

	test('digests are ignored on a legacy link', async () => {
		const h = harness({ proto: 404 })
		await h.session.start()
		await h.session.handleDigest({ rev: 9, hashes: { roles: '0000000000000000' } })
		assert.equal(h.log.fetches, 0)
	})

	test('a failed fetch is survived and the next mismatch tries again', async () => {
		const h = await ready()
		const hashes = { ...computeHashes(h.state.snapshot), timer: '2222222222222222' }
		let attempts = 0
		const original = h.session.deps.fetchState
		h.session.deps.fetchState = async () => {
			attempts++
			if (attempts === 1) throw new Error('boom')
			return original()
		}
		await h.session.handleDigest({ rev: 5, hashes })
		await h.session.handleDigest({ rev: 5, hashes })
		assert.equal(attempts, 2)
		h.session.stop()
	})
})
