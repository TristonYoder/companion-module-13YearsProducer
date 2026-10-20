import { ClockSync, anchorElapsedMs, anchorElapsedSeconds, anchorRemainingSeconds, monotonicEpochNow } from './sync.js'
import { formatDuration, parseTimerInput, previewText, resolvedSeconds, signOf, withSign } from './timerEntry.js'
import type { TimerEntrySign, TimerInputAction } from './timerEntry.js'
import { isHeaderItem } from './itemDetails.js'
import { isClockFormat } from './types.js'
import type {
	ActiveTimer,
	ClockFormatValue,
	ControlAPIState,
	InterTeamMessage,
	ItemActual,
	LiveOpsStatus,
	NetworkStatus,
	PCOPlanTime,
	PCOStatus,
	PCOTimerItem,
	PlanStatus,
	PlotipharStatus,
	RoleCue,
	ScheduleEntry,
	ScheduleStatus,
	EventTimeEntry,
	EventTimesStatus,
	SettingsStatus,
	TimerAnchor,
	TimerSnapshot,
	WaypointStatus,
} from './types.js'

const DEFAULT_HOUR_FORMAT_THRESHOLD = 'over90Minutes'

export const RUNDOWN_ROWS = 8

export const STALE_AFTER_MS = 8000

export const STALE_AFTER_MS_V2 = 5000

export const ACTION_ERROR_HOLD_MS = 10000

export const MAX_INDEXED_ROLES = 16

export const MAX_REV_JUMP = 1_000_000

export const ANCHOR_MAX_LENGTH_SECONDS = 604_800
export const ANCHOR_MAX_ELAPSED_MS = 604_800_000

export const ADHOC_SKIPS_KEY = 'adhoc'
export const REHEARSAL_SKIPS_KEY = 'rehearsal'

export function formatClockParts(
	hours: number,
	minutes: number,
	seconds: number | null,
	format: ClockFormatValue | null,
): string {
	const pad = (n: number) => String(n).padStart(2, '0')
	if (format === 'twelveHour') {
		const hour12 = hours % 12 === 0 ? 12 : hours % 12
		const suffix = hours < 12 ? 'AM' : 'PM'
		return seconds === null
			? `${hour12}:${pad(minutes)} ${suffix}`
			: `${hour12}:${pad(minutes)}:${pad(seconds)} ${suffix}`
	}
	return seconds === null ? `${pad(hours)}:${pad(minutes)}` : `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`
}

export function formatMinutesSeconds(totalSeconds: number): string {
	const seconds = Math.max(0, Math.floor(totalSeconds))
	return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

export function isAnchorInBounds(anchor: TimerAnchor): boolean {
	return (
		Number.isFinite(anchor.lengthInSeconds) &&
		Number.isFinite(anchor.elapsedMs) &&
		Number.isFinite(anchor.anchorMs) &&
		anchor.lengthInSeconds >= 0 &&
		anchor.lengthInSeconds <= ANCHOR_MAX_LENGTH_SECONDS &&
		anchor.elapsedMs >= 0 &&
		anchor.elapsedMs <= ANCHOR_MAX_ELAPSED_MS
	)
}

function withSaneAnchor(timer: ActiveTimer | null | undefined): ActiveTimer | null {
	if (!timer) return null
	if (!timer.anchor || isAnchorInBounds(timer.anchor)) return timer
	return { ...timer, anchor: null }
}

export interface ApplyOptions {
	hello?: boolean
	catchUp?: boolean
}

export function slugify(text: string): string {
	const slug = text
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '_')
		.replace(/^_+|_+$/g, '')
	return slug || 'role'
}

export function uniqueRoleSlugs(roles: RoleCue[]): Map<string, string> {
	const counts = new Map<string, number>()
	const slugs = new Map<string, string>()
	for (const role of roles) {
		const base = slugify(role.name)
		const count = (counts.get(base) ?? 0) + 1
		counts.set(base, count)
		slugs.set(role.id, count === 1 ? base : `${base}_${count}`)
	}
	return slugs
}

export class ModuleState {
	snapshot: ControlAPIState | null = null
	isSocketConnected = false
	lastMessage: InterTeamMessage | null = null
	timerEntryBuffer = ''
	rev: number | null = null
	epoch: number | null = null
	onEpochChange?: (needsState: boolean) => void
	private actionError: { message: string; at: number } | null = null
	private lastPressAt = new Map<string, number>()
	serverOffsetMs = 0
	lastFrameAt: number | null = null
	rundownPage = 0

	protoVersion: 1 | 2 = 1
	readonly sync: ClockSync

	constructor(readonly clock: () => number = monotonicEpochNow) {
		this.sync = new ClockSync(clock)
	}

	setProtoVersion(version: 1 | 2): void {
		this.protoVersion = version
		if (version === 1) this.sync.reset()
	}

	resetRev(): void {
		this.rev = null
	}

	reset(): void {
		this.snapshot = null
		this.isSocketConnected = false
		this.lastMessage = null
		this.rev = null
		this.epoch = null
		this.serverOffsetMs = 0
		this.lastFrameAt = null
		this.rundownPage = 0
		this.protoVersion = 1
		this.sync.reset()
	}

	observeEpoch(epoch: number | undefined | null, needsState = true): boolean {
		if (typeof epoch !== 'number') return false
		const previous = this.epoch
		this.epoch = epoch
		if (previous === null || previous === epoch) return false
		this.rev = null
		this.sync.reset()
		if (this.snapshot?.timer?.anchor) {
			this.snapshot = { ...this.snapshot, timer: { ...this.snapshot.timer, anchor: null } }
		}
		this.onEpochChange?.(needsState)
		return true
	}

	private acceptRev(
		rev: number | undefined,
		serverNowMs: number | undefined,
		epochChanged: boolean,
		options: ApplyOptions,
	): boolean {
		if (typeof rev === 'number') {
			const held = this.rev
			if (held !== null && !options.hello && !epochChanged) {
				if (options.catchUp ? rev < held : rev <= held) return false
				if (!options.catchUp && rev - held > MAX_REV_JUMP) return false
			}
			this.rev = rev
		}
		if (typeof serverNowMs === 'number') this.serverOffsetMs = serverNowMs - this.clock()
		return true
	}

	applyState(state: ControlAPIState, options: ApplyOptions = {}): boolean {
		const epochChanged = this.observeEpoch(state.epoch, false)
		if (options.hello) this.rev = null
		if (!this.acceptRev(state.rev, state.serverNowMs, epochChanged, options)) return false
		this.snapshot = state.timer?.anchor ? { ...state, timer: withSaneAnchor(state.timer) } : state
		return true
	}

	applyTimer(event: TimerSnapshot): boolean {
		const epochChanged = this.observeEpoch(event.epoch, true)
		if (!this.snapshot) return false
		if (!this.acceptRev(event.rev, event.serverNowMs, epochChanged, {})) return false
		this.snapshot = { ...this.snapshot, timer: withSaneAnchor(event.timer) }
		return true
	}

	get nowMs(): number {
		return this.sync.hasOffset ? this.sync.producerNowMs() : this.clock() + this.serverOffsetMs
	}

	producerNowMs(): number {
		return this.nowMs
	}

	markFrame(): void {
		this.lastFrameAt = this.clock()
	}

	get isStale(): boolean {
		return this.isSocketConnected && this.lastFrameAt !== null && this.clock() - this.lastFrameAt > this.staleAfterMs
	}

	get staleAfterMs(): number {
		return this.protoVersion === 2 ? STALE_AFTER_MS_V2 : STALE_AFTER_MS
	}

	applyMessage(message: InterTeamMessage): void {
		this.lastMessage = message
		const snapshot = this.snapshot
		if (!snapshot) return
		if (snapshot.messages.some((m) => m.id === message.id)) return
		snapshot.messages = [message, ...snapshot.messages]
	}

	setSocketConnected(connected: boolean): void {
		this.isSocketConnected = connected
		if (!connected) this.lastFrameAt = null
		else if (this.lastFrameAt === null) this.lastFrameAt = this.clock()
	}

	noteActionError(message: string): void {
		this.actionError = { message, at: this.clock() }
	}

	get currentActionError(): string {
		const error = this.actionError
		if (!error) return ''
		if (this.clock() - error.at > ACTION_ERROR_HOLD_MS) {
			this.actionError = null
			return ''
		}
		return error.message
	}

	get actionFailed(): boolean {
		return this.currentActionError !== ''
	}

	shouldIgnoreRepeat(key: string, windowMs: number): boolean {
		const now = this.clock()
		const last = this.lastPressAt.get(key)
		if (windowMs > 0 && last !== undefined && now - last < windowMs) return true
		this.lastPressAt.set(key, now)
		return false
	}

	get roles(): RoleCue[] {
		return this.snapshot?.roles ?? []
	}

	get selectedRoleIds(): string[] {
		return this.snapshot?.selectedRoleIds ?? []
	}

	get timer(): ActiveTimer | null {
		return this.snapshot?.timer ?? null
	}

	get timerAnchor(): TimerAnchor | null {
		if (this.protoVersion !== 2) return null
		return this.snapshot?.timer?.anchor ?? null
	}

	get timerRemainingSeconds(): number | null {
		const timer = this.timer
		if (!timer) return null
		const anchor = this.timerAnchor
		return anchor ? anchorRemainingSeconds(anchor, this.nowMs) : timer.remainingSeconds
	}

	get timerElapsedSeconds(): number {
		const timer = this.timer
		if (!timer) return 0
		const anchor = this.timerAnchor
		return anchor ? anchorElapsedSeconds(anchor, this.nowMs) : (timer.item?.elapsedSeconds ?? 0)
	}

	get timerIsOvertime(): boolean {
		const remaining = this.timerRemainingSeconds
		if (remaining === null) return false
		return this.timerAnchor ? remaining < 0 : this.timer?.isOvertime === true
	}

	get timerFormattedRemaining(): string {
		const timer = this.timer
		if (!timer) return ''
		const remaining = this.timerRemainingSeconds
		return this.timerAnchor && remaining !== null ? this.formatSeconds(remaining) : timer.formattedRemaining
	}

	get timerLengthSeconds(): number {
		const timer = this.timer
		if (!timer) return 0
		return this.timerAnchor?.lengthInSeconds ?? timer.item?.lengthInSeconds ?? 0
	}

	get activeItemElapsedText(): string {
		return this.timer ? formatMinutesSeconds(this.timerElapsedSeconds) : ''
	}

	get activeItemLengthText(): string {
		return this.timer ? formatMinutesSeconds(this.timerLengthSeconds) : ''
	}

	get activeItemOvertimeText(): string {
		if (!this.timerIsOvertime) return ''
		const remaining = this.timerRemainingSeconds
		return remaining === null ? '' : `+${formatMinutesSeconds(-remaining)}`
	}

	get itemEndsAtMs(): number | null {
		const timer = this.timer
		if (!timer) return null
		const anchor = this.timerAnchor
		if (anchor) {
			if (!anchor.isRunning) return null
			const end = anchor.anchorMs + (anchor.lengthInSeconds * 1000 - anchor.elapsedMs)
			return end > this.nowMs ? end : null
		}
		const remaining = this.timerRemainingSeconds
		if (!timer.isRunning || remaining === null || remaining <= 0) return null
		return this.nowMs + remaining * 1000
	}

	get itemEndsAtText(): string {
		const end = this.itemEndsAtMs
		if (end === null) return ''
		const date = new Date(end)
		const pad = (n: number) => String(n).padStart(2, '0')
		return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
	}

	get syncQualityText(): string {
		if (this.protoVersion !== 2) return 'legacy'
		const rtt = this.sync.rttMs
		return rtt === null ? 'v2' : `v2 ±${Math.round(rtt / 2)} ms`
	}

	get producerUtcOffsetSeconds(): number | null {
		const offset = this.snapshot?.utcOffsetSeconds
		return typeof offset === 'number' && Number.isFinite(offset) ? offset : null
	}

	get producerTimeText(): string {
		const offset = this.producerUtcOffsetSeconds
		if (offset === null || !this.sync.hasOffset) return ''
		return new Date(this.sync.producerNowMs() + offset * 1000).toISOString().slice(11, 19)
	}

	get producerUtcOffsetText(): string {
		const offset = this.producerUtcOffsetSeconds
		if (offset === null) return ''
		const abs = Math.abs(offset)
		const hh = String(Math.floor(abs / 3600)).padStart(2, '0')
		const mm = String(Math.floor((abs % 3600) / 60)).padStart(2, '0')
		return `UTC${offset < 0 ? '-' : '+'}${hh}:${mm}`
	}

	get plan(): PlanStatus | null {
		return this.snapshot?.plan ?? null
	}

	get pco(): PCOStatus | null {
		return this.snapshot?.pco ?? null
	}

	get plotiphar(): PlotipharStatus | null {
		return this.snapshot?.plotiphar ?? null
	}

	get settings(): SettingsStatus | null {
		return this.snapshot?.settings ?? null
	}

	get network(): NetworkStatus | null {
		return this.snapshot?.network ?? null
	}

	get isAtStartOfPlan(): boolean {
		const plan = this.plan
		if (!plan) return true
		if (typeof plan.isAtStartOfPlan === 'boolean') return plan.isAtStartOfPlan
		for (let i = plan.activeItemIndex - 1; i >= 0; i--) {
			if (plan.items[i]?.itemType?.toLowerCase() !== 'header') return false
		}
		return true
	}

	roleById(id: string): RoleCue | undefined {
		return this.roles.find((r) => r.id === id)
	}

	isRoleSelected(id: string): boolean {
		return this.selectedRoleIds.includes(id)
	}

	roleChoices(): { id: string; label: string }[] {
		return this.roles.map((r) => ({ id: r.id, label: r.name }))
	}

	planItemChoices(): { id: string; label: string }[] {
		return (this.plan?.items ?? []).map((item) => ({ id: item.id, label: item.title }))
	}

	nextPlanItem(): PCOTimerItem | undefined {
		const timer = this.timer
		if (timer && 'nextItem' in timer) return timer.nextItem ?? undefined
		const plan = this.plan
		if (!plan) return undefined
		return plan.items
			.slice(plan.activeItemIndex + 1)
			.find((item) => !isHeaderItem(item) && !this.isItemPassedOver(item))
	}

	get clockFormat(): ClockFormatValue | null {
		const format = this.settings?.clockFormat
		return isClockFormat(format) ? format : null
	}

	formatClockMs(ms: number, withSeconds = false): string {
		const offset = this.producerUtcOffsetSeconds
		const date = new Date(offset === null ? ms : ms + offset * 1000)
		const hours = offset === null ? date.getHours() : date.getUTCHours()
		const minutes = offset === null ? date.getMinutes() : date.getUTCMinutes()
		const seconds = offset === null ? date.getSeconds() : date.getUTCSeconds()
		return formatClockParts(hours, minutes, withSeconds ? seconds : null, this.clockFormat)
	}

	get producerClockText(): string {
		if (this.producerUtcOffsetSeconds === null || !this.sync.hasOffset) return ''
		return this.formatClockMs(this.sync.producerNowMs())
	}

	get itemEndsAtClockText(): string {
		const end = this.itemEndsAtMs
		return end === null ? '' : this.formatClockMs(end)
	}

	get projectedEndClockText(): string {
		const end = this.projectedEndMs
		return end === null ? '' : this.formatClockMs(end)
	}

	get nextItemStartsAtText(): string {
		const startsAt = this.timer?.nextStartsAtMs
		return typeof startsAt === 'number' && Number.isFinite(startsAt) ? this.formatClockMs(startsAt) : ''
	}

	get liveOps(): LiveOpsStatus | null {
		const liveOps = this.snapshot?.liveOps
		return liveOps && typeof liveOps === 'object' ? liveOps : null
	}

	get isRehearsalMode(): boolean {
		return this.liveOps?.isRehearsalMode === true
	}

	get skipsKey(): string {
		if (this.isRehearsalMode) return REHEARSAL_SKIPS_KEY
		return this.eventTimes?.liveId || ADHOC_SKIPS_KEY
	}

	get skippedItemIds(): string[] {
		const ids = this.liveOps?.skippedItemIds?.[this.skipsKey]
		return Array.isArray(ids) ? ids : []
	}

	isItemSkipped(id: string): boolean {
		return this.skippedItemIds.includes(id)
	}

	get activePlanTimeId(): string | null {
		const live = this.liveEventTime?.pcoPlanTimeId ?? null
		if (this.isRehearsalMode) return this.liveOps?.rehearsalPlanTimeId ?? live
		return live
	}

	isItemExcluded(item: PCOTimerItem): boolean {
		const planTimeId = this.activePlanTimeId
		if (!planTimeId) return false
		const times = item.details?.itemTimes
		if (!Array.isArray(times)) return false
		return times.some((time) => time.planTimeId === planTimeId && time.exclude === true)
	}

	isItemPassedOver(item: PCOTimerItem): boolean {
		if (isHeaderItem(item)) return false
		return this.isItemSkipped(item.id) || this.isItemExcluded(item)
	}

	get rehearsalTimes(): PCOPlanTime[] {
		const times = this.pco?.planContext?.times
		return Array.isArray(times) ? times.filter((time) => time.timeType === 'rehearsal') : []
	}

	get rehearsalTime(): PCOPlanTime | undefined {
		if (!this.isRehearsalMode) return undefined
		const id = this.liveOps?.rehearsalPlanTimeId
		const times = this.rehearsalTimes
		return id ? times.find((time) => time.id === id) : undefined
	}

	planTimeLabel(time: PCOPlanTime): string {
		const name = time.name?.trim()
		if (name) return name
		const starts = time.startsAt ? Date.parse(time.startsAt) : NaN
		return Number.isNaN(starts) ? time.id : this.formatClockMs(starts)
	}

	rehearsalTimeChoices(): { id: string; label: string }[] {
		return this.rehearsalTimes.map((time) => ({ id: time.id, label: this.planTimeLabel(time) }))
	}

	get isLoggingActuals(): boolean {
		return this.liveOps !== null && !this.isRehearsalMode
	}

	get currentActuals(): ItemActual[] {
		const liveOps = this.liveOps
		if (!liveOps || !Array.isArray(liveOps.actuals)) return []
		const eventTimeId = liveOps.actualsEventTimeId ?? null
		return liveOps.actuals.filter((actual) => (actual.eventTimeId ?? null) === eventTimeId)
	}

	get completedActuals(): ItemActual[] {
		return this.currentActuals.filter((actual) => !!actual.endedAt && typeof actual.lengthSeconds === 'number')
	}

	get actualOverUnderSeconds(): number | null {
		const items = new Map((this.plan?.items ?? []).map((item) => [item.id, item]))
		let total = 0
		let counted = 0
		for (const actual of this.completedActuals) {
			const item = items.get(actual.itemId)
			if (!item) continue
			total += (actual.lengthSeconds ?? 0) - item.lengthInSeconds
			counted++
		}
		return counted === 0 ? null : total
	}

	get actualOverUnderText(): string {
		const delta = this.actualOverUnderSeconds
		if (delta === null) return ''
		return `${delta < 0 ? '-' : '+'}${this.formatSeconds(Math.abs(delta))}`
	}

	roleSlugs(): Map<string, string> {
		return uniqueRoleSlugs(this.roles)
	}

	get waypoints(): WaypointStatus[] {
		return this.snapshot?.waypoints ?? []
	}

	waypointByRef(ref: string): WaypointStatus | undefined {
		return this.waypoints.find((w) => w.id === ref || w.slug === ref)
	}

	isWaypointAssigned(ref: string): boolean {
		const waypoint = this.waypointByRef(ref)
		return waypoint?.itemId != null
	}

	waypointChoices(): { id: string; label: string }[] {
		return this.waypoints.map((w) => ({ id: w.slug, label: w.name }))
	}

	get schedules(): ScheduleStatus | null {
		return this.snapshot?.schedules ?? null
	}

	get scheduleEntries(): ScheduleEntry[] {
		return this.schedules?.entries ?? []
	}

	get nextSchedule(): ScheduleEntry | undefined {
		const nextId = this.schedules?.nextId
		if (!nextId) return undefined
		return this.scheduleEntries.find((e) => e.id === nextId)
	}

	scheduleById(id: string): ScheduleEntry | undefined {
		return this.scheduleEntries.find((e) => e.id === id)
	}

	scheduleChoices(): { id: string; label: string }[] {
		return this.scheduleEntries.map((e) => ({ id: e.id, label: e.title }))
	}

	get eventTimes(): EventTimesStatus | null {
		return this.snapshot?.eventTimes ?? null
	}

	get eventTimeEntries(): EventTimeEntry[] {
		const entries = this.eventTimes?.entries
		return Array.isArray(entries) ? entries : []
	}

	get liveEventTime(): EventTimeEntry | undefined {
		const liveId = this.eventTimes?.liveId
		if (!liveId) return undefined
		return this.eventTimeEntries.find((e) => e.id === liveId)
	}

	get nextEventTime(): EventTimeEntry | undefined {
		const nextId = this.eventTimes?.nextId
		if (!nextId) return undefined
		return this.eventTimeEntries.find((e) => e.id === nextId)
	}

	eventTimeChoices(): { id: string; label: string }[] {
		return this.eventTimeEntries.map((e) => ({ id: e.id, label: e.displayName || e.id }))
	}

	get hasStandingNotification(): boolean {
		const newest = this.snapshot?.messages[0]
		if (!newest) return false
		const clearedAt = this.snapshot?.notificationsClearedAt
		if (!clearedAt) return true
		return new Date(newest.timestamp).getTime() > new Date(clearedAt).getTime()
	}

	appendTimerEntry(text: string): void {
		this.timerEntryBuffer += text
	}

	setTimerEntrySign(sign: TimerEntrySign): void {
		this.timerEntryBuffer = withSign(this.timerEntryBuffer, sign)
	}

	backspaceTimerEntry(): void {
		this.timerEntryBuffer = this.timerEntryBuffer.slice(0, -1)
	}

	clearTimerEntry(): void {
		this.timerEntryBuffer = ''
	}

	get timerEntryAction(): TimerInputAction | null {
		return parseTimerInput(this.timerEntryBuffer)
	}

	get timerEntrySign(): TimerEntrySign | null {
		return signOf(this.timerEntryBuffer)
	}

	get timerEntryPreview(): string {
		const threshold = this.settings?.hourFormatThreshold ?? DEFAULT_HOUR_FORMAT_THRESHOLD
		const timer = this.timer
		return previewText(
			this.timerEntryBuffer,
			timer ? this.timerRemainingSeconds : null,
			threshold,
			timer ? this.timerElapsedSeconds : 0,
		)
	}

	get timerEntryResultSeconds(): number | null {
		const action = this.timerEntryAction
		if (!action) return null
		const timer = this.timer
		if (action.kind === 'adjustRelative' && !timer) return null
		const seconds = resolvedSeconds(
			action,
			timer ? (this.timerRemainingSeconds ?? 0) : 0,
			timer ? this.timerElapsedSeconds : 0,
		)
		return seconds < 0 ? null : seconds
	}

	formatSeconds(seconds: number): string {
		return formatDuration(seconds, this.settings?.hourFormatThreshold ?? DEFAULT_HOUR_FORMAT_THRESHOLD)
	}

	get serviceRemainingSeconds(): number | null {
		const timer = this.timer
		const plan = this.plan
		if (!timer || !plan) return null
		const after = plan.items
			.slice(plan.activeItemIndex + 1)
			.filter((item) => !this.isItemPassedOver(item))
			.reduce((sum, item) => sum + item.lengthInSeconds, 0)
		return Math.max(0, this.timerRemainingSeconds ?? 0) + after
	}

	get projectedEndMs(): number | null {
		const remaining = this.serviceRemainingSeconds
		if (remaining === null) return null
		const anchor = this.timerAnchor
		if (anchor) {
			const now = this.nowMs
			const liveMs = Math.max(0, anchor.lengthInSeconds * 1000 - anchorElapsedMs(anchor, now))
			return now + liveMs + (remaining - Math.max(0, this.timerRemainingSeconds ?? 0)) * 1000
		}
		return this.nowMs + remaining * 1000
	}

	get projectedEndText(): string {
		const end = this.projectedEndMs
		if (end === null) return ''
		const date = new Date(end)
		return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
	}

	get serviceOverUnderText(): string {
		const end = this.projectedEndMs
		const schedule = this.nextSchedule
		const plan = this.plan
		if (end === null || !schedule || !plan) return ''
		const startsAt = new Date(schedule.startsAt).getTime()
		if (Number.isNaN(startsAt)) return ''
		const planned = plan.items
			.filter((item) => !this.isItemPassedOver(item))
			.reduce((sum, item) => sum + item.lengthInSeconds, 0)
		const delta = Math.round((end - (startsAt + planned * 1000)) / 1000)
		return `${delta < 0 ? '-' : '+'}${this.formatSeconds(Math.abs(delta))}`
	}

	get activeItemProgressPct(): number {
		const item = this.timer?.item
		if (!item || !(item.lengthInSeconds > 0)) return 0
		return Math.max(0, Math.min(100, Math.round((this.timerElapsedSeconds / item.lengthInSeconds) * 100)))
	}

	get rundownPageCount(): number {
		return Math.max(1, Math.ceil((this.plan?.items.length ?? 0) / RUNDOWN_ROWS))
	}

	get rundownPageIndex(): number {
		return Math.max(0, Math.min(this.rundownPage, this.rundownPageCount - 1))
	}

	pageRundown(delta: number): void {
		this.rundownPage = Math.max(0, Math.min(this.rundownPageIndex + delta, this.rundownPageCount - 1))
	}

	rundownRow(row: number): PCOTimerItem | undefined {
		return this.plan?.items[this.rundownPageIndex * RUNDOWN_ROWS + row - 1]
	}

	isRundownRowSkipped(row: number): boolean {
		const item = this.rundownRow(row)
		return item ? this.isItemPassedOver(item) : false
	}

	isRundownRowActive(row: number): boolean {
		const plan = this.plan
		if (!plan) return false
		return this.rundownPageIndex * RUNDOWN_ROWS + row - 1 === plan.activeItemIndex && !!this.rundownRow(row)
	}

	dynamicSignature(): string {
		return JSON.stringify([
			this.roles.map((r) => [r.id, r.name]),
			(this.plan?.items ?? []).map((i) => [i.id, i.title, i.lengthInSeconds]),
			this.waypoints.map((w) => [w.id, w.slug, w.name]),
			this.scheduleEntries.map((e) => [e.id, e.title]),
			this.eventTimeEntries.map((e) => [e.id, e.displayName]),
			this.rehearsalTimes.map((t) => [t.id, t.name ?? null, t.startsAt ?? null]),
			this.clockFormat,
			[
				this.pco?.selectedServiceTypeId ?? null,
				this.pco?.defaultServiceTypeId ?? null,
				(this.pco?.serviceTypes ?? []).map((t) => [t.id, t.name]),
				(this.pco?.plans ?? []).map((p) => [p.id, p.title]),
				this.plan?.title ?? null,
				this.plan?.pcoServiceTypeId ?? null,
				this.plan?.pcoPlanId ?? null,
			],
		])
	}
}
