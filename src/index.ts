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

	private checkStale(): void {
		this.session.checkWake(Date.now())
		const stale = this.state.isStale
		const actionError = this.state.currentActionError
		if (stale === this.wasStale && actionError === this.lastActionError) return
		this.wasStale = stale
		this.lastActionError = actionError
		this.pushDerivedState()
	}

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

	private pushTimerState(): void {
		const changed = this.pushVariables()
		if (changed.some((key) => TIMER_FEEDBACK_VARIABLES.has(key))) {
			this.checkFeedbacks('timerOvertime', 'timerUnderThreshold', 'activeItemProgressBar')
		}
	}

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

	private handleSnapshot(snapshot: ControlAPIState, authoritative = false): void {
		this.state.setSocketConnected(true)
		this.state.markFrame()
		if (!this.state.applyState(snapshot, { hello: authoritative })) return
		this.updateStatus(InstanceStatus.Ok)
		this.refreshDynamicDefinitions()
		this.session.scheduleTick()
		this.pushDerivedState()
	}

	private applyReply(snapshot: ControlAPIState, catchUp = false): void {
		if (!this.state.applyState(snapshot, { catchUp })) return
		this.refreshDynamicDefinitions()
		this.session.scheduleTick()
		this.pushDerivedState()
	}

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
