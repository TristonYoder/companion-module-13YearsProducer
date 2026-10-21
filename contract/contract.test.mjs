import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'

const BASE = (process.env.THIRTEENYEARS_URL ?? 'http://localhost:13390').replace(/\/+$/, '')
const { host, port } = (() => {
	const url = new URL(BASE)
	return { host: url.hostname, port: Number(url.port || 80) }
})()

const { ControlApi, ControlSocket, ApiError } = await import('../dist/api.js')
const { formatDuration, parseTimerInput, resolvedSeconds } = await import('../dist/timerEntry.js')
const { computeHashes } = await import('../dist/sync.js')

const api = new ControlApi(() => ({ host, port }))
let originalSelection

before(async () => {
	const health = await api.getHealth().catch((err) => {
		throw new Error(
			`Producer's Control API not reachable at ${BASE} (${err.message}). Enable it under Settings → Control API on the device under test, or point THIRTEENYEARS_URL at one that has it enabled.`,
		)
	})
	assert.equal(health.service, '13 Years Control API')

	originalSelection = await api.getSelection()
})

after(async () => {
	if (originalSelection) {
		await api.setSelection(originalSelection).catch(() => undefined)
	}
})

describe('health & state', () => {
	test('GET /v1/health identifies the service', async () => {
		const health = await api.getHealth()
		assert.equal(health.service, '13 Years Control API')
		assert.match(health.role, /^(master|client)$/)
	})

	test('GET /v1/state returns a full snapshot with the documented top-level shape', async () => {
		const state = await api.getState()
		assert.ok('appMode' in state)
		assert.ok('network' in state)
		assert.ok(Array.isArray(state.roles))
		assert.ok(Array.isArray(state.selectedRoleIds))
		assert.ok('plan' in state)
		assert.ok(Array.isArray(state.messages))
		assert.ok('pco' in state)
		assert.ok('plotiphar' in state)
		assert.ok('settings' in state)
	})
})

describe('revision stamps & slim timer (newer apps only)', () => {
	test('rev, when present, never goes backwards between reads', async () => {
		const first = await api.getState()
		if (typeof first.rev !== 'number') return
		const second = await api.getState()
		assert.ok(second.rev >= first.rev)
		assert.equal(typeof first.serverNowMs, 'number')
	})

	test('GET /v1/timer has the slim shape, when the route exists', async () => {
		const reply = await api.getTimer().catch((err) => {
			if (err instanceof ApiError && err.status === 404) return null
			throw err
		})
		if (!reply) return
		assert.ok('timer' in reply)
		assert.equal(typeof reply.rev, 'number')
	})

	test('a command reply is a full snapshot carrying a rev, when the app stamps one', async () => {
		const reply = await api.timerAdjust(0).catch((err) => {
			if (err instanceof ApiError && err.status === 409) return null
			throw err
		})
		if (!reply || typeof reply.rev !== 'number') return
		assert.ok(Array.isArray(reply.roles))
	})
})

describe('request timeout', () => {
	test('an unreachable host fails fast with a status-0 ApiError', async () => {
		const dead = new ControlApi(() => ({ host: '127.0.0.1', port: 1 }))
		const started = Date.now()
		await assert.rejects(
			() => dead.getHealth(),
			(err) => err instanceof ApiError && err.status === 0,
		)
		assert.ok(Date.now() - started < 4000)
	})
})

describe('roles & cues (reversible)', () => {
	test('firing a role cue GO then OFF round-trips through the real engine', async () => {
		const roles = await api.listRoles()
		if (roles.length === 0) {
			return
		}
		const role = roles[0]
		const before = await api.getRole(role.id)

		try {
			const afterGo = await api.fireRoleCue(role.id, 'GO')
			const updatedRole = afterGo.roles.find((r) => r.id === role.id)
			assert.equal(updatedRole?.state, 'GO')
		} finally {
			await api.fireRoleCue(role.id, before.state).catch(() => {})
		}
	})

	test('PUT /v1/selection accepts a known role id and GET /v1/selection reflects it', async () => {
		const roles = await api.listRoles()
		if (roles.length === 0) return
		const roleId = roles[0].id

		await api.setSelection([roleId])
		const selection = await api.getSelection()
		assert.ok(selection.includes(roleId))
	})

	test('PUT /v1/selection 404s on an unknown role id', async () => {
		await assert.rejects(
			() => api.setSelection(['definitely-not-a-real-role-id']),
			(err) => err instanceof ApiError && err.status === 404,
		)
	})
})

async function withPausedTimer(timer, body) {
	const wasRunning = timer.isRunning
	if (wasRunning) await api.timerPause()
	try {
		await body()
	} finally {
		if (wasRunning) await api.timerStart().catch(() => {})
	}
}

describe('timer (reversible)', () => {
	test('adjusting the timer by +5s then -5s nets to the same remaining time', async () => {
		const state = await api.getState()
		if (!state.timer) {
			return
		}

		await withPausedTimer(state.timer, async () => {
			const before = (await api.getState()).timer.remainingSeconds

			await api.timerAdjust(5)
			const afterUp = await api.getState()
			assert.equal(afterUp.timer.remainingSeconds, before + 5)

			await api.timerAdjust(-5)
			const afterDown = await api.getState()
			assert.equal(afterDown.timer.remainingSeconds, before)
		})
	})

	test('a typed "+5s" means the same to the app as it does to the local preview', async () => {
		const state = await api.getState()
		if (!state.timer) return

		const action = parseTimerInput('+5s')
		assert.deepEqual(action, { kind: 'adjustRelative', bySeconds: 5 })

		await withPausedTimer(state.timer, async () => {
			const before = (await api.getState()).timer.remainingSeconds

			await api.timerSetRemaining({ input: '+5s' })
			const afterUp = await api.getState()
			assert.equal(afterUp.timer.remainingSeconds, before + action.bySeconds)

			assert.equal(
				resolvedSeconds(action, before, state.timer.item.elapsedSeconds),
				Math.max(-state.timer.item.elapsedSeconds, before + action.bySeconds),
			)
			assert.equal(
				formatDuration(afterUp.timer.remainingSeconds, afterUp.settings.hourFormatThreshold),
				afterUp.timer.formattedRemaining,
			)

			await api.timerSetRemaining({ input: '-5s' })
			const afterDown = await api.getState()
			assert.equal(afterDown.timer.remainingSeconds, before)
		})
	})

	test('timer routes 409 when there is no active plan item', async () => {
		const state = await api.getState()
		if (state.timer) return
		await assert.rejects(
			() => api.timerStart(),
			(err) => err instanceof ApiError && err.status === 409,
		)
	})
})

describe('PCO and waypoint edge cases', () => {
	test('POST /v1/pco/service-type without a body is a 400', async () => {
		const res = await fetch(`${BASE}/v1/pco/service-type`, { method: 'POST' })
		if (res.status === 404) return
		assert.equal(res.status, 400)
	})

	test('default service type route and client method exist', async () => {
		assert.equal(typeof api.setPcoDefaultServiceType, 'function')
		assert.equal(typeof api.selectPcoServiceType, 'function')
		const res = await fetch(`${BASE}/v1/pco/default-service-type`, { method: 'POST' })
		if (res.status === 404) return
		assert.equal(res.status, 400)
	})

	test('unassigning an unknown waypoint is a 404', async () => {
		await assert.rejects(
			() => api.assignWaypoint('no-such-waypoint-zzz', null),
			(err) => err instanceof ApiError && err.status === 404,
		)
	})
})

describe('WebSocket', () => {
	test('opens, receives a hello event carrying the full state, and closes cleanly', async () => {
		const received = await new Promise((resolve, reject) => {
			const timeout = setTimeout(() => reject(new Error('Timed out waiting for a hello event')), 5000)
			const socket = new ControlSocket(
				() => ({ host, port }),
				{
					onHello: (state) => {
						clearTimeout(timeout)
						socket.close()
						resolve(state)
					},
					onError: (err) => {
						clearTimeout(timeout)
						reject(err)
					},
				},
			)
			socket.connect()
		})
		assert.ok('roles' in received)
		assert.ok('plan' in received)
	})
})

describe('sync protocol v2', () => {
	let link

	async function openV2() {
		const digests = []
		const timers = []
		const out = { digests, timers, hello: undefined, protoReply: undefined, socket: undefined }
		await new Promise((resolve, reject) => {
			const timeout = setTimeout(() => reject(new Error('Timed out negotiating proto')), 5000)
			out.socket = new ControlSocket(() => ({ host, port }), {
				onHello: (state) => {
					out.hello = state
				},
				onTimer: (timer) => timers.push(timer),
				onDigest: (digest) => digests.push(digest),
				onOpen: () => {
					out.socket
						.sendCommand('proto', { version: 2 })
						.then((reply) => {
							out.protoReply = reply
							clearTimeout(timeout)
							resolve()
						})
						.catch(reject)
				},
				onError: () => {},
			})
			out.socket.connect()
		})
		out.supported = out.protoReply.status === 200
		return out
	}

	before(async () => {
		link = await openV2()
	})

	after(() => {
		link?.socket.close()
	})

	test('proto is acknowledged with version 2', async (t) => {
		if (!link.supported) return t.skip('app does not speak sync protocol v2')
		assert.equal(link.protoReply.status, 200)
		assert.equal(link.protoReply.data.version, 2)
	})

	test('v2.1: hello carries a positive 31-bit epoch, and digests repeat it', { timeout: 20000 }, async (t) => {
		if (!link.supported) return t.skip('app does not speak sync protocol v2')
		const deadline = Date.now() + 5000
		while (!link.hello && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50))
		if (!link.hello) return t.skip('no hello received')
		if (link.hello.epoch === undefined) return t.skip('app does not send epoch (sync protocol v2.0)')
		assert.ok(Number.isInteger(link.hello.epoch))
		assert.ok(link.hello.epoch > 0 && link.hello.epoch <= 0x7fffffff, 'positive 31-bit integer')

		const until = Date.now() + 13000
		while (link.digests.length === 0 && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 100))
		assert.ok(link.digests.length > 0, 'a digest within 13 s')
		assert.equal(link.digests[0].epoch, link.hello.epoch)
		for (const timer of link.timers) if (timer.epoch !== undefined) assert.equal(timer.epoch, link.hello.epoch)
	})

	test('v2.1: GET /v1/state agrees with hello about the epoch', async (t) => {
		if (!link.supported) return t.skip('app does not speak sync protocol v2')
		if (link.hello?.epoch === undefined) return t.skip('app does not send epoch (sync protocol v2.0)')
		const state = await api.getState()
		if (state.epoch !== undefined) assert.equal(state.epoch, link.hello.epoch)
	})

	test('the sync op echoes t0 and answers t1 <= t2, over the socket and REST', async (t) => {
		if (!link.supported) return t.skip('app does not speak sync protocol v2')
		const t0 = Date.now()
		const reply = await link.socket.sendCommand('sync', { t0 })
		assert.equal(reply.status, 200)
		assert.equal(reply.data.t0, t0)
		assert.equal(typeof reply.data.t1, 'number')
		assert.equal(typeof reply.data.t2, 'number')
		assert.ok(reply.data.t1 <= reply.data.t2)

		const rest = await api.sync(t0)
		assert.equal(rest.t0, t0)
		assert.ok(rest.t1 <= rest.t2)
		assert.ok(Math.abs(rest.t1 - Date.now()) < 5000, 'app clock within seconds of this machine on a LAN test rig')
	})

	test('an active timer carries its anchor', async (t) => {
		if (!link.supported) return t.skip('app does not speak sync protocol v2')
		const state = await api.getState()
		if (!state.timer) return t.skip('no active timer in the plan under test')
		const { anchor } = state.timer
		assert.ok(anchor, 'timer.anchor present on v2')
		assert.equal(anchor.itemId, state.timer.item.id)
		assert.equal(typeof anchor.elapsedMs, 'number')
		assert.equal(typeof anchor.anchorMs, 'number')
		assert.equal(typeof anchor.isRunning, 'boolean')
		assert.equal(typeof anchor.lengthInSeconds, 'number')
		assert.equal(typeof anchor.isDurationActual, 'boolean')
	})

	test(
		'a digest arrives within ~12 s and equals the module-computed hashes of GET /v1/state',
		{ timeout: 40000 },
		async (t) => {
			if (!link.supported) return t.skip('app does not speak sync protocol v2')

			const nextDigest = async (after) => {
				const deadline = Date.now() + 13000
				while (link.digests.length <= after) {
					if (Date.now() > deadline) throw new Error('No digest within 13 s')
					await new Promise((resolve) => setTimeout(resolve, 100))
				}
				return link.digests[after]
			}

			let compared = false
			for (let i = 0; i < 3 && !compared; i++) {
				const digest = await nextDigest(i)
				for (const section of ['roles', 'timer', 'plan', 'messages']) {
					assert.match(digest.hashes[section], /^[0-9a-f]{16}$/, `${section} is 16 lowercase hex digits`)
				}
				assert.equal(typeof digest.rev, 'number')
				assert.equal(typeof digest.serverNowMs, 'number')
				const state = await api.getState()
				if (state.rev !== digest.rev) continue
				assert.deepEqual(computeHashes(state), digest.hashes)
				compared = true
			}
			if (!compared) t.diagnostic('state kept changing; hash equality not compared this run')
		},
	)
})

describe('run sheet and clock format (13 Years 1.7.0 and later)', () => {
	const unknownPath = (err) => err instanceof ApiError && err.status === 404 && err.message === 'Unknown path'

	test('settings.clockFormat, when present, is twelveHour or twentyFourHour', async (t) => {
		const state = await api.getState()
		if (state.settings.clockFormat === undefined) return t.skip('app does not report a clock format')
		assert.match(state.settings.clockFormat, /^(twelveHour|twentyFourHour)$/)
	})

	test('PATCH /v1/settings flips clockFormat and back, and rejects an unknown value', async (t) => {
		const before = (await api.getState()).settings.clockFormat
		if (before === undefined) return t.skip('app does not report a clock format')
		const other = before === 'twelveHour' ? 'twentyFourHour' : 'twelveHour'
		try {
			const flipped = await api.updateSettings({ clockFormat: other })
			assert.equal(flipped.clockFormat, other)
		} finally {
			await api.updateSettings({ clockFormat: before })
		}
		assert.equal((await api.getSettings()).clockFormat, before)
		await assert.rejects(api.updateSettings({ clockFormat: 'sundial' }), (err) => err.status === 400)
	})

	test('PATCH /v1/roles/{id} rejects an unknown clockFormat without changing the role', async (t) => {
		const state = await api.getState()
		if (state.settings.clockFormat === undefined) return t.skip('app does not report a clock format')
		const role = state.roles[0]
		if (!role) return t.skip('no roles on the show under test')
		await assert.rejects(
			api.updateRole(role.id, { name: 'renamed', clockFormat: 'sundial' }),
			(err) => err.status === 400,
		)
		assert.equal((await api.getRole(role.id)).name, role.name)
		assert.ok(
			role.clockFormat === undefined ||
				role.clockFormat === null ||
				/^(twelveHour|twentyFourHour)$/.test(role.clockFormat),
		)
	})

	test('liveOps, when present, has the documented shape', async (t) => {
		const { liveOps } = await api.getState()
		if (liveOps === undefined) return t.skip('app does not report liveOps')
		assert.equal(typeof liveOps.isRehearsalMode, 'boolean')
		assert.ok(Array.isArray(liveOps.actuals))
		assert.equal(typeof liveOps.skippedItemIds, 'object')
		for (const actual of liveOps.actuals) {
			assert.equal(typeof actual.itemId, 'string')
			assert.equal(typeof actual.startedAt, 'string')
		}
	})

	test('GET /v1/plan/actuals reports the live event time and whether it is logging', async (t) => {
		const reply = await api.getActuals().catch((err) => (unknownPath(err) ? null : Promise.reject(err)))
		if (!reply) return t.skip('app has no actuals route')
		assert.equal(typeof reply.isLogging, 'boolean')
		assert.ok(Array.isArray(reply.actuals))
	})

	test('skipping an item and unskipping it round-trips through GET /v1/plan/skips', async (t) => {
		const skips = await api.getSkips().catch((err) => (unknownPath(err) ? null : Promise.reject(err)))
		if (!skips) return t.skip('app has no skips route')
		assert.ok(Array.isArray(skips.skippedItemIds))
		assert.equal(typeof skips.all, 'object')
		const state = await api.getState()
		const candidate = state.plan.items.find(
			(item) => item.itemType.toLowerCase() !== 'header' && item.id !== state.timer?.item.id,
		)
		if (!candidate) return t.skip('no item other than the live one to skip')
		const wasSkipped = skips.skippedItemIds.includes(candidate.id)
		try {
			const changed = await api.setItemSkipped(candidate.id, !wasSkipped)
			assert.equal(changed.skippedItemIds.includes(candidate.id), !wasSkipped)
		} finally {
			await api.setItemSkipped(candidate.id, wasSkipped)
		}
		assert.equal((await api.getSkips()).skippedItemIds.includes(candidate.id), wasSkipped)
		await assert.rejects(api.setItemSkipped('no-such-item', true), (err) => err.status === 404)
	})

	test('rehearsal mode turns on and back off', async (t) => {
		const rehearsal = await api.getRehearsal().catch((err) => (unknownPath(err) ? null : Promise.reject(err)))
		if (!rehearsal) return t.skip('app has no rehearsal route')
		assert.equal(typeof rehearsal.enabled, 'boolean')
		assert.ok(Array.isArray(rehearsal.availableTimes))
		if (rehearsal.enabled) return t.skip('rehearsal is already on; leaving it alone')
		try {
			assert.equal((await api.setRehearsal(true)).enabled, true)
			assert.equal((await api.getState()).liveOps?.isRehearsalMode, true)
		} finally {
			await api.setRehearsal(false)
		}
		assert.equal((await api.getRehearsal()).enabled, false)
		await assert.rejects(api.setRehearsal(true, 'no-such-time'), (err) => err.status === 404)
	})

	test('saving actuals without a Planning Center plan is a 409', async (t) => {
		const state = await api.getState()
		if (state.liveOps === undefined) return t.skip('app does not report liveOps')
		if (state.plan.pcoPlanId) return t.skip('a Planning Center plan is loaded; not writing to it')
		await assert.rejects(api.saveActualsToPco(), (err) => err.status === 409)
	})
})
