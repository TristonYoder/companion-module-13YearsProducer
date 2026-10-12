import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import { WebSocketServer } from 'ws'

const { normalizeHost, resolveConnection, connectionChanged, describeConnectionError } =
	await import('../dist/connection.js')
const { ControlSocket, ControlApi, ApiError } = await import('../dist/api.js')
const { ModuleState } = await import('../dist/state.js')
const { getVariableValues } = await import('../dist/variables.js')
const { startTimerDefaultUpgrade, lengthTextUpgrade, upgradeScripts } = await import('../dist/upgrades.js')

describe('host and port', () => {
	test('trims, accepts names and IPv4, brackets IPv6', () => {
		assert.deepEqual(normalizeHost('  10.0.0.5 '), { ok: true, host: '10.0.0.5' })
		assert.deepEqual(normalizeHost('producer.local'), { ok: true, host: 'producer.local' })
		assert.deepEqual(normalizeHost('fe80::1'), { ok: true, host: '[fe80::1]' })
		assert.deepEqual(normalizeHost('[::1]'), { ok: true, host: '[::1]' })
		assert.deepEqual(normalizeHost('fe80::1%en0'), { ok: true, host: '[fe80::1%25en0]' })
	})

	test('rejects empty, URLs, paths, host:port and junk with a reason', () => {
		for (const bad of [
			'',
			'   ',
			undefined,
			'http://10.0.0.5',
			'10.0.0.5/v1',
			'10.0.0.5:13390',
			'a b',
			'[nope]',
			'a@b',
		]) {
			const result = normalizeHost(bad)
			assert.equal(result.ok, false, String(bad))
			assert.ok(result.reason.length > 0)
		}
	})

	test('a URL built from a bracketed IPv6 host parses', () => {
		const connection = resolveConnection({ host: 'fe80::1', port: 13390 })
		assert.equal(connection.ok, true)
		assert.equal(new URL(`ws://${connection.host}:${connection.port}/v1/socket`).port, '13390')
	})

	test('port: missing means the default, anything unusable is rejected', () => {
		assert.equal(resolveConnection({ host: 'a' }).port, 13390)
		assert.equal(resolveConnection({ host: 'a', port: '8080' }).port, 8080)
		for (const bad of [0, 70000, 1.5, 'abc']) assert.equal(resolveConnection({ host: 'a', port: bad }).ok, false)
	})

	test('only host or port changes mean a reconnect', () => {
		const base = { host: '10.0.0.5', port: 13390, overtimeRed: true }
		assert.equal(connectionChanged(base, { ...base, overtimeRed: false }), false)
		assert.equal(connectionChanged(base, { ...base, host: ' 10.0.0.5 ' }), false)
		assert.equal(connectionChanged(base, { ...base, host: '10.0.0.6' }), true)
		assert.equal(connectionChanged(base, { ...base, port: 13391 }), true)
		assert.equal(connectionChanged(base, { ...base, host: '' }), true)
		assert.equal(connectionChanged({ host: '' }, { host: '   ' }), false)
	})
})

describe('connection error messages', () => {
	test('map the failures an operator can act on', () => {
		const refused = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })
		assert.match(describeConnectionError(refused), /Connection refused — turn on Settings → Control API/)
		const wrapped = new TypeError('fetch failed', { cause: refused })
		assert.match(describeConnectionError(wrapped), /Connection refused/)
		const aggregate = Object.assign(new Error('x'), {
			errors: [Object.assign(new Error('y'), { code: 'ECONNREFUSED' })],
		})
		assert.match(describeConnectionError(aggregate), /Connection refused/)
		assert.equal(
			describeConnectionError(Object.assign(new Error('t'), { code: 'ETIMEDOUT' })),
			'Timed out reaching host',
		)
		assert.equal(describeConnectionError(new Error('Opening handshake has timed out')), 'Timed out reaching host')
		assert.equal(
			describeConnectionError(Object.assign(new Error('t'), { name: 'TimeoutError' })),
			'Timed out reaching host',
		)
		assert.match(describeConnectionError(Object.assign(new Error('x'), { code: 'ENOTFOUND' })), /Host not found/)
		assert.match(
			describeConnectionError(new Error('Unexpected server response: 404')),
			/not serving the Control API \(404\)/,
		)
		assert.match(describeConnectionError(new Error('Unexpected server response: 502')), /upgrade failed \(HTTP 502\)/)
		assert.equal(describeConnectionError(new Error('something else')), null)
	})

	test('a REST call to a closed port says why', async () => {
		const server = net.createServer()
		await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
		const { port } = server.address()
		await new Promise((resolve) => server.close(resolve))
		const api = new ControlApi(() => ({ host: '127.0.0.1', port }))
		await assert.rejects(
			() => api.getHealth(),
			(err) => err instanceof ApiError && err.status === 0 && /Connection refused — turn on Settings/.test(err.message),
		)
	})
})

async function wsServer(onConnection) {
	const server = http.createServer()
	const wss = new WebSocketServer({ server, path: '/v1/socket' })
	wss.on('connection', onConnection)
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
	return {
		port: server.address().port,
		async close() {
			for (const client of wss.clients) client.terminate()
			wss.close()
			server.closeAllConnections?.()
			await new Promise((resolve) => server.close(resolve))
		},
	}
}

const until = async (predicate, ms = 3000) => {
	const deadline = Date.now() + ms
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error('timed out waiting')
		await new Promise((resolve) => setTimeout(resolve, 10))
	}
}

describe('ControlSocket', () => {
	test('a command with no reply times out and is pruned from pending', async () => {
		const srv = await wsServer(() => {})
		const socket = new ControlSocket(() => ({ host: '127.0.0.1', port: srv.port }), {}, { commandTimeoutMs: 80 })
		socket.connect()
		await until(() => socket.isOpen)
		await assert.rejects(() => socket.sendCommand('sync', { t0: 1 }), /sync timed out/)
		assert.equal(socket.pendingCount, 0)
		socket.close()
		await srv.close()
	})

	test('a reply resolves it and clears the entry; a close rejects what is still waiting', async () => {
		let serverSide
		const srv = await wsServer((ws) => {
			serverSide = ws
			ws.on('message', (raw) => {
				const { id, op } = JSON.parse(raw.toString())
				if (op === 'ping') ws.send(JSON.stringify({ id, status: 200, data: {} }))
			})
		})
		const closes = []
		const socket = new ControlSocket(() => ({ host: '127.0.0.1', port: srv.port }), { onClose: (r) => closes.push(r) })
		socket.connect()
		await until(() => socket.isOpen)
		assert.equal((await socket.sendCommand('ping')).status, 200)
		assert.equal(socket.pendingCount, 0)
		const rejected = assert.rejects(() => socket.sendCommand('hang'), /Socket closed/)
		serverSide.terminate()
		await rejected
		assert.equal(socket.pendingCount, 0)
		await until(() => closes.length > 0)
		assert.equal(closes[0], 'closed')
		socket.close()
		await srv.close()
	})

	test('a server that accepts TCP but never upgrades fails the handshake with a timeout message', async () => {
		const sockets = []
		const dead = net.createServer((s) => sockets.push(s))
		await new Promise((resolve) => dead.listen(0, '127.0.0.1', resolve))
		const reasons = []
		const socket = new ControlSocket(
			() => ({ host: '127.0.0.1', port: dead.address().port }),
			{ onClose: (r) => reasons.push(r), onError: () => {} },
			{ handshakeTimeoutMs: 150 },
		)
		socket.connect()
		await until(() => reasons.length > 0)
		assert.equal(reasons[0], 'Timed out reaching host')
		socket.close()
		for (const s of sockets) s.destroy()
		await new Promise((resolve) => dead.close(resolve))
	})

	test('refused connections and a 404 on the upgrade name their cause', async () => {
		const probe = net.createServer()
		await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve))
		const closedPort = probe.address().port
		await new Promise((resolve) => probe.close(resolve))

		const refused = []
		const a = new ControlSocket(() => ({ host: '127.0.0.1', port: closedPort }), {
			onClose: (r) => refused.push(r),
			onError: () => {},
		})
		a.connect()
		await until(() => refused.length > 0)
		assert.match(refused[0], /Connection refused — turn on Settings → Control API/)
		a.close()

		const plain = http.createServer((req, res) => {
			res.statusCode = 404
			res.end()
		})
		await new Promise((resolve) => plain.listen(0, '127.0.0.1', resolve))
		const notFound = []
		const b = new ControlSocket(() => ({ host: '127.0.0.1', port: plain.address().port }), {
			onClose: (r) => notFound.push(r),
			onError: () => {},
		})
		b.connect()
		await until(() => notFound.length > 0)
		assert.match(notFound[0], /not serving the Control API \(404\)/)
		b.close()
		await new Promise((resolve) => plain.close(resolve))
	})

	test('only data frames count as activity; a pong does not', async () => {
		let serverSide
		const srv = await wsServer((ws) => {
			serverSide = ws
		})
		let frames = 0
		const socket = new ControlSocket(() => ({ host: '127.0.0.1', port: srv.port }), { onFrame: () => frames++ })
		socket.connect()
		await until(() => socket.isOpen && serverSide)
		serverSide.ping()
		await new Promise((resolve) => setTimeout(resolve, 100))
		assert.equal(frames, 0)
		serverSide.send(JSON.stringify({ event: 'message', data: { id: 'x' } }))
		await until(() => frames === 1)
		socket.close()
		await srv.close()
	})
})

describe('state reset (a closed connection leaves no stale values)', () => {
	test('reset forgets the snapshot, connection and sync, and variables fall back', () => {
		const state = new ModuleState()
		state.setProtoVersion(2)
		state.setSocketConnected(true)
		state.applyState({
			rev: 3,
			epoch: 4,
			roles: [{ id: 'r', name: 'Host', state: 'GO', personName: 'Pat' }],
			selectedRoleIds: [],
			timer: null,
			plan: { title: 'Sunday', items: [], activeItemIndex: 0 },
			messages: [],
			waypoints: [],
			schedules: { entries: [], nextId: null },
			settings: { hourFormatThreshold: 'over90Minutes' },
		})
		state.sync.addSample(0, 10, 10, 0)
		assert.equal(getVariableValues(state).connection_status, 'connected')
		state.reset()
		const values = getVariableValues(state)
		assert.equal(values.connection_status, 'disconnected')
		assert.equal(values.plan_title, '')
		assert.equal(values.role_count, 0)
		assert.equal(values.sync_quality, 'legacy')
		assert.equal(state.snapshot, null)
		assert.equal(state.rev, null)
		assert.equal(state.epoch, null)
		assert.equal(state.protoVersion, 1)
		assert.equal(state.sync.hasOffset, false)
		assert.equal(state.applyState({ rev: 1, roles: [], plan: { items: [] }, selectedRoleIds: [] }), true)
	})

	test('the keypad buffer is the operator’s and survives', () => {
		const state = new ModuleState()
		state.appendTimerEntry('5')
		state.reset()
		assert.equal(state.timerEntryBuffer, '5')
	})
})

describe('startTimer upgrade', () => {
	const act = (actionId, options) => ({ id: actionId + Math.random(), controlId: 'c', actionId, options })
	const run = (actions) =>
		startTimerDefaultUpgrade({ currentConfig: {} }, { config: null, secrets: null, actions, feedbacks: [] })

	test('sets startTimer true where there is no value, on the three actions only', () => {
		const actions = [
			act('planNext', {}),
			act('planPrevious', {}),
			act('waypointNext', {}),
			act('planNext', { startTimer: false }),
			act('planPrevious', { startTimer: true }),
			act('timerStart', {}),
			act('planNext', { ignoreRepeatMs: 5 }),
		]
		const result = run(actions)
		assert.deepEqual(
			result.updatedActions.map((a) => [a.actionId, a.options.startTimer]),
			[
				['planNext', true],
				['planPrevious', true],
				['waypointNext', true],
				['planNext', true],
			],
		)
		assert.equal(actions[3].options.startTimer, false)
		assert.equal(actions[5].options.startTimer, undefined)
		assert.equal(result.updatedConfig, null)
		assert.deepEqual(result.updatedFeedbacks, [])
	})

	test('is registered, and a second run has nothing left to do', () => {
		assert.deepEqual(upgradeScripts, [startTimerDefaultUpgrade, lengthTextUpgrade])
		const actions = [act('planNext', {})]
		run(actions)
		assert.deepEqual(run(actions).updatedActions, [])
	})
})

describe('lengthTextUpgrade', () => {
	const act = (actionId, options) => ({ id: 'a', controlId: 'c', actionId, options })
	const run = (actions) => lengthTextUpgrade({}, { config: null, secrets: null, actions, feedbacks: [] })

	test('numeric lengths become text, zero becomes empty, other actions are untouched', () => {
		const actions = [
			act('planAddItem', { lengthInSeconds: 300 }),
			act('planUpdateItem', { lengthInSeconds: 0 }),
			act('planUpdateItem', { lengthInSeconds: 90 }),
			act('timerAdjust', { seconds: 30 }),
		]
		const result = run(actions)
		assert.equal(result.updatedActions.length, 3)
		assert.deepEqual(
			actions.map((a) => a.options.lengthInSeconds),
			['300', '', '90', undefined],
		)
		assert.equal(run(actions).updatedActions.length, 0)
	})
})
