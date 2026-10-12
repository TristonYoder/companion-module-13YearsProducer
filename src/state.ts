import { ClockSync, anchorElapsedMs, anchorElapsedSeconds, anchorRemainingSeconds, monotonicEpochNow } from './sync.js'
import { formatDuration, parseTimerInput, previewText, signOf, withSign } from './timerEntry.js'
import type { TimerEntrySign, TimerInputAction } from './timerEntry.js'
import type {
	ActiveTimer,
	ControlAPIState,
	InterTeamMessage,
	NetworkStatus,
	PCOStatus,
	PCOTimerItem,
	PlanStatus,
	PlotipharStatus,
	RoleCue,
	ScheduleEntry,
	ScheduleStatus,
	SettingsStatus,
	TimerAnchor,
	TimerSnapshot,
	WaypointStatus,
} from './types.js'

/** What the app's own time-entry popover previews against when the socket hasn't said otherwise (`timeEntryPopover`'s default `hourFormatThreshold`). */
const DEFAULT_HOUR_FORMAT_THRESHOLD = 'over90Minutes'

/** Rows on the Rundown preset grid. */
export const RUNDOWN_ROWS = 8

/** A socket that has delivered no data frame for longer than this, while "connected", is stale. Pongs do not count: they only prove the socket is open, not that the app is telling us anything. */
export const STALE_AFTER_MS = 7500

/** Sync protocol v2 sockets get a digest every 10 s and push nothing else while idle, so quiet is normal for longer. */
export const STALE_AFTER_MS_V2 = 15000

/** How long `last_action_error` / the `actionFailed` feedback hold after a failed press. */
export const ACTION_ERROR_HOLD_MS = 10000

/** Role-indexed variables (`role_1_name` ...) stop here. */
export const MAX_INDEXED_ROLES = 16

/** A larger `rev` jump than this, without a new epoch, is a corrupt packet rather than progress. */
export const MAX_REV_JUMP = 1_000_000

/** Anchor bounds (PROTOCOL-V2.md, v2.1). */
export const ANCHOR_MAX_LENGTH_SECONDS = 604_800
export const ANCHOR_MAX_ELAPSED_MS = 604_800_000

/** `m:ss`, minutes unpadded and not rolled into hours ("1:12", "75:00"). */
export function formatMinutesSeconds(totalSeconds: number): string {
	const seconds = Math.max(0, Math.floor(totalSeconds))
	return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

/** `false` for an anchor whose numbers are outside the protocol's ranges; such an anchor is ignored. */
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

/** A timer without an out-of-range anchor (the pushed values still describe it); everything else untouched. */
function withSaneAnchor(timer: ActiveTimer | null | undefined): ActiveTimer | null {
	if (!timer) return null
	if (!timer.anchor || isAnchorInBounds(timer.anchor)) return timer
	return { ...timer, anchor: null }
}

export interface ApplyOptions {
	/** A `hello` or priming read: the rev gate is dropped first, and a new epoch needs no follow-up fetch. */
	hello?: boolean
	/** A catch-up read (digest mismatch, epoch change): rebases the rev gate like a PONG, so an equal rev is taken, though never an older one. */
	catchUp?: boolean
}

/** Turns a role name into a variable/preset-id-safe slug (lowercase, underscores). */
export function slugify(text: string): string {
	const slug = text
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '_')
		.replace(/^_+|_+$/g, '')
	return slug || 'role'
}

/** One slug per role, keyed by (stable) role id — appends `_2`, `_3`, etc. when two roles would otherwise collide (renamed/duplicated roles happen mid-service). */
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

/**
 * Holds the latest state pushed over the control socket, plus small derived
 * accessors actions/feedbacks/variables/presets all read from. This module
 * never polls: the only writers are `applyState` (from a `hello`/`state`
 * socket event, or the one-shot `GET /v1/state` used to prime the connection)
 * and `applyMessage` (from a `message` socket event).
 *
 * The one piece of state here that isn't the app's is `timerEntryBuffer` — the
 * Timer Entry keypad types into this module, not into the app, and only the
 * finished string is ever posted.
 */
export class ModuleState {
	snapshot: ControlAPIState | null = null
	isSocketConnected = false
	lastMessage: InterTeamMessage | null = null
	/**
	 * What the Timer Entry keypad has typed so far — the Companion-side twin of
	 * `TimeEntryPopoverModifier.editBuffer`. It lives here rather than on a
	 * surface so every key, the screen readout, and the feedbacks all read the
	 * same buffer no matter which page or which surface the keys are spread over.
	 */
	timerEntryBuffer = ''
	/** Highest `rev` seen; `null` until the app sends one (older apps never do). */
	rev: number | null = null
	/** The app's launch `epoch` (sync protocol v2.1); `null` until one arrives. */
	epoch: number | null = null
	/**
	 * Called when a packet carries a different `epoch` than the one held (the
	 * app restarted), after the anchor, rev gate and clock samples were dropped.
	 * `needsState` is true when the packet was not itself a full snapshot.
	 */
	onEpochChange?: (needsState: boolean) => void
	/** The last failed action's message and when it failed (this state's clock). */
	private actionError: { message: string; at: number } | null = null
	/** When each rate-limited action last went through. */
	private lastPressAt = new Map<string, number>()
	/** App clock minus this machine's clock, from the last stamped snapshot. */
	serverOffsetMs = 0
	lastFrameAt: number | null = null
	/** Zero-based page of the Rundown rows. */
	rundownPage = 0

	/** Negotiated sync protocol: 2 once the app acknowledged `proto`, 1 (legacy, 1 Hz timer pushes) otherwise. */
	protoVersion: 1 | 2 = 1
	readonly sync: ClockSync

	constructor(readonly clock: () => number = monotonicEpochNow) {
		this.sync = new ClockSync(clock)
	}

	/** Records the negotiated protocol; dropping back to legacy also forgets the measured clock offset. */
	setProtoVersion(version: 1 | 2): void {
		this.protoVersion = version
		if (version === 1) this.sync.reset()
	}

	/** Drops the revision guard — for a `hello`/prime read, since a restarted app counts from the start again. */
	resetRev(): void {
		this.rev = null
	}

	/** Back to the just-constructed state, for a new host or a torn-down connection. The Timer Entry buffer is the operator's, not the app's, and stays. */
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

	/**
	 * Notes the app's `epoch`. The first one is just remembered; a different
	 * one means the app restarted, so the held anchor, rev gate and clock
	 * samples describe a process that no longer exists and are dropped. Returns
	 * whether it changed. `needsState` tells the listener whether the packet
	 * that brought the news carries a full snapshot itself.
	 */
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

	/**
	 * The gate: a packet is taken only when its `rev` is strictly greater than
	 * the one held (`catchUp` also takes an equal one), and only when it does
	 * not leap past it by more than `MAX_REV_JUMP` — unless the epoch changed or
	 * this is a hello/catch-up, which rebase it. A packet without a `rev` is
	 * always taken.
	 */
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

	/** Returns `false` (and keeps the held snapshot) when `state` is not newer than what's held. A snapshot without a `rev` is always accepted. */
	applyState(state: ControlAPIState, options: ApplyOptions = {}): boolean {
		const epochChanged = this.observeEpoch(state.epoch, false)
		if (options.hello) this.rev = null
		if (!this.acceptRev(state.rev, state.serverNowMs, epochChanged, options)) return false
		this.snapshot = state.timer?.anchor ? { ...state, timer: withSaneAnchor(state.timer) } : state
		return true
	}

	/** Merges the slim `timer` event into the held snapshot. Ignored when not newer, or when there's no snapshot yet to merge into. */
	applyTimer(event: TimerSnapshot): boolean {
		const epochChanged = this.observeEpoch(event.epoch, true)
		if (!this.snapshot) return false
		if (!this.acceptRev(event.rev, event.serverNowMs, epochChanged, {})) return false
		this.snapshot = { ...this.snapshot, timer: withSaneAnchor(event.timer) }
		return true
	}

	/** The app's idea of "now": the measured sync offset when there is one, else the one its last stamped snapshot implied. */
	get nowMs(): number {
		return this.sync.hasOffset ? this.sync.producerNowMs() : this.clock() + this.serverOffsetMs
	}

	/** Same as `nowMs`, named for the protocol's term. */
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

	/**
	 * Records the message and, when a snapshot is held, adds it to the front of
	 * `snapshot.messages` (newest first, de-duplicated by id). The app sends the
	 * `message` event before the `state` event that carries the updated thread,
	 * so without this a digest arriving in between would see a messages hash that
	 * differs from the app's and trigger a needless full fetch.
	 */
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

	// MARK: - Action feedback

	/** Remembers a failed press; `currentActionError` shows it for `ACTION_ERROR_HOLD_MS`. */
	noteActionError(message: string): void {
		this.actionError = { message, at: this.clock() }
	}

	/** The last failed action's message, or '' once it is older than `ACTION_ERROR_HOLD_MS`. */
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

	/**
	 * Rate limit for a rapid-fire action: `true` (ignore this press) when the
	 * previous accepted press of `key` was less than `windowMs` ago. A window of
	 * 0 never ignores. An ignored press does not restart the window.
	 */
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

	// MARK: - Timer (anchor-driven on v2)

	/** The anchor to run locally: only on a v2 link, only when the app sent one. Legacy links use the pushed values. */
	get timerAnchor(): TimerAnchor | null {
		if (this.protoVersion !== 2) return null
		return this.snapshot?.timer?.anchor ?? null
	}

	/** Remaining seconds of the live item (negative in overtime). Computed from the anchor on v2, the pushed `remainingSeconds` otherwise. `null` without a live timer. */
	get timerRemainingSeconds(): number | null {
		const timer = this.timer
		if (!timer) return null
		const anchor = this.timerAnchor
		return anchor ? anchorRemainingSeconds(anchor, this.nowMs) : timer.remainingSeconds
	}

	/** Whole seconds elapsed on the live item. */
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

	/** The countdown as the app writes it. Formatted here on v2 (the same `TimeFormatting` port the preview uses), the pushed string otherwise. */
	get timerFormattedRemaining(): string {
		const timer = this.timer
		if (!timer) return ''
		const remaining = this.timerRemainingSeconds
		return this.timerAnchor && remaining !== null ? this.formatSeconds(remaining) : timer.formattedRemaining
	}

	/** Length of the live item in whole seconds (the anchor's on v2, the item's otherwise); 0 without a live timer. */
	get timerLengthSeconds(): number {
		const timer = this.timer
		if (!timer) return 0
		return this.timerAnchor?.lengthInSeconds ?? timer.item?.lengthInSeconds ?? 0
	}

	/** `m:ss` elapsed on the live item. */
	get activeItemElapsedText(): string {
		return this.timer ? formatMinutesSeconds(this.timerElapsedSeconds) : ''
	}

	/** `m:ss` length of the live item. */
	get activeItemLengthText(): string {
		return this.timer ? formatMinutesSeconds(this.timerLengthSeconds) : ''
	}

	/** `+m:ss` while the live item is over its time, else ''. */
	get activeItemOvertimeText(): string {
		if (!this.timerIsOvertime) return ''
		const remaining = this.timerRemainingSeconds
		return remaining === null ? '' : `+${formatMinutesSeconds(-remaining)}`
	}

	/** Epoch ms (app clock) the running live item reaches zero, or `null` when nothing is counting or it is already over. */
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

	/** Local `HH:MM:SS` the running live item ends at, or ''. */
	get itemEndsAtText(): string {
		const end = this.itemEndsAtMs
		if (end === null) return ''
		const date = new Date(end)
		const pad = (n: number) => String(n).padStart(2, '0')
		return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
	}

	/** `v2 ±<rtt/2> ms` once clock sync has a sample, `v2` before that, `legacy` on an app without sync protocol v2. */
	get syncQualityText(): string {
		if (this.protoVersion !== 2) return 'legacy'
		const rtt = this.sync.rttMs
		return rtt === null ? 'v2' : `v2 ±${Math.round(rtt / 2)} ms`
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

	/** The item immediately after the currently active one, or `undefined` if there's no plan, no active item, or the active item is last. */
	nextPlanItem(): PCOTimerItem | undefined {
		const plan = this.plan
		if (!plan) return undefined
		return plan.items[plan.activeItemIndex + 1]
	}

	roleSlugs(): Map<string, string> {
		return uniqueRoleSlugs(this.roles)
	}

	// MARK: - Waypoints

	get waypoints(): WaypointStatus[] {
		return this.snapshot?.waypoints ?? []
	}

	/** Resolves a waypoint by id or slug — the same two forms the API's own routes accept, so a button authored either way looks up the same here. */
	waypointByRef(ref: string): WaypointStatus | undefined {
		return this.waypoints.find((w) => w.id === ref || w.slug === ref)
	}

	/**
	 * Whether a waypoint currently points at an item in the loaded plan.
	 * `false` covers both "no such waypoint" and "exists but unassigned" — the
	 * two cases that make `POST /waypoints/{ref}/go` answer 404 and 409
	 * respectively, and the two a button should look dead for.
	 */
	isWaypointAssigned(ref: string): boolean {
		const waypoint = this.waypointByRef(ref)
		return waypoint?.itemId != null
	}

	/** Slugs, not ids, as the choice value: a preset authored against `sermon` keeps working across installs, where a UUID wouldn't. */
	waypointChoices(): { id: string; label: string }[] {
		return this.waypoints.map((w) => ({ id: w.slug, label: w.name }))
	}

	// MARK: - Service schedules

	get schedules(): ScheduleStatus | null {
		return this.snapshot?.schedules ?? null
	}

	get scheduleEntries(): ScheduleEntry[] {
		return this.schedules?.entries ?? []
	}

	/** The next enabled schedule still ahead of now, as the app itself worked it out — never recomputed here, so the button and the app can't disagree about which service is next. */
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

	// MARK: - Notifications

	/**
	 * Whether a message is still standing as a lower third on the pagers.
	 * Mirrors `CueEngine.activeNotification(forRoleId:)` with no role filter:
	 * the newest message counts unless the producer has dismissed since it
	 * arrived. Recomputed from the snapshot rather than tracked separately so a
	 * dismissal fired from the app itself lands here too.
	 */
	get hasStandingNotification(): boolean {
		const newest = this.snapshot?.messages[0]
		if (!newest) return false
		const clearedAt = this.snapshot?.notificationsClearedAt
		if (!clearedAt) return true
		return new Date(newest.timestamp).getTime() > new Date(clearedAt).getTime()
	}

	// MARK: - Timer entry keypad

	/** A digit, `h`/`m`/`s`, or `:` — the keys that just append. */
	appendTimerEntry(text: string): void {
		this.timerEntryBuffer += text
	}

	/** `+`/`−`: the same sign again removes it, the other replaces it. */
	setTimerEntrySign(sign: TimerEntrySign): void {
		this.timerEntryBuffer = withSign(this.timerEntryBuffer, sign)
	}

	/** The physical keyboard's Delete, which the popover also honours — no on-screen key in the app's grid does this. */
	backspaceTimerEntry(): void {
		this.timerEntryBuffer = this.timerEntryBuffer.slice(0, -1)
	}

	clearTimerEntry(): void {
		this.timerEntryBuffer = ''
	}

	/** What the buffer currently means, or `null` while it's empty or not (yet) a time. */
	get timerEntryAction(): TimerInputAction | null {
		return parseTimerInput(this.timerEntryBuffer)
	}

	/** The leading `+`/`-`, if the entry is a relative adjustment. */
	get timerEntrySign(): TimerEntrySign | null {
		return signOf(this.timerEntryBuffer)
	}

	/**
	 * The preview line: what the active item's remaining time would read as if
	 * the buffer were committed right now, in the app's own format. Computed from
	 * the countdown (anchor-driven on a v2 link, the last pushed value otherwise); blank
	 * whenever there's nothing to preview (including a relative entry with no
	 * active timer).
	 */
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

	// MARK: - Timing projections

	formatSeconds(seconds: number): string {
		return formatDuration(seconds, this.settings?.hourFormatThreshold ?? DEFAULT_HOUR_FORMAT_THRESHOLD)
	}

	/** Seconds from now until the plan ends: what's left on the live item (overtime counts as 0) plus every item after it. `null` without a live timer. */
	get serviceRemainingSeconds(): number | null {
		const timer = this.timer
		const plan = this.plan
		if (!timer || !plan) return null
		const after = plan.items.slice(plan.activeItemIndex + 1).reduce((sum, item) => sum + item.lengthInSeconds, 0)
		return Math.max(0, this.timerRemainingSeconds ?? 0) + after
	}

	/** Epoch ms the plan is projected to end, on the app's clock. */
	get projectedEndMs(): number | null {
		const remaining = this.serviceRemainingSeconds
		if (remaining === null) return null
		const anchor = this.timerAnchor
		if (anchor) {
			// Sub-second exact, so the projection holds still between ticks instead of shrinking by the fraction already elapsed.
			const now = this.nowMs
			const liveMs = Math.max(0, anchor.lengthInSeconds * 1000 - anchorElapsedMs(anchor, now))
			return now + liveMs + (remaining - Math.max(0, this.timerRemainingSeconds ?? 0)) * 1000
		}
		return this.nowMs + remaining * 1000
	}

	/** `HH:MM` in this machine's local time. */
	get projectedEndText(): string {
		const end = this.projectedEndMs
		if (end === null) return ''
		const date = new Date(end)
		return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
	}

	/** Signed projected end minus (next schedule's start + the plan's total length): `+` is running over. Blank without a schedule or a live timer. */
	get serviceOverUnderText(): string {
		const end = this.projectedEndMs
		const schedule = this.nextSchedule
		const plan = this.plan
		if (end === null || !schedule || !plan) return ''
		const startsAt = new Date(schedule.startsAt).getTime()
		if (Number.isNaN(startsAt)) return ''
		const planned = plan.items.reduce((sum, item) => sum + item.lengthInSeconds, 0)
		const delta = Math.round((end - (startsAt + planned * 1000)) / 1000)
		return `${delta < 0 ? '-' : '+'}${this.formatSeconds(Math.abs(delta))}`
	}

	/** Elapsed over length for the live item, as an integer 0-100. */
	get activeItemProgressPct(): number {
		const item = this.timer?.item
		if (!item || !(item.lengthInSeconds > 0)) return 0
		return Math.max(0, Math.min(100, Math.round((this.timerElapsedSeconds / item.lengthInSeconds) * 100)))
	}

	// MARK: - Rundown paging

	get rundownPageCount(): number {
		return Math.max(1, Math.ceil((this.plan?.items.length ?? 0) / RUNDOWN_ROWS))
	}

	/** The held page, clamped — the plan can shrink under it mid-service. */
	get rundownPageIndex(): number {
		return Math.max(0, Math.min(this.rundownPage, this.rundownPageCount - 1))
	}

	pageRundown(delta: number): void {
		this.rundownPage = Math.max(0, Math.min(this.rundownPageIndex + delta, this.rundownPageCount - 1))
	}

	/** Item shown on row `row` (1-based) of the current page. */
	rundownRow(row: number): PCOTimerItem | undefined {
		return this.plan?.items[this.rundownPageIndex * RUNDOWN_ROWS + row - 1]
	}

	isRundownRowActive(row: number): boolean {
		const plan = this.plan
		if (!plan) return false
		return this.rundownPageIndex * RUNDOWN_ROWS + row - 1 === plan.activeItemIndex && !!this.rundownRow(row)
	}

	// MARK: - Definition signature

	/** Everything the action/feedback/variable/preset *definitions* are built from — when this string is unchanged, rebuilding them would change nothing. */
	dynamicSignature(): string {
		return JSON.stringify([
			this.roles.map((r) => [r.id, r.name]),
			(this.plan?.items ?? []).map((i) => [i.id, i.title, i.lengthInSeconds]),
			this.waypoints.map((w) => [w.id, w.slug, w.name]),
			this.scheduleEntries.map((e) => [e.id, e.title]),
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
