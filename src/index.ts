import {
	InstanceBase,
	InstanceStatus,
	runEntrypoint,
	type CompanionVariableValues,
	type SomeCompanionConfigField,
} from '@companion-module/base'
import { ApiError, ControlApi, ControlSocket } from './api.js'
import { getConfigFields, type ModuleConfig } from './config.js'
import { connectionChanged, describeConnectionError, resolveConnection } from './connection.js'
import { upgradeScripts } from './upgrades.js'
import { getActionDefinitions, type ActionDeps } from './actions.js'
import { getFeedbackDefinitions } from './feedbacks.js'
import { getVariableDefinitions, getVariableValues } from './variables.js'
import { getPresetDefinitions } from './presets.js'
import { ModuleState } from './state.js'
import { SyncSession } from './session.js'
import type { ControlAPIState } from './types.js'

/** Variables the countdown-driven feedbacks (`timerOvertime`, `timerUnderThreshold`, the progress bar) follow. */
const TIMER_FEEDBACK_VARIABLES = new Set([
	'active_item_remaining_seconds',
	'active_item_is_overtime',
	'active_item_progress_pct',
])

class ThirteenYearsProducerInstance extends InstanceBase<ModuleConfig> {
	private config!: ModuleConfig
	private api!: ControlApi
	private socket!: ControlSocket
	private state = new ModuleState()
	private session!: SyncSession
	private lastVariableValues: CompanionVariableValues = {}
	private definitionSignature = ''
	private staleTimer: ReturnType<typeof setInterval> | undefined
	private wasStale = false
	private lastActionError = ''

	async init(config: ModuleConfig, _isFirstInit: boolean): Promise<void> {
		this.config = config
		this.api = new ControlApi(
			() => this.resolvedConfig(),
			(snapshot) => this.applyReply(snapshot),
		)
		this.socket = new ControlSocket(() => this.resolvedConfig(), {
			onOpen: () => {
				this.log('info', 'Connected to Control API socket')
				void this.session.start()
			},
			onHello: (snapshot) => this.handleSnapshot(snapshot, true),
			onState: (snapshot) => this.handleSnapshot(snapshot),
			onTimer: (timer) => {
				if (!this.state.applyTimer(timer)) return
				this.session.scheduleTick()
				this.pushDerivedState()
			},
			onDigest: (digest) => void this.session.handleDigest(digest),
			onFrame: () => this.state.markFrame(),
			onMessage: (message) => {
				this.state.applyMessage(message)
				this.pushDerivedState()
			},
			onClose: (reason) => {
				this.session.stop()
				this.state.setSocketConnected(false)
				if (reason === 'closed') {
					this.updateStatus(InstanceStatus.Disconnected, 'Control socket closed — reconnecting')
				} else {
					this.updateStatus(InstanceStatus.ConnectionFailure, `${reason} — retrying`)
				}
				this.pushDerivedState()
			},
			onError: (err) => {
				this.log('warn', `Control socket error: ${err.message}`)
			},
		})

		this.session = new SyncSession({
			state: this.state,
			sendCommand: async (op, body) => this.socket.sendCommand(op, body),
			fetchState: async () => this.api.getState(),
			adopt: (snapshot) => this.applyReply(snapshot, true),
			onChange: () => this.pushTimerState(),
			onProtocol: (version) => this.socket.setProtocolV2(version === 2),
			log: (level, message) => this.log(level, message),
		})

		this.refreshDynamicDefinitions(true)

		this.staleTimer = setInterval(() => this.checkStale(), 1000)

		this.updateStatus(InstanceStatus.Connecting)
		await this.primeAndConnect()
	}

	async destroy(): Promise<void> {
		if (this.staleTimer) clearInterval(this.staleTimer)
		this.session?.stop()
		this.socket?.close()
	}

	/** Only a different host or port is a different connection; other options (overtimeRed ...) just rebuild what they shape. */
	async configUpdated(config: ModuleConfig): Promise<void> {
		const reconnect = connectionChanged(this.config, config)
		this.config = config
		if (!reconnect) {
			this.refreshDynamicDefinitions(true)
			return
		}
		this.disconnect()
		this.refreshDynamicDefinitions(true)
		this.pushDerivedState()
		this.updateStatus(InstanceStatus.Connecting)
		await this.primeAndConnect()
	}

	/** Tears the link down and forgets everything the old one said, so no variable or feedback keeps describing a connection that is gone. */
	private disconnect(): void {
		this.session.stop()
		this.socket.close()
		this.state.reset()
		this.wasStale = false
	}

	getConfigFields(): SomeCompanionConfigField[] {
		return getConfigFields()
	}

	private resolvedConfig(): { host: string; port: number } {
		const connection = resolveConnection(this.config)
		return connection.ok ? { host: connection.host, port: connection.port } : { host: '', port: 0 }
	}

	/** `refresh` is what the Timer Entry keypad actions call: its buffer lives in `ModuleState`, so nothing on the app's side will push the change back for us. */
	private actionDeps(): ActionDeps {
		return {
			api: this.api,
			state: this.state,
			log: (level, message) => this.log(level, message),
			refresh: () => {
				this.lastActionError = this.state.currentActionError
				this.pushDerivedState()
			},
		}
	}

	/** Once a second: wake/clock-step detection for clock sync, then only transitions (stale/fresh, an action error appearing or expiring) are announced; a quiet link costs nothing per tick. */
	private checkStale(): void {
		this.session.checkWake(Date.now())
		const stale = this.state.isStale
		const actionError = this.state.currentActionError
		if (stale === this.wasStale && actionError === this.lastActionError) return
		this.wasStale = stale
		this.lastActionError = actionError
		this.pushDerivedState()
	}

	/** Sends only the variables whose value moved since the last push. */
	private pushVariables(): string[] {
		const values = getVariableValues(this.state)
		const changed: CompanionVariableValues = {}
		const keys: string[] = []
		for (const [key, value] of Object.entries(values)) {
			if (this.lastVariableValues[key] === value) continue
			changed[key] = value
			keys.push(key)
		}
		this.lastVariableValues = values
		if (keys.length > 0) this.setVariableValues(changed)
		return keys
	}

	private pushDerivedState(): void {
		this.pushVariables()
		this.checkFeedbacks()
	}

	/** The local timer ticked, or a clock sample landed: nothing but the countdown-derived values can have moved, so only those feedbacks are re-evaluated, and only if a variable they follow changed. */
	private pushTimerState(): void {
		const changed = this.pushVariables()
		if (changed.some((key) => TIMER_FEEDBACK_VARIABLES.has(key))) {
			this.checkFeedbacks('timerOvertime', 'timerUnderThreshold', 'activeItemProgressBar')
		}
	}

	/**
	 * One REST `GET /v1/state` to prime the instance immediately (so status/
	 * variables aren't blank while a slower first WebSocket handshake completes),
	 * then opens the socket, which becomes the sole source of state from that
	 * point on (its own `hello` event supersedes this priming read). This is the
	 * only place this module ever polls a GET route on demand rather than
	 * reacting to a push — everything after this call is push-driven.
	 */
	private async primeAndConnect(): Promise<void> {
		const connection = resolveConnection(this.config)
		if (!connection.ok) {
			this.disconnect()
			this.refreshDynamicDefinitions(true)
			this.pushDerivedState()
			this.updateStatus(InstanceStatus.BadConfig, connection.reason)
			return
		}

		try {
			const snapshot = await this.api.getState()
			this.handleSnapshot(snapshot, true)
		} catch (err) {
			this.log('warn', `Initial GET /v1/state failed (will retry via the socket): ${errMessage(err)}`)
			this.updateStatus(InstanceStatus.Connecting, describeConnectionError(err) ?? 'Waiting for the control socket…')
		}

		this.socket.connect()
	}

	/** `authoritative` (hello, or the priming read) drops the revision guard first: a restarted app counts from the start again. */
	private handleSnapshot(snapshot: ControlAPIState, authoritative = false): void {
		this.state.setSocketConnected(true)
		this.state.markFrame()
		if (!this.state.applyState(snapshot, { hello: authoritative })) return
		this.updateStatus(InstanceStatus.Ok)
		this.refreshDynamicDefinitions()
		this.session.scheduleTick()
		this.pushDerivedState()
	}

	/** A command's own reply is already the new state — apply it now rather than waiting for the socket to echo it, unless the socket got there first with something newer. */
	private applyReply(snapshot: ControlAPIState, catchUp = false): void {
		if (!this.state.applyState(snapshot, { catchUp })) return
		this.refreshDynamicDefinitions()
		this.session.scheduleTick()
		this.pushDerivedState()
	}

	/**
	 * Roles and plan items are producer-defined and change mid-service (renamed, added, removed) — action/feedback dropdown choices, variable ids, and presets all have to be regenerated when those change. Rebuilding them is expensive and a running timer pushes constantly, so it only happens when the signature of what they're built from differs (or `force`, after a config change).
	 */
	private refreshDynamicDefinitions(force = false): void {
		const overtimeRed = this.config?.overtimeRed !== false
		const signature = `${this.state.dynamicSignature()}|${overtimeRed}`
		if (!force && signature === this.definitionSignature) return
		this.definitionSignature = signature
		this.lastVariableValues = {}
		this.setActionDefinitions(getActionDefinitions(this.actionDeps()))
		this.setFeedbackDefinitions(getFeedbackDefinitions(this.state))
		this.setVariableDefinitions(getVariableDefinitions(this.state))
		this.setPresetDefinitions(getPresetDefinitions(this.state, { overtimeRed }))
	}
}

export function errMessage(err: unknown): string {
	if (err instanceof ApiError) {
		return err.detail ? `${err.message} (${err.detail})` : err.message
	}
	return err instanceof Error ? err.message : String(err)
}

runEntrypoint(ThirteenYearsProducerInstance, upgradeScripts)
