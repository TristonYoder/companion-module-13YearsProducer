import { combineRgb, type CompanionFeedbackDefinitions } from '@companion-module/base'
import type { ModuleState } from './state'
import { CUE_STATES, CUE_STATE_COLOR, CUE_STATE_TEXT_COLOR, CUE_STATE_LABELS } from './types'

export function getFeedbackDefinitions(state: ModuleState): CompanionFeedbackDefinitions {
	const roleChoices = state.roleChoices()
	const roleDefault = roleChoices[0]?.id ?? ''
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
				const roleId = String(feedback.options.roleId)
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
				const roleId = String(feedback.options.roleId)
				const targetState = String(feedback.options.state)
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
				return state.timerEntrySign === String(feedback.options.sign)
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
	}
}
