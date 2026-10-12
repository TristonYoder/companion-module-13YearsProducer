import WebSocket from 'ws'
import type {
	ActiveTimer,
	CommandReply,
	ControlAPIErrorBody,
	ControlAPIState,
	CueStateValue,
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
	RoleCue,
	RoleUpdateBody,
	SettingsStatus,
	ServerEvent,
	StartTimerBody,
	TimerRemainingBody,
	TimerSnapshot,
	PlanItemWaypointsBody,
	ScheduleCreateBody,
	ScheduleEntry,
	ScheduleStatus,
	ScheduleUpdateBody,
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

/** A command reply that is the whole state rather than just its own section. */
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

/**
 * REST client for the Control API — see CONTROL-API.md. One method per route
 * this module drives. There is no authentication (the API has none), so no
 * header is sent beyond `Content-Type`.
 *
 * Mutating routes mostly return the full `ControlAPIState` snapshot; a few
 * (role/plan-item CRUD, PCO/Plotiphar sub-resources) return just their own
 * section, matching what the router actually sends back — see per-method notes.
 */
export class ControlApi {
	/** `onSnapshot` is handed every full-state reply to a command, so the module can apply it without waiting for the socket's push. */
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
				`${init?.method ?? 'GET'} ${path} failed: ${err instanceof Error ? err.message : String(err)}`,
			)
		}

		if (!res.ok) {
			let body: ControlAPIErrorBody | undefined
			try {
				body = (await res.json()) as ControlAPIErrorBody
			} catch {
				// Non-JSON error body — fall through with just the status.
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

	// MARK: Health & State

	async getHealth(): Promise<HealthInfo> {
		return this.get('/health')
	}

	/** The only place this module ever calls this — on connect, to prime state before the WebSocket's own `hello` arrives. Every other read comes from WebSocket pushes; this module does not poll. */
	async getState(): Promise<ControlAPIState> {
		return this.get('/state')
	}

	/** The timer alone — the slim shape of the socket's `timer` event. */
	async getTimer(): Promise<TimerSnapshot> {
		return this.get('/timer')
	}

	// MARK: Roles & selection

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

	/** 409s if any id is unknown. */
	async setSelection(roleIds: string[]): Promise<ControlAPIState> {
		return this.send('PUT', '/selection', { roleIds })
	}

	// MARK: Cues

	/** 409s ("No roles are selected") if `selectedRoleIds` doesn't currently match any known role — see `PUT /v1/selection` / `setSelection`. */
	async fireSelectedCue(state: CueStateValue): Promise<ControlAPIState> {
		return this.send('POST', '/cues/selected', { state })
	}

	async clearAllCues(): Promise<ControlAPIState> {
		return this.send('POST', '/cues/clear')
	}

	// MARK: Timer

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

	/** Either `{ seconds }` (absolute) or `{ input }` (the app's own GrandMA-style grammar: `"4350"`, `"+30s"`, `"1h30m"`). */
	async timerSetRemaining(body: TimerRemainingBody): Promise<ControlAPIState> {
		return this.send('POST', '/timer/remaining', body)
	}

	async timerActualOverride(isActual: boolean): Promise<ControlAPIState> {
		return this.send('POST', '/timer/actual-override', { isActual })
	}

	// MARK: Plan

	async getPlan(): Promise<PlanStatus> {
		return this.get('/plan')
	}

	/** Without `startTimer` no body is sent, which is the app's own default behaviour. */
	async planNext(startTimer?: boolean): Promise<ControlAPIState> {
		return this.send('POST', '/plan/next', startTimerBody(startTimer))
	}

	async planPrevious(startTimer?: boolean): Promise<ControlAPIState> {
		return this.send('POST', '/plan/previous', startTimerBody(startTimer))
	}

	/** 202 — loads asynchronously from Planning Center; watch for a later `state` push. 409s if no PCO-synced plan is active. */
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

	/** `itemIds` must list every current plan item exactly once. */
	async reorderPlanItems(itemIds: string[]): Promise<PlanStatus> {
		return this.send('POST', '/plan/items/reorder', { itemIds })
	}

	/** `Title | Type | Duration` per line — see ServiceFlowImporter.swift. */
	async importPlan(text: string, title?: string): Promise<PlanStatus> {
		return this.send('POST', '/plan/import', { text, title })
	}

	// MARK: Planning Center Online

	async getPco(): Promise<PCOStatus> {
		return this.get('/pco')
	}

	/** 202 — opens a browser on the device; this call cannot complete the OAuth grant. Watch for `pco.isConnected` to flip. */
	async pcoSignIn(): Promise<ControlAPIState> {
		return this.send('POST', '/pco/sign-in')
	}

	async pcoSignOut(): Promise<PCOStatus> {
		return this.send('POST', '/pco/sign-out')
	}

	async listPcoServiceTypes(): Promise<IdentifiedName[]> {
		return this.get('/pco/service-types')
	}

	/** 202 — watch for `pco.serviceTypes` to update. */
	async refreshPcoServiceTypes(): Promise<ControlAPIState> {
		return this.send('POST', '/pco/service-types/refresh')
	}

	/** 202. A null or empty `id` clears the selection. */
	async selectPcoServiceType(id: string | null): Promise<ControlAPIState> {
		return this.send('POST', '/pco/service-type', { id })
	}

	/** A null `id` clears the remembered default. */
	async setPcoDefaultServiceType(id: string | null): Promise<PCOStatus> {
		return this.send('POST', '/pco/default-service-type', { id })
	}

	async listPcoPlans(): Promise<PCOPlanInfo[]> {
		return this.get('/pco/plans')
	}

	/** 202. 409s if no service type is selected. */
	async refreshPcoPlans(): Promise<ControlAPIState> {
		return this.send('POST', '/pco/plans/refresh')
	}

	/** 202. */
	async setPcoPlanFilter(filter: string): Promise<ControlAPIState> {
		return this.send('POST', '/pco/plan-filter', { filter })
	}

	/** 202 — fetches the plan and replaces the local plan in the background; watch for `plan` to update. */
	async syncPco(serviceTypeId: string, planId: string): Promise<ControlAPIState> {
		return this.send('POST', '/pco/sync', { serviceTypeId, planId })
	}

	/** 202. */
	async setPcoLiveSync(enabled: boolean): Promise<ControlAPIState> {
		return this.send('POST', '/pco/live-sync', { enabled })
	}

	// MARK: Plotiphar

	async getPlotiphar(): Promise<PlotipharStatus> {
		return this.get('/plotiphar')
	}

	/** 202 — a pairing code appears in `plotiphar.pairingCode` shortly after. */
	async startPlotipharPairing(): Promise<PlotipharStatus> {
		return this.send('POST', '/plotiphar/pair/start')
	}

	async cancelPlotipharPairing(): Promise<PlotipharStatus> {
		return this.send('POST', '/plotiphar/pair/cancel')
	}

	/** 202. */
	async syncPlotipharAssignments(): Promise<PlotipharStatus> {
		return this.send('POST', '/plotiphar/assignments/sync')
	}

	async disconnectPlotiphar(): Promise<PlotipharStatus> {
		return this.send('POST', '/plotiphar/disconnect')
	}

	// MARK: Network

	/** 202, fire-and-forget UDP — no acknowledgement. 503s if this device can't determine its own LAN address. */
	async networkPing(ip: string): Promise<ControlAPIState> {
		return this.send('POST', '/network/ping', { ip })
	}

	async forgetProducer(): Promise<ControlAPIState> {
		return this.send('POST', '/network/forget-producer')
	}

	async setMasterMode(isMaster: boolean): Promise<ControlAPIState> {
		return this.send('POST', '/network/master', { isMaster })
	}

	// MARK: App navigation

	async getUiMode(): Promise<{ mode: string }> {
		return this.get('/ui/mode')
	}

	/** Accepts wire form (`PRODUCER_CONTROL`) or camelCase (`producerControl`). */
	async setUiMode(mode: string): Promise<{ mode: string }> {
		return this.send('PUT', '/ui/mode', { mode })
	}

	// MARK: Settings

	async getSettings(): Promise<SettingsStatus> {
		return this.get('/settings')
	}

	async updateSettings(hourFormatThreshold?: string): Promise<SettingsStatus> {
		return this.send('PATCH', '/settings', { hourFormatThreshold })
	}

	// MARK: Messages

	async listMessages(): Promise<InterTeamMessage[]> {
		return this.get('/messages')
	}

	async sendMessage(body: MessageBody): Promise<InterTeamMessage[]> {
		return this.send('POST', '/messages', body)
	}

	async clearMessages(): Promise<InterTeamMessage[]> {
		return this.send('DELETE', '/messages')
	}

	// MARK: Relay

	async setRelay(body: { enabled?: boolean; host?: string }): Promise<ControlAPIState> {
		return this.send('PUT', '/relay', body)
	}

	// MARK: Notifications

	/**
	 * Takes the standing lower third down on every pager without touching a
	 * word of the history — the counterpart to `clearMessages()`, which wipes
	 * the history itself. This is what a producer reaches for once the host has
	 * visibly read the message.
	 */
	async dismissNotification(): Promise<ControlAPIState> {
		return this.send('POST', '/messages/dismiss')
	}

	// MARK: Waypoints
	//
	// Every `ref` below is a waypoint id *or* its slug — the router resolves
	// either, which is what lets a preset button be authored against a stable
	// human name ("sermon") rather than a UUID that changes per install.

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

	/**
	 * Jumps the service to whatever item carries this waypoint.
	 *
	 * Throws `ApiError` 404 when no such waypoint exists and 409 when it exists
	 * but nothing in the loaded plan carries it — a split the app makes on
	 * purpose, so callers should surface the two differently rather than
	 * collapsing them into "didn't work".
	 */
	async fireWaypoint(ref: string, startTimer?: boolean): Promise<ControlAPIState> {
		const body: WaypointFireBody | undefined = startTimer === undefined ? undefined : { startTimer }
		return this.send('POST', `/waypoints/${encodeURIComponent(ref)}/go`, body)
	}

	/** Jumps to the next waypoint ahead of the live item. 409s when there is none. */
	async waypointNext(startTimer?: boolean): Promise<ControlAPIState> {
		return this.send('POST', '/waypoints/next', startTimerBody(startTimer))
	}

	/** Points a waypoint at a plan item, or unassigns it when `itemId` is null. */
	async assignWaypoint(ref: string, itemId: string | null): Promise<WaypointStatus> {
		return this.send('POST', `/waypoints/${encodeURIComponent(ref)}/assign`, { itemId } satisfies WaypointAssignBody)
	}

	/** Replaces the complete set of waypoints a plan item carries. */
	async setPlanItemWaypoints(itemId: string, waypoints: string[]): Promise<PlanStatus> {
		return this.send('POST', `/plan/items/${encodeURIComponent(itemId)}/waypoints`, {
			waypoints,
		} satisfies PlanItemWaypointsBody)
	}

	// MARK: Service schedules

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

	/** Brings a scheduled service up right now, without waiting for its go-live time. */
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
	/** Any inbound traffic at all, pongs included — proof the link is alive. */
	onFrame?: () => void
	onOpen?: () => void
	onClose?: (reason: string) => void
	onError?: (err: Error) => void
}

const RECONNECT_DELAY_MS = 3000
const PING_INTERVAL_MS = 5000
/** No frame or pong for this long and the socket is treated as half-open (e.g. the Mac slept) and torn down. */
const PONG_DEADLINE_MS = 12000

/**
 * The WebSocket half of the Control API — `ws://host:port/v1/socket`. This is
 * the module's *only* source of live state: it holds the socket open for the
 * life of the connection and drives every feedback/variable off the `hello`/
 * `state`/`message` pushes it receives. The module never polls `GET /v1/state`
 * on a timer; REST is used only for one-shot commands (`ControlApi` above).
 *
 * Reconnects automatically on close/error with a fixed backoff — a producer's
 * Mac sleeping or an iPad backgrounding (the API doesn't run while backgrounded
 * on iPad) are the expected ways this drops, not exceptional ones.
 */
export class ControlSocket {
	private ws: WebSocket | undefined
	private reconnectTimer: ReturnType<typeof setTimeout> | undefined
	private closedByUser = false
	private pending = new Map<string, { resolve: (reply: CommandReply) => void; reject: (err: Error) => void }>()
	private nextCommandId = 1
	private keepaliveTimer: ReturnType<typeof setInterval> | undefined
	private lastInboundAt = 0

	constructor(
		private getConfig: () => ResolvedApiConfig,
		private handlers: ControlSocketHandlers,
	) {}

	get isOpen(): boolean {
		return this.ws?.readyState === WebSocket.OPEN
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
		for (const { reject } of this.pending.values()) reject(new Error('Socket closed'))
		this.pending.clear()
	}

	/** Send a command over the socket instead of REST (`op` is the dotted route form, e.g. `plan.next`). Not used by this module's own actions today — REST is simpler to reason about and to test — but kept public since the protocol supports it symmetrically. */
	async sendCommand(op: string, body?: unknown): Promise<CommandReply> {
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
			return Promise.reject(new Error('Socket is not connected'))
		}
		const id = String(this.nextCommandId++)
		const envelope = { id, op, body }
		return new Promise<CommandReply>((resolve, reject) => {
			this.pending.set(id, { resolve, reject })
			this.ws?.send(JSON.stringify(envelope))
		})
	}

	private openSocket(): void {
		const { host, port } = this.getConfig()
		const url = `ws://${host}:${port}/v1/socket`
		const ws = new WebSocket(url)
		this.ws = ws

		ws.on('open', () => {
			this.startKeepalive(ws)
			this.handlers.onOpen?.()
		})

		ws.on('message', (data: WebSocket.RawData) => {
			this.noteInbound()
			this.handleMessage(rawDataToString(data))
		})

		ws.on('pong', () => {
			this.noteInbound()
		})

		ws.on('close', () => {
			if (this.ws !== ws) return
			this.stopKeepalive()
			this.handlers.onClose?.('closed')
			this.scheduleReconnect()
		})

		ws.on('error', (err: Error) => {
			this.handlers.onError?.(err)
		})
	}

	private noteInbound(): void {
		this.lastInboundAt = Date.now()
		this.handlers.onFrame?.()
	}

	private startKeepalive(ws: WebSocket): void {
		this.stopKeepalive()
		this.lastInboundAt = Date.now()
		this.keepaliveTimer = setInterval(() => {
			if (Date.now() - this.lastInboundAt > PONG_DEADLINE_MS) {
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

/** `WebSocket.RawData` is `Buffer | ArrayBuffer | Buffer[]` — never a JSON-serializable text frame by itself, so this normalizes all three to a UTF-8 string before `JSON.parse`. */
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
