import { InstanceBase, InstanceStatus, runEntrypoint, type SomeCompanionConfigField } from '@companion-module/base'
import { ApiError, ControlApi, ControlSocket } from './api'
import { getConfigFields, type ModuleConfig } from './config'
import { getActionDefinitions, type ActionDeps } from './actions'
import { getFeedbackDefinitions } from './feedbacks'
import { getVariableDefinitions, getVariableValues } from './variables'
import { getPresetDefinitions } from './presets'
import { ModuleState } from './state'
import type { ControlAPIState } from './types'

class ThirteenYearsProducerInstance extends InstanceBase<ModuleConfig> {
	private config!: ModuleConfig
	private api!: ControlApi
	private socket!: ControlSocket
	private state = new ModuleState()

	async init(config: ModuleConfig, _isFirstInit: boolean): Promise<void> {
		this.config = config
		this.api = new ControlApi(() => this.resolvedConfig())
		this.socket = new ControlSocket(() => this.resolvedConfig(), {
			onOpen: () => {
				this.log('info', 'Connected to Control API socket')
			},
			onHello: (snapshot) => this.handleSnapshot(snapshot),
			onState: (snapshot) => this.handleSnapshot(snapshot),
			onMessage: (message) => {
				this.state.applyMessage(message)
				this.refreshDynamicDefinitions()
				this.pushDerivedState()
			},
			onClose: () => {
				this.state.setSocketConnected(false)
				this.updateStatus(InstanceStatus.Disconnected, 'Control socket closed — reconnecting')
				this.checkFeedbacks('connectionLost')
			},
			onError: (err) => {
				this.log('warn', `Control socket error: ${err.message}`)
			},
		})

		this.setActionDefinitions(getActionDefinitions(this.actionDeps()))
		this.setFeedbackDefinitions(getFeedbackDefinitions(this.state))
		this.setVariableDefinitions(getVariableDefinitions(this.state))
		this.setPresetDefinitions(getPresetDefinitions(this.state))

		this.updateStatus(InstanceStatus.Connecting)
		await this.primeAndConnect()
	}

	async destroy(): Promise<void> {
		this.socket?.close()
	}

	async configUpdated(config: ModuleConfig): Promise<void> {
		this.config = config
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
			this.handleSnapshot(snapshot)
		} catch (err) {
			this.log('warn', `Initial GET /v1/state failed (will retry via the socket): ${errMessage(err)}`)
			this.updateStatus(InstanceStatus.Connecting, 'Waiting for the control socket…')
		}

		this.socket.connect()
	}

	private handleSnapshot(snapshot: ControlAPIState): void {
		this.state.applyState(snapshot)
		this.state.setSocketConnected(true)
		this.updateStatus(InstanceStatus.Ok)
		this.refreshDynamicDefinitions()
		this.pushDerivedState()
	}

	/** Roles and plan items are producer-defined and change mid-service (renamed, added, removed) — action/feedback dropdown choices, variable ids, and presets all have to be regenerated whenever the snapshot changes, not just once at init. */
	private refreshDynamicDefinitions(): void {
		this.setActionDefinitions(getActionDefinitions(this.actionDeps()))
		this.setFeedbackDefinitions(getFeedbackDefinitions(this.state))
		this.setVariableDefinitions(getVariableDefinitions(this.state))
		this.setPresetDefinitions(getPresetDefinitions(this.state))
	}
}

export function errMessage(err: unknown): string {
	if (err instanceof ApiError) {
		return err.detail ? `${err.message} (${err.detail})` : err.message
	}
	return err instanceof Error ? err.message : String(err)
}

runEntrypoint(ThirteenYearsProducerInstance, [])
