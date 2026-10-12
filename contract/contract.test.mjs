// Contract tests against a REAL, running 13 Years Producer app.
//
// These drive the module's REAL compiled client (dist/api.js), not
// hand-written fetch calls — the thing under test is whether this module
// still works against the app's actual Control API, not whether some
// idealised request does.
//
// The app is a GUI app with the Control API off by default, so this can't
// run headless in ordinary CI. Point it at a Mac or iPad running 13 Years
// Producer with Settings → Control API turned on:
//
//   THIRTEENYEARS_URL=http://localhost:13390 npm run test:contract
//
// Every test here is written to be safe against a real, in-progress service:
// it prefers reversible operations (fire a cue then clear it, adjust the
// timer by some seconds then adjust back) over destructive ones (plan
// import, item delete, clearing message history), and restores whatever
// selection/cue state it changed in a `finally`.
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
	// Restore whatever was selected before this run touched it, so a real
	// in-progress service isn't left pointed at a role a test picked.
	if (originalSelection) {
		await api.setSelection(originalSelection).catch(() => {
			// Best-effort — if the roles that were selected no longer exist
			// there's nothing sensible to restore them to.
		})
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

// Newer app versions stamp snapshots with a monotonic rev and serve a slim
// timer route; an older app has neither, and the module must cope — so each
// check skips rather than fails when the field is absent.
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
			// Nothing to fire against on a service with no roles configured —
			// not a module failure, just nothing to exercise here.
			return
		}
		const role = roles[0]
		const before = await api.getRole(role.id)

		try {
			const afterGo = await api.fireRoleCue(role.id, 'GO')
			const updatedRole = afterGo.roles.find((r) => r.id === role.id)
			assert.equal(updatedRole?.state, 'GO')
		} finally {
			// Always return the role to whatever it was showing before this
			// test touched it, whether or not the assertion above passed.
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

// What the timer tests check is arithmetic on the timer's own value — that
// +5 then -5 is a no-op — not that wall-clock time stood still. Against a
// service whose countdown is actually running the clock ticks between two
// reads and turns any exact comparison into a coin flip, so hold it still for
// the duration and hand it back the way we found it. Both routes are
// idempotent, so this is safe on a service whose timer is already paused.
async function withPausedTimer(timer, body) {
	const wasRunning = timer.isRunning
	if (wasRunning) await api.timerPause()
	try {
		await body()
	} finally {
		// Restart even if an assertion threw — a failing test must not leave a
		// real in-progress service sitting on a stopped countdown.
		if (wasRunning) await api.timerStart().catch(() => {})
	}
}

describe('timer (reversible)', () => {
	test('adjusting the timer by +5s then -5s nets to the same remaining time', async () => {
		const state = await api.getState()
		if (!state.timer) {
			// No active plan item on this service — timer routes 409 by design;
			// nothing to exercise.
			return
		}

		await withPausedTimer(state.timer, async () => {
			// Read the baseline once the clock is held still — the snapshot
			// above was taken while it was still moving.
			const before = (await api.getState()).timer.remainingSeconds

			await api.timerAdjust(5)
			const afterUp = await api.getState()
			assert.equal(afterUp.timer.remainingSeconds, before + 5)

			await api.timerAdjust(-5)
			const afterDown = await api.getState()
			assert.equal(afterDown.timer.remainingSeconds, before)
		})
	})

	// The Timer Entry keypad's commit path: the keypad never parses what it's
	// about to send — it posts the raw typed text and lets the app's own parser
	// decide. This checks the two agree, since the keypad's *preview* does parse
	// locally (dist/timerEntry.js) and a silent drift there would show a
	// producer one number and set another.
	test('a typed "+5s" means the same to the app as it does to the local preview', async () => {
		const state = await api.getState()
		if (!state.timer) return // no active item — the route 409s by design

		const action = parseTimerInput('+5s')
		assert.deepEqual(action, { kind: 'adjustRelative', bySeconds: 5 })

		await withPausedTimer(state.timer, async () => {
			const before = (await api.getState()).timer.remainingSeconds

			await api.timerSetRemaining({ input: '+5s' })
			const afterUp = await api.getState()
			assert.equal(afterUp.timer.remainingSeconds, before + action.bySeconds)

			// A relative entry may push remaining negative (overtime); it floors at
			// minus the item's elapsed time, where the item's length would hit 0.
			assert.equal(
				resolvedSeconds(action, before, state.timer.item.elapsedSeconds),
				Math.max(-state.timer.item.elapsedSeconds, before + action.bySeconds),
			)
			// Whatever the number is, the app formats it exactly the way the preview
			// line does — both taken from the same snapshot.
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
		if (state.timer) return // an item is active on this service — nothing to assert here
		await assert.rejects(
			() => api.timerStart(),
			(err) => err instanceof ApiError && err.status === 409,
		)
	})
})

describe('PCO and waypoint edge cases', () => {
	test('POST /v1/pco/service-type without a body is a 400', async () => {
		const res = await fetch(`${BASE}/v1/pco/service-type`, { method: 'POST' })
		if (res.status === 404) return // route absent on this app version
		assert.equal(res.status, 400)
	})

	test('default service type route and client method exist', async () => {
		assert.equal(typeof api.setPcoDefaultServiceType, 'function')
		assert.equal(typeof api.selectPcoServiceType, 'function')
		// Mutating the live producer's PCO selection is not a reversible no-op, so only probe the error path.
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

// MARK: - Sync protocol v2
//
// Needs an app that speaks sync protocol v2 (Server/PROTOCOL-V2.md in the app
// repo). Against an older app each test skips itself. Nothing here changes
// app state: `proto` only affects this test's own socket, `sync` and the
// digest are read-only.
describe('sync protocol v2', () => {
	let link

	/** Opens a socket, offers `proto` 2, and collects the events it then receives. */
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

			// Another client changing state between digest and fetch would make the comparison meaningless, so only compare when the revs agree.
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
