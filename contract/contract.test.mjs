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

			// The app itself keeps counting into overtime (remainingSeconds goes
			// negative); the keypad's preview clamps at 0 exactly as the app's own
			// popover does, so the two only line up above zero.
			if (before + action.bySeconds < 0) {
				assert.equal(resolvedSeconds(action, before), 0)
			}
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
