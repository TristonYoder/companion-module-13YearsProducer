export type CueStateValue = 'OFF' | 'STANDBY' | 'GO'

export const CUE_STATES: CueStateValue[] = ['OFF', 'STANDBY', 'GO']

export const FIRABLE_CUE_STATES: CueStateValue[] = ['OFF', 'STANDBY', 'GO']

export const CUE_STATE_LABELS: Record<CueStateValue, string> = {
	OFF: 'Clear',
	STANDBY: 'Standby',
	GO: 'Go!',
}

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

export const CUE_CYCLE_NEXT: Record<CueStateValue, CueStateValue> = {
	OFF: 'STANDBY',
	STANDBY: 'GO',
	GO: 'OFF',
}

export function nextCueStateInCycle(current: CueStateValue): CueStateValue {
	return CUE_CYCLE_NEXT[current]
}

export type AppModeValue = 'PRODUCER_CONTROL' | 'SERVICE_FLOW' | 'LIVE_PREVIEW' | 'MESSAGES' | 'SETTINGS'

export const APP_MODES: { id: AppModeValue; label: string }[] = [
	{ id: 'PRODUCER_CONTROL', label: 'Producer Control' },
	{ id: 'SERVICE_FLOW', label: 'Service Flow' },
	{ id: 'LIVE_PREVIEW', label: 'Live Preview' },
	{ id: 'MESSAGES', label: 'Messages' },
	{ id: 'SETTINGS', label: 'Settings' },
]

export interface RoleCue {
	id: string
	name: string
	personName: string | null
	state: CueStateValue
	plotipharRoleId: string | null
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

export function planItemRemainingSeconds(item: PCOTimerItem): number {
	return item.lengthInSeconds - item.elapsedSeconds
}

export interface InterTeamMessage {
	id: string
	sender: string
	targetRoleId: string | null
	senderRoleId: string | null
	text: string
	timestamp: string
	isHighPriority: boolean
}

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

export interface TimerAnchor {
	itemId: string
	lengthInSeconds: number
	elapsedMs: number
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
	formattedRemaining: string
	isDurationActualForDisplay: boolean
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

export interface WaypointStatus {
	id: string
	name: string
	slug: string
	itemId: string | null
	itemTitle: string | null
	itemIndex: number | null
}

export interface ScheduleEntry {
	id: string
	title: string
	startsAt: string
	goLiveAt: string
	goLiveOffsetSeconds: number
	goLiveOffsetMinutes: number
	pcoServiceTypeId: string | null
	pcoPlanId: string | null
	recurrence: string
	isEnabled: boolean
	lastFiredAt: string | null
}

export interface ScheduleStatus {
	entries: ScheduleEntry[]
	nextId: string | null
}

export const SCHEDULE_RECURRENCES: { id: string; label: string }[] = [
	{ id: 'once', label: 'One time' },
	{ id: 'weekly', label: 'Weekly' },
]

export interface ControlAPIState {
	appMode: string
	network: NetworkStatus
	roles: RoleCue[]
	selectedRoleIds: string[]
	timer: ActiveTimer | null
	plan: PlanStatus
	messages: InterTeamMessage[]
	notificationsClearedAt: string | null
	pco: PCOStatus
	plotiphar: PlotipharStatus
	settings: SettingsStatus
	waypoints: WaypointStatus[]
	schedules: ScheduleStatus
	rev?: number
	serverNowMs?: number
	epoch?: number
}

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

export interface ControlAPIErrorBody {
	error: string
	detail?: string
}

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

export interface SyncReplyData {
	t0: number
	t1: number
	t2: number
}

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
	itemId?: string | null
}

export interface WaypointFireBody {
	startTimer?: boolean
}

export interface PlanItemWaypointsBody {
	waypoints: string[]
}

export interface ScheduleCreateBody {
	title: string
	startsAt: string
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

export function optString(value: unknown): string {
	if (value === null || value === undefined) return ''
	if (typeof value === 'string') return value
	if (typeof value === 'number' || typeof value === 'boolean') return String(value)
	return ''
}
