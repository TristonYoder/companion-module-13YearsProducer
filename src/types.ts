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

// MARK: - Cue state

/** `CueState` raw values (Sources/Shared/Models/CueState.swift) — always uppercase on the wire. */
export type CueStateValue = 'OFF' | 'STANDBY' | 'GO' | 'FLASH_STANDBY' | 'FLASH_GO'

export const CUE_STATES: CueStateValue[] = ['OFF', 'STANDBY', 'GO', 'FLASH_STANDBY', 'FLASH_GO']

/**
 * Every state a cue-firing route (`roles.{id}.cue`, `cues.selected`) accepts.
 * CONTROL-API.md's route table says "GO, STANDBY, RESET" for these two routes,
 * but `CueState` (the Swift enum the router actually decodes into) has no
 * `RESET` case at all — sending it 400s. The code wins: this app's own
 * "clear a cue" gesture posts `OFF`, and `cues.clear` (a distinct route) is
 * the bulk equivalent.
 */
export const FIRABLE_CUE_STATES: CueStateValue[] = ['OFF', 'STANDBY', 'GO', 'FLASH_STANDBY', 'FLASH_GO']

export const CUE_STATE_LABELS: Record<CueStateValue, string> = {
	OFF: 'Clear',
	STANDBY: 'Standby',
	GO: 'Go!',
	FLASH_STANDBY: 'Standby (Flash)',
	FLASH_GO: 'Go! (Flash)',
}

/** RGB triples lifted verbatim from CueState.swift's `color`/`textColor` so a Companion button matches the app's own screen. */
export const CUE_STATE_COLOR: Record<CueStateValue, [number, number, number]> = {
	OFF: [20, 26, 38],
	STANDBY: [245, 184, 38],
	GO: [38, 199, 89],
	FLASH_STANDBY: [245, 184, 38],
	FLASH_GO: [38, 199, 89],
}

export const CUE_STATE_TEXT_COLOR: Record<CueStateValue, [number, number, number]> = {
	OFF: [255, 255, 255],
	STANDBY: [26, 26, 26],
	GO: [255, 255, 255],
	FLASH_STANDBY: [26, 26, 26],
	FLASH_GO: [255, 255, 255],
}

/**
 * The three-step toggle a single template button cycles through on repeated
 * presses: Standby → Go! → Clear → Standby → … The two FLASH_* states are
 * deliberately not steps in this cycle (a toggle button only ever needs one
 * state per stop) — a role currently flashing is treated as whichever base
 * state it's flashing (`FLASH_STANDBY` advances like `STANDBY`, `FLASH_GO`
 * like `GO`) so a flashing cue still toggles forward sensibly instead of
 * getting stuck.
 */
export const CUE_CYCLE_NEXT: Record<CueStateValue, CueStateValue> = {
	OFF: 'STANDBY',
	STANDBY: 'GO',
	GO: 'OFF',
	FLASH_STANDBY: 'GO',
	FLASH_GO: 'OFF',
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

export interface ActiveTimer {
	item: PCOTimerItem
	index: number
	isRunning: boolean
	remainingSeconds: number
	isOvertime: boolean
	/** The exact string the app's own screen shows (`TimeFormatting.string`). */
	formattedRemaining: string
	isDurationActualForDisplay: boolean
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

export interface ControlAPIState {
	appMode: string
	network: NetworkStatus
	roles: RoleCue[]
	selectedRoleIds: string[]
	/** `null` when no plan is loaded or the loaded plan is headers-only. */
	timer: ActiveTimer | null
	plan: PlanStatus
	messages: InterTeamMessage[]
	pco: PCOStatus
	plotiphar: PlotipharStatus
	settings: SettingsStatus
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

export type ServerEvent = HelloEvent | StateEvent | MessageEvent

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
