// The JSON vocabulary of 13 Years Producer's Control API — see
// /Users/tyoder/Projects/13years/CONTROL-API.md and, where the two disagree,
// ControlAPIRouter.swift/ControlAPIModels.swift in that repo (the code wins).
//
// Two spots where the docs and the app's actual Codable models diverge, both
// resolved here in the code's favor:
//   - RoleCue has no nested `cue` object — `state` sits directly on the role,
//     alongside `lastUpdated`, which the docs' example omits entirely.
//   - PCOTimerItem's wire encoding is its literal stored fields (`sequence`,
//     `elapsedSeconds`) — `remainingSeconds`/`isOvertime`/`isHeader` are
//     computed Swift properties, never serialized. Only `timer.*` (the
//     ActiveTimer wrapper) carries a precomputed `remainingSeconds`/
//     `isOvertime`/`formattedRemaining` for the one item that's actually running.

// Resolved divergences (both now corrected in CONTROL-API.md itself):
//   - `PATCH /v1/settings` was documented as taking `under1Hour`/`over1Hour`.
//     The enum has only `over60Minutes`, `over90Minutes`, `never`.
//   - The cue routes were once documented as accepting `RESET`; `CueState` has
//     never had it, and `FLASH_STANDBY`/`FLASH_GO` have since been removed from
//     the enum outright.

// MARK: - Cue state

/**
 * `CueState` raw values (Sources/Shared/Models/CueState.swift) — always
 * uppercase on the wire.
 *
 * `FLASH_STANDBY`/`FLASH_GO` used to be here and are deliberately gone: the
 * app removed both cases outright, so the router's `CueState(rawValue:)` now
 * returns nil for them and every route that takes a cue state answers
 * 400 "Unknown cue state". Offering them in a dropdown was offering two
 * buttons that could only ever fail. The web pager still *reads* them
 * defensively (pager.html maps each to its base state) so historical data
 * renders, but nothing accepts them as input any more.
 */
export type CueStateValue = 'OFF' | 'STANDBY' | 'GO'

export const CUE_STATES: CueStateValue[] = ['OFF', 'STANDBY', 'GO']

/** Every state a cue-firing route (`roles.{id}.cue`, `cues.selected`) accepts. `cues.clear` is the bulk equivalent of firing `OFF` at everything. */
export const FIRABLE_CUE_STATES: CueStateValue[] = ['OFF', 'STANDBY', 'GO']

export const CUE_STATE_LABELS: Record<CueStateValue, string> = {
	OFF: 'Clear',
	STANDBY: 'Standby',
	GO: 'Go!',
}

/** RGB triples lifted verbatim from CueState.swift's `color`/`textColor` so a Companion button matches the app's own screen. */
export const CUE_STATE_COLOR: Record<CueStateValue, [number, number, number]> = {
	OFF: [20, 26, 38],
	STANDBY: [245, 184, 38],
	GO: [38, 199, 89],
}

export const CUE_STATE_TEXT_COLOR: Record<CueStateValue, [number, number, number]> = {
	OFF: [255, 255, 255],
	STANDBY: [26, 26, 26],
	GO: [255, 255, 255],
}

/** The three-step toggle a single template button cycles through on repeated presses: Standby → Go! → Clear → Standby → … */
export const CUE_CYCLE_NEXT: Record<CueStateValue, CueStateValue> = {
	OFF: 'STANDBY',
	STANDBY: 'GO',
	GO: 'OFF',
}

/** What a toggle button should fire next, given a role's current cue state — the same lookup `CUE_CYCLE_NEXT` is, exposed as a function so callers don't have to know it's a plain object. */
export function nextCueStateInCycle(current: CueStateValue): CueStateValue {
	return CUE_CYCLE_NEXT[current]
}

// MARK: - App navigation

/** `AppMode` raw values (Sources/Shared/Models/AppMode.swift). */
export type AppModeValue = 'PRODUCER_CONTROL' | 'SERVICE_FLOW' | 'LIVE_PREVIEW' | 'MESSAGES' | 'SETTINGS'

export const APP_MODES: { id: AppModeValue; label: string }[] = [
	{ id: 'PRODUCER_CONTROL', label: 'Producer Control' },
	{ id: 'SERVICE_FLOW', label: 'Service Flow' },
	{ id: 'LIVE_PREVIEW', label: 'Live Preview' },
	{ id: 'MESSAGES', label: 'Messages' },
	{ id: 'SETTINGS', label: 'Settings' },
]

// MARK: - Domain models (used verbatim on the wire — RoleCue, PCOTimerItem, InterTeamMessage)

export interface RoleCue {
	id: string
	name: string
	personName: string | null
	state: CueStateValue
	plotipharRoleId: string | null
	/** ISO-8601. */
	lastUpdated: string
	assignedNoteCategories: string[]
}

export interface PCOTimerItem {
	id: string
	title: string
	itemType: string
	sequence: number
	lengthInSeconds: number
	elapsedSeconds: number
	isRunning: boolean
	servicePlanTitle: string | null
	notes: Record<string, string>
	noteIds: Record<string, string>
	pcoServiceTypeId: string | null
	pcoPlanId: string | null
	isDurationActual: boolean
}

/** `lengthInSeconds - elapsedSeconds`, matching PCOTimerItem's own computed property — for a *non-active* item; the active item's authoritative remaining time is `ActiveTimer.remainingSeconds` instead. */
export function planItemRemainingSeconds(item: PCOTimerItem): number {
	return item.lengthInSeconds - item.elapsedSeconds
}

export interface InterTeamMessage {
	id: string
	sender: string
	targetRoleId: string | null
	senderRoleId: string | null
	text: string
	/** ISO-8601. */
	timestamp: string
	isHighPriority: boolean
}

// MARK: - State snapshot (ControlAPIState)

export interface NetworkStatus {
	isMasterServer: boolean
	isLANConnected: boolean
	isProducerLive: boolean
	hasSyncedWithProducer: boolean
	connectedMasterName: string | null
	lanPort: number
	relayEnabled: boolean
	relayHost: string
}

/**
 * Sync protocol v2 timer anchor (PROTOCOL-V2.md): `elapsedMs` was true at
 * `anchorMs` on the app's clock; a running timer advances from there, so a
 * client can render the countdown itself with no further pushes.
 */
export interface TimerAnchor {
	itemId: string
	lengthInSeconds: number
	/** Elapsed time at `anchorMs`, in ms. */
	elapsedMs: number
	/** App epoch ms at which `elapsedMs` was true. */
	anchorMs: number
	isRunning: boolean
	isDurationActual: boolean
}

export interface ActiveTimer {
	item: PCOTimerItem
	index: number
	isRunning: boolean
	remainingSeconds: number
	isOvertime: boolean
	/** The exact string the app's own screen shows (`TimeFormatting.string`). */
	formattedRemaining: string
	isDurationActualForDisplay: boolean
	/** Present on apps that speak sync protocol v2; absent on older ones. */
	anchor?: TimerAnchor | null
}

export interface PlanStatus {
	title: string | null
	items: PCOTimerItem[]
	activeItemIndex: number
	isAtEndOfPlan: boolean
	canLoadNextService: boolean
	pcoServiceTypeId: string | null
	pcoPlanId: string | null
}

export interface IdentifiedName {
	id: string
	name: string
}

export interface PCOPlanInfo {
	id: string
	title: string
	dates: string | null
}

export interface PCOStatus {
	isConnected: boolean
	userName: string | null
	isLiveSyncEnabled: boolean
	lastError: string | null
	selectedServiceTypeId: string | null
	defaultServiceTypeId: string | null
	/** `PCOPlanFilter` raw value: future | past | no_dates | undated. */
	planFilter: string
	serviceTypes: IdentifiedName[]
	plans: PCOPlanInfo[]
	noteCategories: IdentifiedName[]
}

export const PCO_PLAN_FILTERS: { id: string; label: string }[] = [
	{ id: 'future', label: 'Upcoming' },
	{ id: 'past', label: 'Past' },
	{ id: 'no_dates', label: 'No Dates' },
	{ id: 'undated', label: 'Undated' },
]

export interface PlotipharStatus {
	pairingState: string
	pairingCode: string | null
	pairingExpiresAt: string | null
	pairingError: string | null
	assignmentSyncStatus: string
	assignmentSyncEventId: string | null
	assignmentSyncError: string | null
	roles: IdentifiedName[]
}

/**
 * `HourFormatThreshold` raw values (Sources/Shared/Models/HourFormatThreshold.swift).
 * CONTROL-API.md's `PATCH /v1/settings` row says "Valid values: under1Hour,
 * over1Hour" — the code wins: the actual enum has never had those cases.
 * `never` means always display MM:SS, however long; the other two are the
 * elapsed-seconds threshold at which display switches to H:MM:SS.
 */
export type HourFormatThreshold = 'over60Minutes' | 'over90Minutes' | 'never'

export const HOUR_FORMAT_THRESHOLDS: { id: HourFormatThreshold; label: string }[] = [
	{ id: 'over60Minutes', label: 'Switch to H:MM:SS over 60 minutes' },
	{ id: 'over90Minutes', label: 'Switch to H:MM:SS over 90 minutes' },
	{ id: 'never', label: 'Never — always MM:SS' },
]

export interface SettingsStatus {
	hourFormatThreshold: HourFormatThreshold
	controlAPIPort: number
	connectedAPIClients: number
}

/**
 * A named bookmark pointing at whatever item in *this week's* plan carries it
 * — "sermon", "offering" — so a Companion button can be authored once against
 * a stable name and keep working when next week's plan renumbers everything.
 *
 * `itemId` is null when the waypoint exists in the library but nothing in the
 * loaded plan carries it. That distinction is the whole reason this is worth a
 * feedback: firing an unassigned waypoint answers 409, not 404, so an operator
 * can tell "I typo'd the name" from "nobody tagged this week's plan yet" —
 * and a button that paints itself dark beforehand saves finding out by pressing.
 */
export interface WaypointStatus {
	id: string
	name: string
	/** URL/wire-safe form of `name` — what a button should be pointed at, since it survives spaces and punctuation in a path. Routes accept either this or `id`. */
	slug: string
	itemId: string | null
	itemTitle: string | null
	itemIndex: number | null
}

export interface ScheduleEntry {
	id: string
	title: string
	/** ISO-8601. */
	startsAt: string
	/** ISO-8601 — `startsAt` minus the lead time, precomputed by the app so a client never does date arithmetic. */
	goLiveAt: string
	goLiveOffsetSeconds: number
	goLiveOffsetMinutes: number
	pcoServiceTypeId: string | null
	pcoPlanId: string | null
	recurrence: string
	isEnabled: boolean
	/** ISO-8601, or null if it has never fired. */
	lastFiredAt: string | null
}

export interface ScheduleStatus {
	entries: ScheduleEntry[]
	/** The next enabled schedule still ahead of now. */
	nextId: string | null
}

/**
 * `ServiceSchedule.Recurrence` raw values — the enum has exactly these two.
 * There is no daily or monthly: anything else is a 400 from the create/update
 * routes. A `once` schedule stamps `lastFiredAt` and disables itself after
 * firing; a `weekly` one rolls `startsAt` forward by calendar day and stays
 * armed.
 */
export const SCHEDULE_RECURRENCES: { id: string; label: string }[] = [
	{ id: 'once', label: 'One time' },
	{ id: 'weekly', label: 'Weekly' },
]

export interface ControlAPIState {
	appMode: string
	network: NetworkStatus
	roles: RoleCue[]
	selectedRoleIds: string[]
	/** `null` when no plan is loaded or the loaded plan is headers-only. */
	timer: ActiveTimer | null
	plan: PlanStatus
	messages: InterTeamMessage[]
	/**
	 * When the producer last dismissed the standing notification, or null if
	 * one is standing (or none ever has). A message newer than this is still
	 * showing as a lower third on the pagers — see `ModuleState.hasStandingNotification`.
	 */
	notificationsClearedAt: string | null
	pco: PCOStatus
	plotiphar: PlotipharStatus
	settings: SettingsStatus
	waypoints: WaypointStatus[]
	schedules: ScheduleStatus
	/** Monotonic revision of the app's state — absent from older app versions. */
	rev?: number
	/** The app's wall clock (epoch ms) when this snapshot was taken — absent from older app versions. */
	serverNowMs?: number
	/** Random id the app picks at launch (sync protocol v2.1). A different value means the app restarted. Absent from v2.0 and older apps. */
	epoch?: number
}

/** Slim payload of the `timer` event and `GET /v1/timer`: the timer alone, with the same revision stamp as a full snapshot. */
export interface TimerSnapshot {
	rev?: number
	serverNowMs?: number
	epoch?: number
	timer: ActiveTimer | null
}

export interface StartTimerBody {
	startTimer: boolean
}

export interface HealthInfo {
	service: string
	version: string
	device: string
	role: 'master' | 'client'
}

// MARK: - Errors

export interface ControlAPIErrorBody {
	error: string
	detail?: string
}

// MARK: - WebSocket wire protocol

export interface HelloEvent {
	event: 'hello'
	data: ControlAPIState
}

export interface StateEvent {
	event: 'state'
	data: ControlAPIState
}

export interface MessageEvent {
	event: 'message'
	data: InterTeamMessage
}

export interface TimerEvent {
	event: 'timer'
	data: TimerSnapshot
}

/** Section hashes of sync protocol v2 (16 lowercase hex digits each). */
export interface DigestHashes {
	roles: string
	timer: string
	plan: string
	messages: string
}

export interface DigestData {
	rev?: number
	serverNowMs?: number
	epoch?: number
	hashes: DigestHashes
}

export interface DigestEvent {
	event: 'digest'
	data: DigestData
}

export type ServerEvent = HelloEvent | StateEvent | MessageEvent | TimerEvent | DigestEvent

/** Reply `data` of the socket op `sync` and `POST /v1/sync`. */
export interface SyncReplyData {
	t0: number
	t1: number
	t2: number
}

/** Client-to-server command envelope. `op` is the dotted form of a REST path (`plan.next`, `roles.{id}.cue`). */
export interface CommandEnvelope {
	id?: string
	op: string
	body?: unknown
}

export interface CommandReply {
	id?: string
	status: number
	data?: unknown
	error?: string
}

// MARK: - Request bodies (mirrors ControlAPIRequests in ControlAPIModels.swift)

export interface RoleUpdateBody {
	name?: string
	personName?: string
	plotipharRoleId?: string
	assignedNoteCategories?: string[]
	state?: CueStateValue
}

export interface PlanItemCreateBody {
	title: string
	itemType?: string
	lengthInSeconds?: number
	isDurationActual?: boolean
}

export interface PlanItemUpdateBody {
	title?: string
	itemType?: string
	lengthInSeconds?: number
	notes?: Record<string, string>
	isDurationActual?: boolean
}

export interface MessageBody {
	text: string
	targetRoleId?: string
	senderRoleId?: string
	isHighPriority?: boolean
}

export interface TimerRemainingBody {
	seconds?: number
	input?: string
}

export interface WaypointCreateBody {
	name: string
}

export interface WaypointUpdateBody {
	name?: string
}

export interface WaypointAssignBody {
	/** Omit or send null to unassign the waypoint from whatever it currently points at. */
	itemId?: string | null
}

export interface WaypointFireBody {
	/** Defaults to true server-side: firing a waypoint does what tapping its row does, clock included. False pre-rolls to the cue without starting it. */
	startTimer?: boolean
}

export interface PlanItemWaypointsBody {
	/** The complete set of waypoints this item carries, by id or slug — replaces whatever it had. */
	waypoints: string[]
}

export interface ScheduleCreateBody {
	title: string
	/** ISO-8601. */
	startsAt: string
	/** Two spellings of the same lead time; minutes wins if both are sent, and minutes is how a producer thinks about it ("thirty minutes before"). */
	goLiveOffsetSeconds?: number
	goLiveOffsetMinutes?: number
	pcoServiceTypeId?: string
	pcoPlanId?: string
	recurrence?: string
	isEnabled?: boolean
}

export interface ScheduleUpdateBody {
	title?: string
	startsAt?: string
	goLiveOffsetSeconds?: number
	goLiveOffsetMinutes?: number
	pcoServiceTypeId?: string
	pcoPlanId?: string
	recurrence?: string
	isEnabled?: boolean
}

/**
 * Narrows an option value before stringifying it.
 *
 * Companion 2.x types option values as `JsonValue`, which includes objects and
 * arrays — `String(someObject)` would quietly produce "[object Object]" and
 * send that to the API as a role id. This makes the non-scalar case an empty
 * string instead, which every call site already treats as "not set".
 */
export function optString(value: unknown): string {
	if (value === null || value === undefined) return ''
	if (typeof value === 'string') return value
	if (typeof value === 'number' || typeof value === 'boolean') return String(value)
	return ''
}
