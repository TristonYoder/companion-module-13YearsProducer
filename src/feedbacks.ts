import { combineRgb, type CompanionFeedbackDefinitions } from '@companion-module/base'
import type { ModuleState } from './state.js'
import { progressBarPng } from './progress.js'
import { RUNDOWN_ROWS } from './state.js'
import { optString, CUE_STATES, CUE_STATE_COLOR, CUE_STATE_TEXT_COLOR, CUE_STATE_LABELS } from './types.js'

export function getFeedbackDefinitions(state: ModuleState): CompanionFeedbackDefinitions {
	const roleChoices = state.roleChoices()
	const roleDefault = roleChoices[0]?.id ?? ''
	const waypointChoices = state.waypointChoices()
	const waypointDefault = waypointChoices[0]?.id ?? ''
	const scheduleChoices = state.scheduleChoices()
	const planItemChoices = state.planItemChoices()
	const stateChoices = CUE_STATES.map((s) => ({ id: s, label: CUE_STATE_LABELS[s] }))

	return {
		roleCueColor: {
			type: 'advanced',
			name: 'Role Cue Color',
			options: [
				{
					type: 'dropdown',
					id: 'roleId',
					label: 'Role',
					choices: roleChoices,
					allowCustom: true,
					default: roleDefault,
				},
			],
			callback: (feedback) => {
				const roleId = optString(feedback.options.roleId)
				const role = state.roleById(roleId)
				if (!role) return {}
				return {
					bgcolor: combineRgb(...CUE_STATE_COLOR[role.state]),
					color: combineRgb(...CUE_STATE_TEXT_COLOR[role.state]),
				}
			},
		},

		roleCueIs: {
			type: 'boolean',
			name: 'Role Cue Is',
			options: [
				{
					type: 'dropdown',
					id: 'roleId',
					label: 'Role',
					choices: roleChoices,
					allowCustom: true,
					default: roleDefault,
				},
				{
					type: 'dropdown',
					id: 'state',
					label: 'State',
					choices: stateChoices,
					default: 'GO',
				},
			],
			defaultStyle: {
				bgcolor: combineRgb(...CUE_STATE_COLOR.GO),
				color: combineRgb(...CUE_STATE_TEXT_COLOR.GO),
			},
			callback: (feedback) => {
				const roleId = optString(feedback.options.roleId)
				const targetState = optString(feedback.options.state)
				return state.roleById(roleId)?.state === targetState
			},
		},

		timerRunning: {
			type: 'boolean',
			name: 'Timer Running',
			options: [],
			defaultStyle: {
				bgcolor: combineRgb(38, 199, 89),
				color: combineRgb(255, 255, 255),
			},
			callback: () => {
				return state.timer?.isRunning === true
			},
		},

		timerOvertime: {
			type: 'boolean',
			name: 'Timer Overtime',
			options: [],
			defaultStyle: {
				bgcolor: combineRgb(204, 0, 0),
				color: combineRgb(255, 255, 255),
			},
			callback: () => {
				return state.timer?.isOvertime === true
			},
		},

		timerUnderThreshold: {
			type: 'boolean',
			name: 'Timer Under Threshold',
			options: [
				{
					type: 'number',
					id: 'thresholdSeconds',
					label: 'Threshold (seconds)',
					default: 30,
					min: 0,
					max: 3600,
				},
			],
			defaultStyle: {
				bgcolor: combineRgb(204, 0, 0),
				color: combineRgb(255, 255, 255),
			},
			callback: (feedback) => {
				if (!state.timer) return false
				const threshold = Number(feedback.options.thresholdSeconds)
				return state.timer.remainingSeconds <= threshold
			},
		},

		connectionLost: {
			type: 'boolean',
			name: 'Connection Lost',
			options: [],
			defaultStyle: {
				bgcolor: combineRgb(204, 0, 0),
				color: combineRgb(255, 255, 255),
			},
			callback: () => {
				return state.isSocketConnected === false
			},
		},

		connectionStale: {
			type: 'boolean',
			name: 'Connection Stale (connected, but no data lately)',
			options: [],
			defaultStyle: {
				bgcolor: combineRgb(245, 184, 38),
				color: combineRgb(26, 26, 26),
			},
			callback: () => {
				return state.isStale
			},
		},

		planItemIsActive: {
			type: 'boolean',
			name: 'Rundown Row Is The Live Item',
			options: [
				{
					type: 'number',
					id: 'rowIndex',
					label: 'Row (1-8 on the current rundown page)',
					default: 1,
					min: 1,
					max: RUNDOWN_ROWS,
				},
			],
			defaultStyle: {
				bgcolor: combineRgb(38, 199, 89),
				color: combineRgb(255, 255, 255),
			},
			callback: (feedback) => {
				return state.isRundownRowActive(Number(feedback.options.rowIndex))
			},
		},

		activeItemProgressBar: {
			type: 'advanced',
			name: 'Live Item Progress Bar',
			options: [],
			callback: () => {
				return { png64: progressBarPng(state.activeItemProgressPct), pngalignment: 'center:center' }
			},
		},

		atEndOfPlan: {
			type: 'boolean',
			name: 'At End Of Plan',
			options: [],
			defaultStyle: {
				bgcolor: combineRgb(245, 184, 38),
				color: combineRgb(26, 26, 26),
			},
			callback: () => {
				return state.plan?.isAtEndOfPlan === true
			},
		},

		// MARK: - Timer entry keypad

		// Enter: lit once what's typed actually parses to something the app can
		// act on, dim (the preset's own base style) while the buffer is empty or
		// still half-typed — the Companion equivalent of the popover's preview
		// line filling in.
		timerEntryCommittable: {
			type: 'boolean',
			name: 'Timer Entry Is Committable',
			options: [],
			defaultStyle: {
				bgcolor: combineRgb(38, 199, 89),
				color: combineRgb(255, 255, 255),
			},
			callback: () => {
				return state.timerEntryAction !== null
			},
		},

		// The active sign key, so a relative entry is visible at a glance on the
		// pad the way a leading "+"/"−" is on the popover's screen.
		timerEntrySignIs: {
			type: 'boolean',
			name: 'Timer Entry Sign Is',
			options: [
				{
					type: 'dropdown',
					id: 'sign',
					label: 'Sign',
					choices: [
						{ id: '+', label: '+ (add to remaining)' },
						{ id: '-', label: '− (subtract from remaining)' },
					],
					default: '+',
				},
			],
			defaultStyle: {
				bgcolor: combineRgb(74, 144, 226),
				color: combineRgb(255, 255, 255),
			},
			callback: (feedback) => {
				return state.timerEntrySign === optString(feedback.options.sign)
			},
		},

		// "There's something typed" — for C and Backspace, which are otherwise
		// indistinguishable from dead keys until you notice the screen.
		timerEntryInProgress: {
			type: 'boolean',
			name: 'Timer Entry In Progress',
			options: [],
			defaultStyle: {
				bgcolor: combineRgb(245, 184, 38),
				color: combineRgb(26, 26, 26),
			},
			callback: () => {
				return state.timerEntryBuffer.length > 0
			},
		},

		pcoConnected: {
			type: 'boolean',
			name: 'Planning Center Connected',
			options: [],
			defaultStyle: {
				bgcolor: combineRgb(38, 199, 89),
				color: combineRgb(255, 255, 255),
			},
			callback: () => {
				return state.pco?.isConnected === true
			},
		},

		// MARK: - Waypoints

		waypointAssigned: {
			type: 'boolean',
			name: 'Waypoint Is Assigned',
			description:
				'True while this waypoint points at an item in the plan currently loaded. Put it on a Go To Waypoint button so an unassigned waypoint reads as dead before anyone presses it — pressing one answers 409 and does nothing.',
			options: [
				{
					type: 'dropdown',
					id: 'waypoint',
					label: 'Waypoint',
					choices: waypointChoices,
					allowCustom: true,
					default: waypointDefault,
				},
			],
			defaultStyle: {
				bgcolor: combineRgb(74, 144, 226),
				color: combineRgb(255, 255, 255),
			},
			callback: (feedback) => {
				return state.isWaypointAssigned(optString(feedback.options.waypoint))
			},
		},

		waypointIsActive: {
			type: 'boolean',
			name: 'Waypoint Is The Live Item',
			description:
				'True when the item this waypoint points at is the one currently running — a "you are here" light for a waypoint page.',
			options: [
				{
					type: 'dropdown',
					id: 'waypoint',
					label: 'Waypoint',
					choices: waypointChoices,
					allowCustom: true,
					default: waypointDefault,
				},
			],
			defaultStyle: {
				bgcolor: combineRgb(38, 199, 89),
				color: combineRgb(255, 255, 255),
			},
			callback: (feedback) => {
				const waypoint = state.waypointByRef(optString(feedback.options.waypoint))
				if (!waypoint?.itemId) return false
				return state.timer?.item.id === waypoint.itemId
			},
		},

		// MARK: - Projected / Actual

		timerIsActual: {
			type: 'boolean',
			name: 'Live Item Is Actual (not Projected)',
			description:
				"True when the live item is showing as Actual \u2014 reads the displayed value, so it follows the transient override as well as the plan item's own flag.",
			options: [],
			defaultStyle: {
				bgcolor: combineRgb(126, 87, 194),
				color: combineRgb(255, 255, 255),
			},
			callback: () => {
				return state.timer?.isDurationActualForDisplay === true
			},
		},

		planItemIsActual: {
			type: 'boolean',
			name: 'Plan Item Is Actual (not Projected)',
			description: "A specific item's own persisted flag, ignoring any live override.",
			options: [
				{
					type: 'dropdown',
					id: 'itemId',
					label: 'Plan Item (blank = the live item)',
					choices: planItemChoices,
					allowCustom: true,
					default: planItemChoices[0]?.id ?? '',
				},
			],
			defaultStyle: {
				bgcolor: combineRgb(126, 87, 194),
				color: combineRgb(255, 255, 255),
			},
			callback: (feedback) => {
				const requested = optString(feedback.options.itemId)
				const itemId = requested || state.timer?.item.id
				if (!itemId) return false
				return state.plan?.items.find((i) => i.id === itemId)?.isDurationActual === true
			},
		},

		// MARK: - Notifications

		notificationStanding: {
			type: 'boolean',
			name: 'Notification Is Standing',
			description:
				'True while a message is still showing as a lower third on the pagers — i.e. while the Dismiss button would do something.',
			options: [],
			defaultStyle: {
				bgcolor: combineRgb(245, 184, 38),
				color: combineRgb(26, 26, 26),
			},
			callback: () => {
				return state.hasStandingNotification
			},
		},

		// MARK: - Service schedules

		scheduleEnabled: {
			type: 'boolean',
			name: 'Schedule Is Enabled',
			options: [
				{
					type: 'dropdown',
					id: 'scheduleId',
					label: 'Schedule',
					choices: scheduleChoices,
					allowCustom: true,
					default: scheduleChoices[0]?.id ?? '',
				},
			],
			defaultStyle: {
				bgcolor: combineRgb(38, 199, 89),
				color: combineRgb(255, 255, 255),
			},
			callback: (feedback) => {
				return state.scheduleById(optString(feedback.options.scheduleId))?.isEnabled === true
			},
		},

		scheduleIsNext: {
			type: 'boolean',
			name: 'Schedule Is Next Up',
			options: [
				{
					type: 'dropdown',
					id: 'scheduleId',
					label: 'Schedule',
					choices: scheduleChoices,
					allowCustom: true,
					default: scheduleChoices[0]?.id ?? '',
				},
			],
			defaultStyle: {
				bgcolor: combineRgb(74, 144, 226),
				color: combineRgb(255, 255, 255),
			},
			callback: (feedback) => {
				return state.schedules?.nextId === optString(feedback.options.scheduleId)
			},
		},

		hasUpcomingSchedule: {
			type: 'boolean',
			name: 'A Schedule Is Upcoming',
			description:
				'True when the app has any enabled schedule still ahead of now — pair it with the Next Schedule status button.',
			options: [],
			defaultStyle: {
				bgcolor: combineRgb(74, 144, 226),
				color: combineRgb(255, 255, 255),
			},
			callback: () => {
				return state.nextSchedule !== undefined
			},
		},

		// MARK: - Cloud

		plotipharPaired: {
			type: 'boolean',
			name: 'Plotiphar Paired',
			options: [],
			defaultStyle: {
				bgcolor: combineRgb(38, 199, 89),
				color: combineRgb(255, 255, 255),
			},
			callback: () => {
				return state.plotiphar?.pairingState === 'approved'
			},
		},

		relayEnabled: {
			type: 'boolean',
			name: 'Cloud Relay Enabled',
			options: [],
			defaultStyle: {
				bgcolor: combineRgb(38, 199, 89),
				color: combineRgb(255, 255, 255),
			},
			callback: () => {
				return state.network?.relayEnabled === true
			},
		},
	}
}
