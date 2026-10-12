import type { CompanionStaticUpgradeScript } from '@companion-module/base'
import type { ModuleConfig } from './config.js'

/** Actions that carry the "Start the timer on arrival" checkbox and send `{ startTimer }` to the app. */
export const START_TIMER_ACTIONS = ['planNext', 'planPrevious', 'waypointNext']

/**
 * Buttons saved before the checkbox existed carry no `startTimer` option.
 * Until commit e7c6c5c an absent value sent nothing and the app's default
 * (start the clock) applied; since then a missing value would have sent
 * `{ startTimer: false }` and held the clock. This writes the old behaviour
 * into those saved buttons explicitly. A button that already has a value,
 * ticked or not, is the operator's choice and is left alone.
 */
export const startTimerDefaultUpgrade: CompanionStaticUpgradeScript<ModuleConfig> = (_context, props) => {
	const updatedActions = props.actions.filter(
		(action) =>
			START_TIMER_ACTIONS.includes(action.actionId) &&
			(action.options.startTimer === undefined || action.options.startTimer === null),
	)
	for (const action of updatedActions) action.options.startTimer = true
	return { updatedConfig: null, updatedSecrets: null, updatedActions, updatedFeedbacks: [] }
}

/** Run in order; never reorder or remove an entry (Companion tracks how many have been applied). */
export const upgradeScripts: CompanionStaticUpgradeScript<ModuleConfig>[] = [startTimerDefaultUpgrade]
