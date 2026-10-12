import { InstanceBase, InstanceStatus, runEntrypoint, type SomeCompanionConfigField } from '@companion-module/base'
import { ApiError, ControlApi, ControlSocket } from './api.js'
import { getConfigFields, type ModuleConfig } from './config.js'
import { getActionDefinitions, type ActionDeps } from './actions.js'
import { getFeedbackDefinitions } from './feedbacks.js'
import { getVariableDefinitions, getVariableValues } from './variables.js'
import { getPresetDefinitions } from './presets.js'
import { ModuleState } from './state.js'
import type { ControlAPIState } from './types.js'

class ThirteenYearsProducerInstance extends InstanceBase<ModuleConfig> {
	private config!: ModuleConfig
	private api!: ControlApi
	private socket!: ControlSocket
	private state = new ModuleState()
	private definitionSignature = ''
	private staleTimer: ReturnType<typeof setInterval> | undefined
	private wasStale = false

	async init(config: ModuleConfig, _isFirstInit: boolean): Promise<void> {
		this.config = config
		this.api = new ControlApi(
			() => this.resolvedConfig(),
			(snapshot) => this.applyReply(snapshot),
		)
		this.socket = new ControlSocket(() => this.resolvedConfig(), {
			onOpen: () => {
				this.log('info', 'Connected to Control API socket')
			},
			onHello: (snapshot) => this.handleSnapshot(snapshot, true),
			onState: (snapshot) => this.handleSnapshot(snapshot),
			onTimer: (timer) => {
				if (this.state.applyTimer(timer)) this.pushDerivedState()
			},
			onFrame: () => this.state.markFrame(),
			onMessage: (message) => {
				this.state.applyMessage(message)
				this.pushDerivedState()
			},
			onClose: () => {
				this.state.setSocketConnected(false)
				this.updateStatus(InstanceStatus.Disconnected, 'Control socket closed — reconnecting')
				this.pushDerivedState()
			},
			onError: (err) => {
				this.log('warn', `Control socket error: ${err.message}`)
			},
		})

		this.refreshDynamicDefinitions(true)

		this.staleTimer = setInterval(() => this.checkStale(), 1000)

		this.updateStatus(InstanceStatus.Connecting)
		await this.primeAndConnect()
	}

	async destroy(): Promise<void> {
		if (this.staleTimer) clearInterval(this.staleTimer)
		this.socket?.close()
	}

	async configUpdated(config: ModuleConfig): Promise<void> {
		this.config = config
		this.refreshDynamicDefinitions(true)
		this.socket.close()
		this.updateStatus(InstanceStatus.Connecting)
		await this.primeAndConnect()
	}

	getConfigFields(): SomeCompanionConfigField[] {
		return getConfigFields()
	}

	private resolvedConfig(): { host: string; port: number } {
		return { host: this.config.host, port: this.config.port }
	}

	/** `refresh` is what the Timer Entry keypad actions call: its buffer lives in `ModuleState`, so nothing on the app's side will push the change back for us. */
	private actionDeps(): ActionDeps {
		return {
			api: this.api,
			state: this.state,
			log: (level, message) => this.log(level, message),
			refresh: () => this.pushDerivedState(),
		}
	}

	/** Only the stale/fresh transition needs announcing; a quiet link costs nothing per tick. */
	private checkStale(): void {
		const stale = this.state.isStale
		if (stale === this.wasStale) return
		this.wasStale = stale
		this.pushDerivedState()
	}

	private pushDerivedState(): void {
		this.setVariableValues(getVariableValues(this.state))
		this.checkFeedbacks()
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
		if (!this.config.host) {
			this.updateStatus(InstanceStatus.BadConfig, 'Set the Producer host/IP in the connection settings')
			return
		}

		try {
			const snapshot = await this.api.getState()
			this.handleSnapshot(snapshot, true)
		} catch (err) {
			this.log('warn', `Initial GET /v1/state failed (will retry via the socket): ${errMessage(err)}`)
			this.updateStatus(InstanceStatus.Connecting, 'Waiting for the control socket…')
		}

		this.socket.connect()
	}

	/** `authoritative` (hello, or the priming read) drops the revision guard first: a restarted app counts from the start again. */
	private handleSnapshot(snapshot: ControlAPIState, authoritative = false): void {
		if (authoritative) this.state.resetRev()
		this.state.setSocketConnected(true)
		this.state.markFrame()
		if (!this.state.applyState(snapshot)) return
		this.updateStatus(InstanceStatus.Ok)
		this.refreshDynamicDefinitions()
		this.pushDerivedState()
	}

	/** A command's own reply is already the new state — apply it now rather than waiting for the socket to echo it, unless the socket got there first with something newer. */
	private applyReply(snapshot: ControlAPIState): void {
		if (!this.state.applyState(snapshot)) return
		this.refreshDynamicDefinitions()
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

runEntrypoint(ThirteenYearsProducerInstance, [])
