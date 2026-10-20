import { combineRgb } from '@companion-module/base'
import type { CompanionPresetDefinitions, CompanionButtonStyleProps } from '@companion-module/base'
import {
	companionDisabledText,
	companionInfo,
	companionNeutral,
	companionRemote,
	cueDarkText,
	cueGo,
	cueLightText,
	cueOff,
	cueStandby,
	timerOvertime,
} from './palette.js'
import { CUE_STATE_COLOR, CUE_STATE_LABELS, CUE_STATE_TEXT_COLOR, FIRABLE_CUE_STATES } from './types.js'
import { ModuleState, RUNDOWN_ROWS } from './state.js'
import { TIMER_ENTRY_GLYPHS, TIMER_ENTRY_GLYPHS_DARK } from './glyphs.js'
import { ICON_PLATES, ICONS } from './icons.js'

type PresetFeedback = { feedbackId: string; options: Record<string, string | number>; style: Record<string, unknown> }

const GREEN = combineRgb(...cueGo)
const RED = combineRgb(...timerOvertime)
const BLUE = combineRgb(...companionInfo)
const GREY = combineRgb(...companionNeutral)
const WHITE = combineRgb(...cueLightText)
const DARK = combineRgb(...cueOff)
const AMBER = combineRgb(...cueStandby)
const PURPLE = combineRgb(...companionRemote)
const INK_DARK = combineRgb(...cueDarkText)
const DIM_TEXT = combineRgb(...companionDisabledText)

const USE_GLYPH_KEY_FACES = true

function face(spec: {
	icon?: string
	glyph?: string
	label?: string
	color?: number
	textColor?: number
	plate?: boolean
	size?: CompanionButtonStyleProps['size']
}): CompanionButtonStyleProps {
	const artwork = spec.glyph
		? TIMER_ENTRY_GLYPHS[spec.glyph]
		: spec.icon
			? spec.plate === false
				? ICONS[spec.icon]
				: ICON_PLATES[spec.icon]
			: undefined

	return {
		text: spec.label ?? '',
		size: spec.size ?? '14',
		color: spec.textColor ?? WHITE,
		bgcolor: spec.color ?? DARK,
		...(artwork ? { png64: artwork, pngalignment: 'center:center' as const } : {}),
		alignment: 'center:bottom' as const,
	}
}

function bg(color: number) {
	return { bgcolor: color }
}

export interface PresetOptions {
	overtimeRed: boolean
}

function lit(color: number, glyph: string) {
	return { bgcolor: color, color: INK_DARK, png64: TIMER_ENTRY_GLYPHS_DARK[glyph] }
}

function presetKey(id: string): string {
	return id.replace(/[^A-Za-z0-9_-]/g, '_')
}

export function getPresetDefinitions(
	state: ModuleState,
	options: PresetOptions = { overtimeRed: true },
): CompanionPresetDefinitions {
	const presets: CompanionPresetDefinitions = {}
	const overtimeFeedbacks = options.overtimeRed ? [{ feedbackId: 'timerOvertime', options: {}, style: bg(RED) }] : []

	for (const cueState of FIRABLE_CUE_STATES) {
		presets[`cue_${cueState.toLowerCase()}`] = {
			type: 'button',
			category: 'Cues',
			name: `Fire ${CUE_STATE_LABELS[cueState]} (selected roles)`,
			style: face({
				icon: cueState === 'GO' ? 'cueGo' : cueState === 'OFF' ? 'cueClear' : undefined,
				label: CUE_STATE_LABELS[cueState],
				color: combineRgb(...CUE_STATE_COLOR[cueState]),
				textColor: combineRgb(...CUE_STATE_TEXT_COLOR[cueState]),
				plate: false,
			}),
			feedbacks: [],
			steps: [{ down: [{ actionId: 'fireSelectedCue', options: { state: cueState } }], up: [] }],
		}
	}

	presets['cue_clear_all'] = {
		type: 'button',
		category: 'Cues',
		name: 'Clear All Cues',
		style: face({ icon: 'cueClear', label: 'Clear All', color: DARK, plate: false }),
		feedbacks: [],
		steps: [{ down: [{ actionId: 'clearAllCues', options: {} }], up: [] }],
	}

	for (const role of state.roles) {
		const key = presetKey(role.id)
		presets[`role_cycle_${key}`] = {
			type: 'button',
			category: 'Cues — Toggle',
			name: `${role.name} — Cycle (Standby → Go! → Clear)`,
			style: face({
				icon: 'cueGo',
				label: role.name,
				color: combineRgb(...CUE_STATE_COLOR.OFF),
				textColor: combineRgb(...CUE_STATE_TEXT_COLOR.OFF),
				plate: false,
			}),
			feedbacks: [{ feedbackId: 'roleCueColor', options: { roleId: role.id } }],
			steps: [{ down: [{ actionId: 'cycleRoleCue', options: { roleId: role.id } }], up: [] }],
		}
		for (const cueState of ['STANDBY', 'GO', 'OFF'] as const) {
			presets[`role_${cueState.toLowerCase()}_${key}`] = {
				type: 'button',
				category: 'Cues — Per Role',
				name: `${role.name} — ${CUE_STATE_LABELS[cueState]}`,
				style: face({
					icon: cueState === 'GO' ? 'cueGo' : cueState === 'OFF' ? 'cueClear' : undefined,
					label: `${role.name}\\n${CUE_STATE_LABELS[cueState]}`,
					color: DARK,
					plate: false,
				}),
				feedbacks: [
					{
						feedbackId: 'roleCueIs',
						options: { roleId: role.id, state: cueState },
						style: {
							bgcolor: combineRgb(...CUE_STATE_COLOR[cueState]),
							color: combineRgb(...CUE_STATE_TEXT_COLOR[cueState]),
						},
					},
				],
				steps: [{ down: [{ actionId: 'fireRoleCue', options: { roleId: role.id, state: cueState } }], up: [] }],
			}
		}
	}

	const transport: { id: string; name: string; icon: string; label: string; actionId: string; color: number }[] = [
		{
			id: 'timer_start',
			name: 'Start Timer',
			icon: 'timerStart',
			label: 'Start',
			actionId: 'timerStart',
			color: GREEN,
		},
		{
			id: 'timer_pause',
			name: 'Pause Timer',
			icon: 'timerPause',
			label: 'Pause',
			actionId: 'timerPause',
			color: AMBER,
		},
		{
			id: 'timer_toggle',
			name: 'Start/Pause Timer',
			icon: 'timerStart',
			label: 'Start/Pause',
			actionId: 'timerToggle',
			color: BLUE,
		},
		{ id: 'timer_reset', name: 'Reset Timer', icon: 'timerReset', label: 'Reset', actionId: 'timerReset', color: GREY },
	]
	for (const t of transport) {
		presets[t.id] = {
			type: 'button',
			category: 'Timer Transport',
			name: t.name,
			style: face({ icon: t.icon, label: t.label, color: t.color }),
			feedbacks: [
				{
					feedbackId: 'timerRunning',
					options: {},
					style: bg(GREEN),
				},
			],
			steps: [{ down: [{ actionId: t.actionId, options: {} }], up: [] }],
		}
	}

	for (const seconds of [10, 30, 60, 300]) {
		const label = seconds === 300 ? '5m' : seconds === 60 ? '1m' : `${seconds}s`
		presets[`timer_plus_${seconds}`] = {
			type: 'button',
			category: 'Timer Nudges',
			name: `Add ${label}`,
			style: face({ icon: 'timerAdd', label: `+${label}`, color: BLUE }),
			feedbacks: [],
			steps: [{ down: [{ actionId: 'timerAdjust', options: { seconds } }], up: [] }],
		}
		presets[`timer_minus_${seconds}`] = {
			type: 'button',
			category: 'Timer Nudges',
			name: `Subtract ${label}`,
			style: face({ icon: 'timerSubtract', label: `−${label}`, color: BLUE }),
			feedbacks: [],
			steps: [{ down: [{ actionId: 'timerAdjust', options: { seconds: -seconds } }], up: [] }],
		}
	}

	presets['plan_previous'] = {
		type: 'button',
		category: 'Service Navigation',
		name: 'Previous Item',
		style: face({ icon: 'planPrevious', label: 'Prev Item', color: BLUE }),
		feedbacks: [{ feedbackId: 'atStartOfPlan', options: {}, style: bg(GREY) }],
		steps: [{ down: [{ actionId: 'planPrevious', options: {} }], up: [] }],
	}

	presets['plan_next'] = {
		type: 'button',
		category: 'Service Navigation',
		name: 'Next Item',
		style: face({ icon: 'planNext', label: 'Next Item', color: BLUE }),
		feedbacks: [
			{
				feedbackId: 'atEndOfPlan',
				options: {},
				style: bg(GREY),
			},
		],
		steps: [{ down: [{ actionId: 'planNext', options: {} }], up: [] }],
	}

	presets['plan_next_service'] = {
		type: 'button',
		category: 'Service Navigation',
		name: 'Load Next Service',
		style: face({ icon: 'planNextService', label: 'Next Service', color: PURPLE }),
		feedbacks: [],
		steps: [{ down: [{ actionId: 'planNextService', options: {} }], up: [] }],
	}

	presets['active_item_status'] = {
		type: 'button',
		category: 'Service Navigation',
		name: 'Active Item & Time Remaining',
		style: face({
			label: '$(13yearsproducer:active_item_title)\\n$(13yearsproducer:active_item_remaining)',
			color: DARK,
			size: 'auto',
		}),
		feedbacks: [
			...overtimeFeedbacks,
			{ feedbackId: 'timerUnderThreshold', options: { thresholdSeconds: 30 }, style: bg(RED) },
		],
		steps: [{ down: [], up: [] }],
	}

	presets['plan_next_hold'] = {
		type: 'button',
		category: 'Service Navigation',
		name: 'Next Item (Hold Clock)',
		style: face({ icon: 'planNext', label: 'Next (Hold)', color: AMBER }),
		feedbacks: [{ feedbackId: 'atEndOfPlan', options: {}, style: bg(GREY) }],
		steps: [{ down: [{ actionId: 'planNext', options: { startTimer: false } }], up: [] }],
	}

	presets['countdown_stages'] = {
		type: 'button',
		category: 'Service Navigation',
		name: 'Countdown (amber at 60s, red at 30s)',
		style: face({
			label: '$(13yearsproducer:active_item_title)\\n$(13yearsproducer:active_item_remaining)',
			color: DARK,
			size: 'auto',
		}),
		feedbacks: [
			{
				feedbackId: 'timerUnderThreshold',
				options: { thresholdSeconds: 60 },
				style: { bgcolor: AMBER, color: INK_DARK },
			},
			{ feedbackId: 'timerUnderThreshold', options: { thresholdSeconds: 30 }, style: bg(RED) },
			...overtimeFeedbacks,
		],
		steps: [{ down: [], up: [] }],
	}

	const timingStatus: { id: string; name: string; label: string; icon: string }[] = [
		{
			id: 'projected_end',
			name: 'Projected End Time',
			label: 'Ends\\n$(13yearsproducer:projected_end_time)',
			icon: 'timerClock',
		},
		{
			id: 'service_remaining',
			name: 'Service Time Remaining',
			label: 'Left\\n$(13yearsproducer:service_remaining_total)',
			icon: 'stopwatch',
		},
		{
			id: 'service_over_under',
			name: 'Service Over/Under (needs a schedule)',
			label: 'Over/Under\\n$(13yearsproducer:service_over_under)',
			icon: 'schedule',
		},
		{
			id: 'next_item_length',
			name: 'Next Item Length',
			label: 'Next\\n$(13yearsproducer:next_item_length)',
			icon: 'planNext',
		},
	]
	for (const t of timingStatus) {
		presets[`timing_${t.id}`] = {
			type: 'button',
			category: 'Service Timing',
			name: t.name,
			style: face({ icon: t.icon, label: t.label, color: DARK, size: 'auto' }),
			feedbacks: [],
			steps: [{ down: [], up: [] }],
		}
	}

	presets['timing_progress'] = {
		type: 'button',
		category: 'Service Timing',
		name: 'Live Item Progress',
		style: {
			text: '$(13yearsproducer:active_item_progress_pct)%',
			size: '24',
			color: WHITE,
			bgcolor: DARK,
			alignment: 'center:top',
		},
		feedbacks: [{ feedbackId: 'activeItemProgressBar', options: {} }],
		steps: [{ down: [], up: [] }],
	}

	for (let row = 1; row <= RUNDOWN_ROWS; row++) {
		presets[`rundown_row_${row}`] = {
			type: 'button',
			category: 'Rundown',
			name: `Row ${row}`,
			style: face({
				label: `$(13yearsproducer:rundown_row_${row}_title)\\n$(13yearsproducer:rundown_row_${row}_length)`,
				color: DARK,
				size: 'auto',
			}),
			feedbacks: [
				{ feedbackId: 'rundownRowSkipped', options: { rowIndex: row }, style: { color: DIM_TEXT } },
				{ feedbackId: 'planItemIsActive', options: { rowIndex: row }, style: bg(GREEN) },
			],
			steps: [{ down: [{ actionId: 'planJumpToRow', options: { rowIndex: row } }], up: [] }],
		}
	}

	presets['rundown_page_up'] = {
		type: 'button',
		category: 'Rundown',
		name: 'Rundown Page Up',
		style: face({
			icon: 'planPrevious',
			label: 'Page Up\\n$(13yearsproducer:rundown_page)/$(13yearsproducer:rundown_page_count)',
			color: BLUE,
		}),
		feedbacks: [],
		steps: [{ down: [{ actionId: 'rundownPageUp', options: {} }], up: [] }],
	}

	presets['rundown_page_down'] = {
		type: 'button',
		category: 'Rundown',
		name: 'Rundown Page Down',
		style: face({
			icon: 'planNext',
			label: 'Page Down\\n$(13yearsproducer:rundown_page)/$(13yearsproducer:rundown_page_count)',
			color: BLUE,
		}),
		feedbacks: [],
		steps: [{ down: [{ actionId: 'rundownPageDown', options: {} }], up: [] }],
	}

	const entryAppend = (key: string) => [{ actionId: 'timerEntryAppend', options: { key } }]
	const entryKey = (
		id: string,
		pos: string,
		glyph: string,
		label: string,
		actions: { actionId: string; options: Record<string, string> }[],
		feedbacks: PresetFeedback[] = [],
	) => {
		presets[`timer_entry_key_${id}`] = {
			type: 'button',
			category: 'Timer Entry',
			name: `${pos} • ${label}`,
			style: face({
				glyph: USE_GLYPH_KEY_FACES ? glyph : undefined,
				label: USE_GLYPH_KEY_FACES ? '' : label,
				size: '24',
			}),
			feedbacks,
			steps: [{ down: actions, up: [] }],
		}
	}

	presets['timer_entry_screen'] = {
		type: 'button',
		category: 'Timer Entry',
		name: 'R0 • Screen',
		style: {
			text: '$(13yearsproducer:timer_entry_buffer)\\n$(13yearsproducer:timer_entry_preview)',
			size: 'auto',
			color: WHITE,
			bgcolor: DARK,
			alignment: 'center:center',
		},
		feedbacks: [],
		steps: [{ down: [], up: [] }],
	}

	const keyFace = (glyph: string, label: string) =>
		USE_GLYPH_KEY_FACES ? { png64: TIMER_ENTRY_GLYPHS[glyph] } : { text: label }
	const litKey = (color: number, glyph: string, label: string) =>
		USE_GLYPH_KEY_FACES ? lit(color, glyph) : { bgcolor: color, color: INK_DARK, text: label }
	const signFeedback = (sign: '+' | '-', glyph: string, meridiem: 'am' | 'pm'): PresetFeedback[] => [
		{ feedbackId: 'timerEntrySignIs', options: { sign }, style: lit(BLUE, glyph) },
		{ feedbackId: 'timerEntryEndAt', options: {}, style: keyFace(meridiem, meridiem.toUpperCase()) },
		{
			feedbackId: 'timerEntryMeridiemIs',
			options: { meridiem },
			style: litKey(BLUE, meridiem, meridiem.toUpperCase()),
		},
	]
	entryKey(
		'clear',
		'R1C1',
		'clear',
		'C',
		[{ actionId: 'timerEntryClear', options: {} }],
		[{ feedbackId: 'timerEntryInProgress', options: {}, style: lit(AMBER, 'clear') }],
	)
	entryKey('h', 'R1C2', 'h', 'h', entryAppend('h'))
	entryKey('m', 'R1C3', 'm', 'm', entryAppend('m'))
	entryKey('s', 'R1C4', 's', 's', entryAppend('s'))
	entryKey('7', 'R2C1', '7', '7', entryAppend('7'))
	entryKey('8', 'R2C2', '8', '8', entryAppend('8'))
	entryKey('9', 'R2C3', '9', '9', entryAppend('9'))
	entryKey(
		'minus',
		'R2C4',
		'minus',
		'−',
		[
			{ actionId: 'timerEntrySign', options: { sign: '-' } },
			{ actionId: 'timerEntryMeridiem', options: { meridiem: 'am' } },
		],
		signFeedback('-', 'minus', 'am'),
	)
	entryKey('4', 'R3C1', '4', '4', entryAppend('4'))
	entryKey('5', 'R3C2', '5', '5', entryAppend('5'))
	entryKey('6', 'R3C3', '6', '6', entryAppend('6'))
	entryKey(
		'plus',
		'R3C4',
		'plus',
		'+',
		[
			{ actionId: 'timerEntrySign', options: { sign: '+' } },
			{ actionId: 'timerEntryMeridiem', options: { meridiem: 'pm' } },
		],
		signFeedback('+', 'plus', 'pm'),
	)
	entryKey('1', 'R4C1', '1', '1', entryAppend('1'))
	entryKey('2', 'R4C2', '2', '2', entryAppend('2'))
	entryKey('3', 'R4C3', '3', '3', entryAppend('3'))
	entryKey(
		'enter',
		'R4C4',
		'enter',
		'↵',
		[{ actionId: 'timerEntryCommit', options: {} }],
		[{ feedbackId: 'timerEntryCommittable', options: {}, style: lit(GREEN, 'enter') }],
	)
	entryKey('0', 'R5C1', '0', '0', entryAppend('0'))
	entryKey('colon', 'R5C2', 'colon', ':', entryAppend(':'))
	entryKey(
		'backspace',
		'R5C3',
		'backspace',
		'⌫',
		[{ actionId: 'timerEntryBackspace', options: {} }],
		[{ feedbackId: 'timerEntryInProgress', options: {}, style: lit(AMBER, 'backspace') }],
	)
	entryKey(
		'end_at',
		'R5C4',
		'endAt',
		'End @',
		[{ actionId: 'timerEntryEndAt', options: { mode: 'toggle' } }],
		[{ feedbackId: 'timerEntryEndAt', options: {}, style: litKey(BLUE, 'endAt', 'End @') }],
	)

	const firstWaypoint = state.waypointChoices()[0]?.id ?? ''

	presets['waypoint_go'] = {
		type: 'button',
		category: 'Waypoints',
		name: 'Go To Waypoint',
		style: face({ icon: 'waypointGo', label: 'Waypoint', color: PURPLE }),
		feedbacks: [
			{
				feedbackId: 'waypointAssigned',
				options: { waypoint: firstWaypoint },
				style: bg(PURPLE),
				isInverted: true,
			},
			{
				feedbackId: 'waypointIsActive',
				options: { waypoint: firstWaypoint },
				style: bg(GREEN),
			},
		],
		steps: [{ down: [{ actionId: 'waypointGo', options: { waypoint: firstWaypoint, startTimer: true } }], up: [] }],
	}

	presets['waypoint_go_no_timer'] = {
		type: 'button',
		category: 'Waypoints',
		name: 'Go To Waypoint (don’t start the clock)',
		style: face({ icon: 'waypointFlag', label: 'Pre-roll', color: PURPLE }),
		feedbacks: [
			{
				feedbackId: 'waypointAssigned',
				options: { waypoint: firstWaypoint },
				style: bg(GREY),
				isInverted: true,
			},
		],
		steps: [{ down: [{ actionId: 'waypointGo', options: { waypoint: firstWaypoint, startTimer: false } }], up: [] }],
	}

	presets['waypoint_next'] = {
		type: 'button',
		category: 'Waypoints',
		name: 'Go To Next Waypoint',
		style: face({ icon: 'waypointGo', label: 'Next Waypoint', color: PURPLE }),
		feedbacks: [],
		steps: [{ down: [{ actionId: 'waypointNext', options: { startTimer: true } }], up: [] }],
	}

	presets['waypoint_assign_active'] = {
		type: 'button',
		category: 'Waypoints',
		name: 'Assign Waypoint To Live Item',
		style: face({ icon: 'waypointFlag', label: 'Tag Live Item', color: GREY }),
		feedbacks: [],
		steps: [{ down: [{ actionId: 'waypointAssignToActiveItem', options: { waypoint: firstWaypoint } }], up: [] }],
	}

	presets['waypoint_status'] = {
		type: 'button',
		category: 'Waypoints',
		name: 'Waypoints Assigned (status)',
		style: face({
			icon: 'waypointGo',
			label: '$(13yearsproducer:waypoints_assigned_count)/$(13yearsproducer:waypoint_count)',
			color: DARK,
		}),
		feedbacks: [],
		steps: [{ down: [], up: [] }],
	}

	const firstSchedule = state.scheduleChoices()[0]?.id ?? ''

	presets['schedule_go_live_next'] = {
		type: 'button',
		category: 'Service Schedules',
		name: 'Bring Next Schedule Live',
		style: face({ icon: 'scheduleGoLive', label: 'Go Live Now', color: GREEN }),
		feedbacks: [
			{
				feedbackId: 'hasUpcomingSchedule',
				options: {},
				style: bg(GREY),
				isInverted: true,
			},
		],
		steps: [{ down: [{ actionId: 'scheduleGoLiveNext', options: {} }], up: [] }],
	}

	presets['schedule_go_live'] = {
		type: 'button',
		category: 'Service Schedules',
		name: 'Bring A Specific Schedule Live',
		style: face({ icon: 'schedule', label: 'Go Live', color: GREEN }),
		feedbacks: [
			{
				feedbackId: 'scheduleEnabled',
				options: { scheduleId: firstSchedule },
				style: bg(GREY),
				isInverted: true,
			},
		],
		steps: [{ down: [{ actionId: 'scheduleGoLive', options: { scheduleId: firstSchedule } }], up: [] }],
	}

	presets['next_schedule_status'] = {
		type: 'button',
		category: 'Service Schedules',
		name: 'Next Service (status)',
		style: face({ icon: 'schedule', label: '$(13yearsproducer:next_schedule_title)', color: DARK, size: 'auto' }),
		feedbacks: [{ feedbackId: 'hasUpcomingSchedule', options: {}, style: bg(BLUE) }],
		steps: [{ down: [], up: [] }],
	}

	presets['event_time_next'] = {
		type: 'button',
		category: 'Event Times',
		name: 'Next Event Time',
		style: face({ icon: 'planNextService', label: 'Next Event', color: GREY }),
		feedbacks: [{ feedbackId: 'hasNextEventTime', options: {}, style: bg(BLUE) }],
		steps: [{ down: [{ actionId: 'eventTimeNext', options: {} }], up: [] }],
	}

	presets['event_time_status'] = {
		type: 'button',
		category: 'Event Times',
		name: 'Live Event Time (status)',
		style: face({ icon: 'schedule', label: '$(13yearsproducer:event_time_live)', color: DARK, size: 'auto' }),
		feedbacks: [],
		steps: [{ down: [], up: [] }],
	}

	presets['run_sheet_skip_next'] = {
		type: 'button',
		category: 'Run Sheet',
		name: 'Skip Next Item',
		style: face({ icon: 'skip', label: 'Skip\\n$(13yearsproducer:next_item_title)', color: GREY, size: 'auto' }),
		feedbacks: [],
		steps: [{ down: [{ actionId: 'planSkipItem', options: { target: 'next', itemId: '', mode: 'skip' } }], up: [] }],
	}

	presets['run_sheet_skip_live'] = {
		type: 'button',
		category: 'Run Sheet',
		name: 'Skip / Unskip Live Item',
		style: face({ icon: 'skip', label: 'Skip Live', color: GREY }),
		feedbacks: [{ feedbackId: 'planItemSkipped', options: { itemId: '' }, style: { bgcolor: DARK, color: DIM_TEXT } }],
		steps: [{ down: [{ actionId: 'planSkipItem', options: { target: 'live', itemId: '', mode: 'toggle' } }], up: [] }],
	}

	presets['run_sheet_rehearsal'] = {
		type: 'button',
		category: 'Run Sheet',
		name: 'Rehearsal Mode (toggle)',
		style: face({ icon: 'rehearsal', label: 'Rehearsal', color: GREY }),
		feedbacks: [{ feedbackId: 'rehearsalMode', options: {}, style: { bgcolor: AMBER, color: INK_DARK } }],
		steps: [{ down: [{ actionId: 'rehearsalMode', options: { mode: 'toggle', planTimeId: '' } }], up: [] }],
	}

	presets['run_sheet_actuals'] = {
		type: 'button',
		category: 'Run Sheet',
		name: 'Actual vs. Planned (status)',
		style: face({
			icon: 'actuals',
			label: 'Actual\\n$(13yearsproducer:actual_over_under)',
			color: DARK,
			size: 'auto',
		}),
		feedbacks: [{ feedbackId: 'rehearsalMode', options: {}, style: { bgcolor: AMBER, color: INK_DARK } }],
		steps: [{ down: [], up: [] }],
	}

	presets['run_sheet_live_music'] = {
		type: 'button',
		category: 'Run Sheet',
		name: 'Live Item Key · BPM · Meter (status)',
		style: face({ icon: 'music', label: '$(13yearsproducer:active_item_music)', color: DARK, size: 'auto' }),
		feedbacks: [],
		steps: [{ down: [], up: [] }],
	}

	presets['run_sheet_next_music'] = {
		type: 'button',
		category: 'Run Sheet',
		name: 'Next Item Key · BPM · Meter (status)',
		style: face({
			icon: 'music',
			label: 'Next\\n$(13yearsproducer:next_item_music)',
			color: DARK,
			size: 'auto',
		}),
		feedbacks: [],
		steps: [{ down: [], up: [] }],
	}

	presets['run_sheet_live_leader'] = {
		type: 'button',
		category: 'Run Sheet',
		name: 'Live Item Leader (status)',
		style: face({ icon: 'roles', label: '$(13yearsproducer:active_item_leader)', color: DARK, size: 'auto' }),
		feedbacks: [],
		steps: [{ down: [], up: [] }],
	}

	presets['clock_producer'] = {
		type: 'button',
		category: 'Clock',
		name: 'Producer Clock (press for 12/24-hour)',
		style: face({ icon: 'timerClock', label: '$(13yearsproducer:producer_clock)', color: DARK, size: 'auto' }),
		feedbacks: [],
		steps: [{ down: [{ actionId: 'setClockFormat', options: { format: 'toggle' } }], up: [] }],
	}

	presets['clock_format_12'] = {
		type: 'button',
		category: 'Clock',
		name: '12-hour Clock',
		style: face({ icon: 'timerClock', label: '12-hour', color: GREY }),
		feedbacks: [{ feedbackId: 'clockFormatIs', options: { format: 'twelveHour' }, style: bg(BLUE) }],
		steps: [{ down: [{ actionId: 'setClockFormat', options: { format: 'twelveHour' } }], up: [] }],
	}

	presets['clock_format_24'] = {
		type: 'button',
		category: 'Clock',
		name: '24-hour Clock',
		style: face({ icon: 'timerClock', label: '24-hour', color: GREY }),
		feedbacks: [{ feedbackId: 'clockFormatIs', options: { format: 'twentyFourHour' }, style: bg(BLUE) }],
		steps: [{ down: [{ actionId: 'setClockFormat', options: { format: 'twentyFourHour' } }], up: [] }],
	}

	presets['duration_toggle_live'] = {
		type: 'button',
		category: 'Projected / Actual',
		name: 'Toggle Projected/Actual (live item)',
		style: face({ icon: 'stopwatch', label: '$(13yearsproducer:active_item_duration_type)', color: GREY }),
		feedbacks: [{ feedbackId: 'timerIsActual', options: {}, style: bg(PURPLE) }],
		steps: [{ down: [{ actionId: 'timerActualToggle', options: {} }], up: [] }],
	}

	presets['duration_toggle_item'] = {
		type: 'button',
		category: 'Projected / Actual',
		name: 'Toggle Projected/Actual (plan item)',
		style: face({ icon: 'timerClock', label: 'Item Actual', color: GREY }),
		feedbacks: [{ feedbackId: 'planItemIsActual', options: { itemId: '' }, style: bg(PURPLE) }],
		steps: [{ down: [{ actionId: 'planToggleItemDurationActual', options: { itemId: '' } }], up: [] }],
	}

	presets['duration_status'] = {
		type: 'button',
		category: 'Projected / Actual',
		name: 'Duration Type (status)',
		style: face({ icon: 'timerClock', label: '$(13yearsproducer:active_item_duration_type)', color: DARK }),
		feedbacks: [{ feedbackId: 'timerIsActual', options: {}, style: bg(PURPLE) }],
		steps: [{ down: [], up: [] }],
	}

	presets['message_send'] = {
		type: 'button',
		category: 'Messages',
		name: 'Send Message',
		style: face({ icon: 'messageSend', label: 'Send', color: BLUE }),
		feedbacks: [],
		steps: [{ down: [{ actionId: 'sendMessage', options: { text: 'Standby', isHighPriority: false } }], up: [] }],
	}

	presets['notification_dismiss'] = {
		type: 'button',
		category: 'Messages',
		name: 'Dismiss Standing Notification',
		style: face({ icon: 'notificationDismiss', label: 'Dismiss', color: GREY }),
		feedbacks: [
			{
				feedbackId: 'notificationStanding',
				options: {},
				style: { bgcolor: AMBER, color: INK_DARK },
			},
		],
		steps: [{ down: [{ actionId: 'dismissNotification', options: {} }], up: [] }],
	}

	presets['messages_clear'] = {
		type: 'button',
		category: 'Messages',
		name: 'Clear Message History',
		style: face({ icon: 'messagesClear', label: 'Clear History', color: RED }),
		feedbacks: [],
		steps: [{ down: [{ actionId: 'clearMessages', options: {} }], up: [] }],
	}

	presets['last_message_status'] = {
		type: 'button',
		category: 'Messages',
		name: 'Last Message (status)',
		style: face({ icon: 'message', label: '$(13yearsproducer:last_message_text)', color: DARK, size: 'auto' }),
		feedbacks: [{ feedbackId: 'notificationStanding', options: {}, style: bg(AMBER) }],
		steps: [{ down: [], up: [] }],
	}

	presets['pco_refresh_plans'] = {
		type: 'button',
		category: 'Planning Center',
		name: 'Refresh Plans',
		style: face({ icon: 'pcoSync', label: 'Refresh Plans', color: BLUE }),
		feedbacks: [],
		steps: [{ down: [{ actionId: 'pcoRefreshPlans', options: {} }], up: [] }],
	}

	presets['pco_live_sync_on'] = {
		type: 'button',
		category: 'Planning Center',
		name: 'Take PCO Live Control',
		style: face({ icon: 'pcoSync', label: 'Take Control', color: GREEN }),
		feedbacks: [{ feedbackId: 'pcoConnected', options: {}, style: bg(GREEN) }],
		steps: [{ down: [{ actionId: 'pcoSetLiveSync', options: { enabled: true } }], up: [] }],
	}

	presets['pco_live_sync_off'] = {
		type: 'button',
		category: 'Planning Center',
		name: 'Release PCO Live Control',
		style: face({ icon: 'pcoSync', label: 'Release', color: GREY }),
		feedbacks: [],
		steps: [{ down: [{ actionId: 'pcoSetLiveSync', options: { enabled: false } }], up: [] }],
	}

	presets['pco_save_actuals'] = {
		type: 'button',
		category: 'Planning Center',
		name: 'Save Actual Lengths To Planning Center',
		style: face({ icon: 'actuals', label: 'Save Actuals', color: GREY }),
		feedbacks: [],
		steps: [{ down: [{ actionId: 'actualsSaveToPco', options: {} }], up: [] }],
	}

	presets['pco_status'] = {
		type: 'button',
		category: 'Planning Center',
		name: 'Planning Center (status)',
		style: face({ icon: 'pcoSync', label: '$(13yearsproducer:pco_user_name)', color: DARK, size: 'auto' }),
		feedbacks: [{ feedbackId: 'pcoConnected', options: {}, style: bg(GREEN) }],
		steps: [{ down: [], up: [] }],
	}

	presets['status_connection'] = {
		type: 'button',
		category: 'Status Displays',
		name: 'Connection (status)',
		style: face({ icon: 'status', label: '$(13yearsproducer:connection_status)', color: GREEN }),
		feedbacks: [{ feedbackId: 'connectionLost', options: {}, style: bg(RED) }],
		steps: [{ down: [], up: [] }],
	}

	presets['status_connection_health'] = {
		type: 'button',
		category: 'Status Displays',
		name: 'Connection Health (state, v2/legacy, round trip)',
		style: face({
			label:
				'$(13yearsproducer:connection_status)\\n$(13yearsproducer:sync_quality)\\nRTT $(13yearsproducer:sync_rtt_ms) ms',
			color: GREEN,
			size: 'auto',
		}),
		feedbacks: [
			{ feedbackId: 'connectionLost', options: {}, style: bg(RED) },
			{ feedbackId: 'connectionStale', options: {}, style: { bgcolor: AMBER, color: INK_DARK } },
		],
		steps: [{ down: [], up: [] }],
	}

	presets['status_action_error'] = {
		type: 'button',
		category: 'Status Displays',
		name: 'Last Action Error (shows for 10 seconds)',
		style: face({ icon: 'warning', label: '$(13yearsproducer:last_action_error)', color: DARK, size: 'auto' }),
		feedbacks: [{ feedbackId: 'actionFailed', options: {}, style: bg(RED) }],
		steps: [{ down: [], up: [] }],
	}

	presets['status_connection_stale'] = {
		type: 'button',
		category: 'Status Displays',
		name: 'Connection Stale (banner)',
		style: face({ icon: 'warning', label: 'Link OK', color: DARK }),
		feedbacks: [
			{
				feedbackId: 'connectionStale',
				options: {},
				style: { bgcolor: AMBER, color: INK_DARK, text: 'NO DATA' },
			},
		],
		steps: [{ down: [], up: [] }],
	}

	presets['status_end_of_plan'] = {
		type: 'button',
		category: 'Status Displays',
		name: 'End Of Plan (status)',
		style: face({ icon: 'warning', label: 'End Of Plan', color: DARK }),
		feedbacks: [{ feedbackId: 'atEndOfPlan', options: {}, style: bg(AMBER) }],
		steps: [{ down: [], up: [] }],
	}

	presets['status_relay'] = {
		type: 'button',
		category: 'Status Displays',
		name: 'Cloud Relay (status)',
		style: face({ icon: 'cloud', label: 'Relay', color: DARK }),
		feedbacks: [{ feedbackId: 'relayEnabled', options: {}, style: bg(GREEN) }],
		steps: [{ down: [], up: [] }],
	}

	return presets
}
