import WebSocket from 'ws'
import { describeConnectionError } from './connection.js'
import type {
	ActiveTimer,
	ActualsStatus,
	CommandReply,
	ControlAPIErrorBody,
	ControlAPIState,
	CueStateValue,
	DigestData,
	HealthInfo,
	IdentifiedName,
	InterTeamMessage,
	MessageBody,
	PCOPlanInfo,
	PCOStatus,
	PCOTimerItem,
	PlanItemCreateBody,
	PlanItemUpdateBody,
	PlanStatus,
	PlotipharStatus,
	RehearsalBody,
	RehearsalStatus,
	RoleCue,
	RoleUpdateBody,
	SaveActualsReply,
	SettingsStatus,
	SettingsUpdateBody,
	ServerEvent,
	SkipBody,
	SkipsStatus,
	StartTimerBody,
	SyncReplyData,
	TimerRemainingBody,
	TimerSnapshot,
	EventTimeLiveBody,
	EventTimesStatus,
	PlanItemWaypointsBody,
	ScheduleCreateBody,
	ScheduleEntry,
	ScheduleStatus,
	ScheduleUpdateBody,
	TimerEndAtBody,
	WaypointAssignBody,
	WaypointCreateBody,
	WaypointFireBody,
	WaypointStatus,
	WaypointUpdateBody,
} from './types.js'

export interface ResolvedApiConfig {
	host: string
	port: number
}

const REQUEST_TIMEOUT_MS = 3000

function isFullSnapshot(value: unknown): value is ControlAPIState {
	return (
		typeof value === 'object' && value !== null && 'roles' in value && 'plan' in value && 'selectedRoleIds' in value
	)
}

export class ApiError extends Error {
	constructor(
		public status: number,
		message: string,
		public detail?: string,
	) {
		super(message)
	}
}

export class ControlApi {
	constructor(
		private getConfig: () => ResolvedApiConfig,
		private onSnapshot?: (snapshot: ControlAPIState) => void,
	) {}

	private get baseUrl(): string {
		const { host, port } = this.getConfig()
		return `http://${host}:${port}/v1`
	}

	private async request<T>(path: string, init?: RequestInit): Promise<T> {
		const url = this.baseUrl + path
		let res: Response
		try {
			res = await fetch(url, {
				...init,
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
				headers: {
					'Content-Type': 'application/json',
					...init?.headers,
				},
			})
		} catch (err) {
			throw new ApiError(
				0,
				`${init?.method ?? 'GET'} ${path} failed: ${describeConnectionError(err) ?? (err instanceof Error ? err.message : String(err))}`,
			)
		}

		if (!res.ok) {
			let body: ControlAPIErrorBody | undefined
			try {
				body = (await res.json()) as ControlAPIErrorBody
			} catch {
				body = undefined
			}
			throw new ApiError(
				res.status,
				body?.error ?? `${init?.method ?? 'GET'} ${path} failed: ${res.status}`,
				body?.detail,
			)
		}

		if (res.status === 204) return undefined as T
		const text = await res.text()
		return text ? (JSON.parse(text) as T) : (undefined as T)
	}

	private async get<T>(path: string): Promise<T> {
		return this.request<T>(path, { method: 'GET' })
	}

	private async send<T>(method: string, path: string, body?: unknown): Promise<T> {
		const result = await this.request<T>(path, { method, body: body === undefined ? undefined : JSON.stringify(body) })
		if (isFullSnapshot(result)) this.onSnapshot?.(result)
		return result
	}

	async getHealth(): Promise<HealthInfo> {
		return this.get('/health')
	}

	async getState(): Promise<ControlAPIState> {
		return this.get('/state')
	}

	async getTimer(): Promise<TimerSnapshot> {
		return this.get('/timer')
	}

	async sync(t0: number): Promise<SyncReplyData> {
		return this.request('/sync', { method: 'POST', body: JSON.stringify({ t0 }) })
	}

	async listRoles(): Promise<RoleCue[]> {
		return this.get('/roles')
	}

	async createRole(name: string): Promise<RoleCue> {
		return this.send('POST', '/roles', { name })
	}

	async getRole(id: string): Promise<RoleCue> {
		return this.get(`/roles/${encodeURIComponent(id)}`)
	}

	async updateRole(id: string, patch: RoleUpdateBody): Promise<RoleCue> {
		return this.send('PATCH', `/roles/${encodeURIComponent(id)}`, patch)
	}

	async deleteRole(id: string): Promise<RoleCue[]> {
		return this.send('DELETE', `/roles/${encodeURIComponent(id)}`)
	}

	async fireRoleCue(id: string, state: CueStateValue): Promise<ControlAPIState> {
		return this.send('POST', `/roles/${encodeURIComponent(id)}/cue`, { state })
	}

	async getSelection(): Promise<string[]> {
		return this.get('/selection')
	}

	async setSelection(roleIds: string[]): Promise<ControlAPIState> {
		return this.send('PUT', '/selection', { roleIds })
	}

	async fireSelectedCue(state: CueStateValue): Promise<ControlAPIState> {
		return this.send('POST', '/cues/selected', { state })
	}

	async clearAllCues(): Promise<ControlAPIState> {
		return this.send('POST', '/cues/clear')
	}

	async timerStart(): Promise<ControlAPIState> {
		return this.send('POST', '/timer/start')
	}

	async timerPause(): Promise<ControlAPIState> {
		return this.send('POST', '/timer/pause')
	}

	async timerToggle(): Promise<ControlAPIState> {
		return this.send('POST', '/timer/toggle')
	}

	async timerReset(): Promise<ControlAPIState> {
		return this.send('POST', '/timer/reset')
	}

	async timerAdjust(seconds: number): Promise<ControlAPIState> {
		return this.send('POST', '/timer/adjust', { seconds })
	}

	async timerSetRemaining(body: TimerRemainingBody): Promise<ControlAPIState> {
		return this.send('POST', '/timer/remaining', body)
	}

	async timerActualOverride(isActual: boolean): Promise<ControlAPIState> {
		return this.send('POST', '/timer/actual-override', { isActual })
	}

	async getPlan(): Promise<PlanStatus> {
		return this.get('/plan')
	}

	async planNext(startTimer?: boolean): Promise<ControlAPIState> {
		return this.send('POST', '/plan/next', startTimerBody(startTimer))
	}

	async planPrevious(startTimer?: boolean): Promise<ControlAPIState> {
		return this.send('POST', '/plan/previous', startTimerBody(startTimer))
	}

	async planNextService(): Promise<ControlAPIState> {
		return this.send('POST', '/plan/next-service')
	}

	async getActiveItem(): Promise<ActiveTimer> {
		return this.get('/plan/active')
	}

	async setActiveItem(itemId: string): Promise<ControlAPIState> {
		return this.send('POST', '/plan/active', { itemId })
	}

	async addPlanItem(body: PlanItemCreateBody): Promise<PlanStatus> {
		return this.send('POST', '/plan/items', body)
	}

	async getPlanItem(id: string): Promise<PCOTimerItem> {
		return this.get(`/plan/items/${encodeURIComponent(id)}`)
	}

	async updatePlanItem(id: string, body: PlanItemUpdateBody): Promise<PCOTimerItem> {
		return this.send('POST', `/plan/items/${encodeURIComponent(id)}`, body)
	}

	async deletePlanItem(id: string): Promise<PlanStatus> {
		return this.send('DELETE', `/plan/items/${encodeURIComponent(id)}`)
	}

	async setPlanItemDurationActual(id: string, isActual: boolean): Promise<PlanStatus> {
		return this.send('POST', `/plan/items/${encodeURIComponent(id)}/duration-actual`, { isActual })
	}

	async reorderPlanItems(itemIds: string[]): Promise<PlanStatus> {
		return this.send('POST', '/plan/items/reorder', { itemIds })
	}

	async importPlan(text: string, title?: string): Promise<PlanStatus> {
		return this.send('POST', '/plan/import', { text, title })
	}

	async getPco(): Promise<PCOStatus> {
		return this.get('/pco')
	}

	async pcoSignIn(): Promise<ControlAPIState> {
		return this.send('POST', '/pco/sign-in')
	}

	async pcoSignOut(): Promise<PCOStatus> {
		return this.send('POST', '/pco/sign-out')
	}

	async listPcoServiceTypes(): Promise<IdentifiedName[]> {
		return this.get('/pco/service-types')
	}

	async refreshPcoServiceTypes(): Promise<ControlAPIState> {
		return this.send('POST', '/pco/service-types/refresh')
	}

	async selectPcoServiceType(id: string | null): Promise<ControlAPIState> {
		return this.send('POST', '/pco/service-type', { id })
	}

	async setPcoDefaultServiceType(id: string | null): Promise<PCOStatus> {
		return this.send('POST', '/pco/default-service-type', { id })
	}

	async listPcoPlans(): Promise<PCOPlanInfo[]> {
		return this.get('/pco/plans')
	}

	async refreshPcoPlans(): Promise<ControlAPIState> {
		return this.send('POST', '/pco/plans/refresh')
	}

	async setPcoPlanFilter(filter: string): Promise<ControlAPIState> {
		return this.send('POST', '/pco/plan-filter', { filter })
	}

	async syncPco(serviceTypeId: string, planId: string): Promise<ControlAPIState> {
		return this.send('POST', '/pco/sync', { serviceTypeId, planId })
	}

	async setPcoLiveSync(enabled: boolean): Promise<ControlAPIState> {
		return this.send('POST', '/pco/live-sync', { enabled })
	}

	async getPlotiphar(): Promise<PlotipharStatus> {
		return this.get('/plotiphar')
	}

	async startPlotipharPairing(): Promise<PlotipharStatus> {
		return this.send('POST', '/plotiphar/pair/start')
	}

	async cancelPlotipharPairing(): Promise<PlotipharStatus> {
		return this.send('POST', '/plotiphar/pair/cancel')
	}

	async syncPlotipharAssignments(): Promise<PlotipharStatus> {
		return this.send('POST', '/plotiphar/assignments/sync')
	}

	async disconnectPlotiphar(): Promise<PlotipharStatus> {
		return this.send('POST', '/plotiphar/disconnect')
	}

	async networkPing(ip: string): Promise<ControlAPIState> {
		return this.send('POST', '/network/ping', { ip })
	}

	async forgetProducer(): Promise<ControlAPIState> {
		return this.send('POST', '/network/forget-producer')
	}

	async setMasterMode(isMaster: boolean): Promise<ControlAPIState> {
		return this.send('POST', '/network/master', { isMaster })
	}

	async getUiMode(): Promise<{ mode: string }> {
		return this.get('/ui/mode')
	}

	async setUiMode(mode: string): Promise<{ mode: string }> {
		return this.send('PUT', '/ui/mode', { mode })
	}

	async getSettings(): Promise<SettingsStatus> {
		return this.get('/settings')
	}

	async updateSettings(body: SettingsUpdateBody): Promise<SettingsStatus> {
		return this.send('PATCH', '/settings', body)
	}

	async listMessages(): Promise<InterTeamMessage[]> {
		return this.get('/messages')
	}

	async sendMessage(body: MessageBody): Promise<InterTeamMessage[]> {
		return this.send('POST', '/messages', body)
	}

	async clearMessages(): Promise<InterTeamMessage[]> {
		return this.send('DELETE', '/messages')
	}

	async setRelay(body: { enabled?: boolean; host?: string }): Promise<ControlAPIState> {
		return this.send('PUT', '/relay', body)
	}

	async dismissNotification(): Promise<ControlAPIState> {
		return this.send('POST', '/messages/dismiss')
	}

	async listWaypoints(): Promise<WaypointStatus[]> {
		return this.get('/waypoints')
	}

	async createWaypoint(name: string): Promise<WaypointStatus> {
		return this.send('POST', '/waypoints', { name } satisfies WaypointCreateBody)
	}

	async getWaypoint(ref: string): Promise<WaypointStatus> {
		return this.get(`/waypoints/${encodeURIComponent(ref)}`)
	}

	async updateWaypoint(ref: string, body: WaypointUpdateBody): Promise<WaypointStatus> {
		return this.send('PATCH', `/waypoints/${encodeURIComponent(ref)}`, body)
	}

	async deleteWaypoint(ref: string): Promise<WaypointStatus[]> {
		return this.send('DELETE', `/waypoints/${encodeURIComponent(ref)}`)
	}

	async fireWaypoint(ref: string, startTimer?: boolean): Promise<ControlAPIState> {
		const body: WaypointFireBody | undefined = startTimer === undefined ? undefined : { startTimer }
		return this.send('POST', `/waypoints/${encodeURIComponent(ref)}/go`, body)
	}

	async waypointNext(startTimer?: boolean): Promise<ControlAPIState> {
		return this.send('POST', '/waypoints/next', startTimerBody(startTimer))
	}

	async assignWaypoint(ref: string, itemId: string | null): Promise<WaypointStatus> {
		return this.send('POST', `/waypoints/${encodeURIComponent(ref)}/assign`, { itemId } satisfies WaypointAssignBody)
	}

	async setPlanItemWaypoints(itemId: string, waypoints: string[]): Promise<PlanStatus> {
		return this.send('POST', `/plan/items/${encodeURIComponent(itemId)}/waypoints`, {
			waypoints,
		} satisfies PlanItemWaypointsBody)
	}

	async listSchedules(): Promise<ScheduleStatus> {
		return this.get('/schedules')
	}

	async createSchedule(body: ScheduleCreateBody): Promise<ScheduleStatus> {
		return this.send('POST', '/schedules', body)
	}

	async getSchedule(id: string): Promise<ScheduleEntry> {
		return this.get(`/schedules/${encodeURIComponent(id)}`)
	}

	async updateSchedule(id: string, body: ScheduleUpdateBody): Promise<ScheduleEntry> {
		return this.send('PATCH', `/schedules/${encodeURIComponent(id)}`, body)
	}

	async deleteSchedule(id: string): Promise<ScheduleStatus> {
		return this.send('DELETE', `/schedules/${encodeURIComponent(id)}`)
	}

	async setLiveEventTime(id: string): Promise<EventTimesStatus> {
		return this.send('POST', '/event-times/live', { id } satisfies EventTimeLiveBody)
	}

	async nextEventTime(): Promise<ControlAPIState> {
		return this.send('POST', '/event-times/next')
	}

	async timerEndAt(time: string): Promise<ControlAPIState> {
		return this.send('POST', '/timer/end-at', { time } satisfies TimerEndAtBody)
	}

	async getActuals(): Promise<ActualsStatus> {
		return this.get('/plan/actuals')
	}

	async saveActualsToPco(): Promise<SaveActualsReply> {
		return this.send('POST', '/plan/actuals/save-to-pco')
	}

	async getSkips(): Promise<SkipsStatus> {
		return this.get('/plan/skips')
	}

	async setItemSkipped(itemId: string, skipped: boolean): Promise<SkipsStatus> {
		return this.send('POST', `/plan/items/${encodeURIComponent(itemId)}/skip`, { skipped } satisfies SkipBody)
	}

	async getRehearsal(): Promise<RehearsalStatus> {
		return this.get('/rehearsal')
	}

	async setRehearsal(enabled: boolean, planTimeId?: string): Promise<RehearsalStatus> {
		const body: RehearsalBody = planTimeId ? { enabled, planTimeId } : { enabled }
		return this.send('PUT', '/rehearsal', body)
	}

	async scheduleGoLive(id: string): Promise<ControlAPIState> {
		return this.send('POST', `/schedules/${encodeURIComponent(id)}/go-live`)
	}
}

function startTimerBody(startTimer: boolean | undefined): StartTimerBody | undefined {
	return startTimer === undefined ? undefined : { startTimer }
}

export interface ControlSocketHandlers {
	onHello?: (state: ControlAPIState) => void
	onState?: (state: ControlAPIState) => void
	onMessage?: (message: InterTeamMessage) => void
	onTimer?: (timer: TimerSnapshot) => void
	onDigest?: (digest: DigestData) => void
	onFrame?: () => void
	onOpen?: () => void
	onClose?: (reason: string) => void
	onError?: (err: Error) => void
}

const RECONNECT_DELAY_MS = 3000
export const HANDSHAKE_TIMEOUT_MS = 5000
export const SOCKET_COMMAND_TIMEOUT_MS = 5000
const PING_INTERVAL_MS = 5000
const PONG_DEADLINE_MS = 12000
const PONG_DEADLINE_MS_V2 = 20000

export class ControlSocket {
	private ws: WebSocket | undefined
	private reconnectTimer: ReturnType<typeof setTimeout> | undefined
	private closedByUser = false
	private pending = new Map<string, { resolve: (reply: CommandReply) => void; reject: (err: Error) => void }>()
	private nextCommandId = 1
	private keepaliveTimer: ReturnType<typeof setInterval> | undefined
	private lastInboundAt = 0
	private pongDeadlineMs = PONG_DEADLINE_MS

	constructor(
		private getConfig: () => ResolvedApiConfig,
		private handlers: ControlSocketHandlers,
		private options: { handshakeTimeoutMs?: number; commandTimeoutMs?: number } = {},
	) {}

	get pendingCount(): number {
		return this.pending.size
	}

	get isOpen(): boolean {
		return this.ws?.readyState === WebSocket.OPEN
	}

	setProtocolV2(enabled: boolean): void {
		this.pongDeadlineMs = enabled ? PONG_DEADLINE_MS_V2 : PONG_DEADLINE_MS
	}

	connect(): void {
		this.closedByUser = false
		this.openSocket()
	}

	close(): void {
		this.closedByUser = true
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer)
			this.reconnectTimer = undefined
		}
		this.stopKeepalive()
		this.ws?.close()
		this.ws = undefined
		this.rejectPending('Socket closed')
	}

	async sendCommand(op: string, body?: unknown): Promise<CommandReply> {
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
			return Promise.reject(new Error('Socket is not connected'))
		}
		const id = String(this.nextCommandId++)
		const envelope = { id, op, body }
		const timeoutMs = this.options.commandTimeoutMs ?? SOCKET_COMMAND_TIMEOUT_MS
		return new Promise<CommandReply>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id)
				reject(new Error(`${op} timed out`))
			}, timeoutMs)
			this.pending.set(id, {
				resolve: (reply) => {
					clearTimeout(timer)
					resolve(reply)
				},
				reject: (err) => {
					clearTimeout(timer)
					reject(err)
				},
			})
			this.ws?.send(JSON.stringify(envelope), (err) => {
				if (!err) return
				clearTimeout(timer)
				this.pending.delete(id)
				reject(err)
			})
		})
	}

	private rejectPending(reason: string): void {
		const waiting = [...this.pending.values()]
		this.pending.clear()
		for (const { reject } of waiting) reject(new Error(reason))
	}

	private openSocket(): void {
		const { host, port } = this.getConfig()
		const url = `ws://${host}:${port}/v1/socket`
		const ws = new WebSocket(url, { handshakeTimeout: this.options.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS })
		this.ws = ws
		let failure: string | null = null

		ws.on('open', () => {
			this.pongDeadlineMs = PONG_DEADLINE_MS
			this.startKeepalive(ws)
			this.handlers.onOpen?.()
		})

		ws.on('message', (data: WebSocket.RawData) => {
			this.noteInbound(true)
			this.handleMessage(rawDataToString(data))
		})

		ws.on('pong', () => {
			this.noteInbound(false)
		})

		ws.on('close', () => {
			if (this.ws !== ws) return
			this.stopKeepalive()
			this.rejectPending('Socket closed')
			this.handlers.onClose?.(failure ?? 'closed')
			this.scheduleReconnect()
		})

		ws.on('error', (err: Error) => {
			failure = describeConnectionError(err) ?? failure
			this.handlers.onError?.(err)
		})
	}

	private noteInbound(dataFrame: boolean): void {
		this.lastInboundAt = Date.now()
		if (dataFrame) this.handlers.onFrame?.()
	}

	private startKeepalive(ws: WebSocket): void {
		this.stopKeepalive()
		this.lastInboundAt = Date.now()
		this.keepaliveTimer = setInterval(() => {
			if (Date.now() - this.lastInboundAt > this.pongDeadlineMs) {
				this.handlers.onError?.(new Error('No reply to keepalive — reconnecting'))
				ws.terminate()
				return
			}
			try {
				ws.ping()
			} catch {
				ws.terminate()
			}
		}, PING_INTERVAL_MS)
	}

	private stopKeepalive(): void {
		if (this.keepaliveTimer) clearInterval(this.keepaliveTimer)
		this.keepaliveTimer = undefined
	}

	private handleMessage(raw: string): void {
		let parsed: unknown
		try {
			parsed = JSON.parse(raw)
		} catch {
			this.handlers.onError?.(new Error(`Received malformed JSON over the control socket: ${raw.slice(0, 200)}`))
			return
		}

		if (isCommandReply(parsed)) {
			const waiter = parsed.id ? this.pending.get(parsed.id) : undefined
			if (waiter && parsed.id) {
				this.pending.delete(parsed.id)
				waiter.resolve(parsed)
			}
			return
		}

		if (isServerEvent(parsed)) {
			switch (parsed.event) {
				case 'hello':
					this.handlers.onHello?.(parsed.data)
					return
				case 'state':
					this.handlers.onState?.(parsed.data)
					return
				case 'message':
					this.handlers.onMessage?.(parsed.data)
					return
				case 'timer':
					this.handlers.onTimer?.(parsed.data)
					return
				case 'digest':
					this.handlers.onDigest?.(parsed.data)
					return
			}
		}
	}

	private scheduleReconnect(): void {
		if (this.closedByUser || this.reconnectTimer) return
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = undefined
			if (!this.closedByUser) this.openSocket()
		}, RECONNECT_DELAY_MS)
	}
}

function rawDataToString(data: WebSocket.RawData): string {
	if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
	if (Buffer.isBuffer(data)) return data.toString('utf8')
	return Buffer.from(data).toString('utf8')
}

function isServerEvent(value: unknown): value is ServerEvent {
	return typeof value === 'object' && value !== null && 'event' in value && value.event !== undefined && 'data' in value
}

function isCommandReply(value: unknown): value is CommandReply {
	return typeof value === 'object' && value !== null && 'status' in value && typeof value.status === 'number'
}
