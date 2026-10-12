import type { CompanionStaticUpgradeScript } from '@companion-module/base'
import type { ModuleConfig } from './config.js'

export const START_TIMER_ACTIONS = ['planNext', 'planPrevious', 'waypointNext']

export const startTimerDefaultUpgrade: CompanionStaticUpgradeScript<ModuleConfig> = (_context, props) => {
	const updatedActions = props.actions.filter(
		(action) =>
			START_TIMER_ACTIONS.includes(action.actionId) &&
			(action.options.startTimer === undefined || action.options.startTimer === null),
	)
	for (const action of updatedActions) action.options.startTimer = true
	return { updatedConfig: null, updatedSecrets: null, updatedActions, updatedFeedbacks: [] }
}

export const LENGTH_TEXT_ACTIONS = ['planAddItem', 'planUpdateItem']

export const lengthTextUpgrade: CompanionStaticUpgradeScript<ModuleConfig> = (_context, props) => {
	const updatedActions = props.actions.filter(
		(action) => LENGTH_TEXT_ACTIONS.includes(action.actionId) && typeof action.options.lengthInSeconds === 'number',
	)
	for (const action of updatedActions) {
		const seconds = action.options.lengthInSeconds as number
		action.options.lengthInSeconds = seconds > 0 ? String(seconds) : ''
	}
	return { updatedConfig: null, updatedSecrets: null, updatedActions, updatedFeedbacks: [] }
}

export const upgradeScripts: CompanionStaticUpgradeScript<ModuleConfig>[] = [
	startTimerDefaultUpgrade,
	lengthTextUpgrade,
]
