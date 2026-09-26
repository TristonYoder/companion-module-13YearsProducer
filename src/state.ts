import { parseTimerInput, previewText, signOf, withSign } from './timerEntry'
import type { TimerEntrySign, TimerInputAction } from './timerEntry'
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
	SettingsStatus,
} from './types'

/** What the app's own time-entry popover previews against when the socket hasn't said otherwise (`timeEntryPopover`'s default `hourFormatThreshold`). */
const DEFAULT_HOUR_FORMAT_THRESHOLD = 'over90Minutes'

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

	applyState(state: ControlAPIState): void {
		this.snapshot = state
	}

	applyMessage(message: InterTeamMessage): void {
		this.lastMessage = message
	}

	setSocketConnected(connected: boolean): void {
		this.isSocketConnected = connected
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
	 * the buffer were committed right now, in the app's own format. Read against
	 * the live countdown, so a relative entry's preview keeps up with a running
	 * timer between pushes; empty whenever there's nothing to preview.
	 */
	get timerEntryPreview(): string {
		const threshold = this.settings?.hourFormatThreshold ?? DEFAULT_HOUR_FORMAT_THRESHOLD
		return previewText(this.timerEntryBuffer, this.timer?.remainingSeconds ?? 0, threshold)
	}
}
