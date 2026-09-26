import { CompanionPresetDefinitions, combineRgb, type CompanionButtonStyleProps } from '@companion-module/base'
import { CUE_STATE_COLOR, CUE_STATE_LABELS, CUE_STATE_TEXT_COLOR, FIRABLE_CUE_STATES } from './types'
import { ModuleState } from './state'
import { TIMER_ENTRY_GLYPHS, TIMER_ENTRY_GLYPHS_DARK } from './glyphs'

// Shared color palette
const GREEN = combineRgb(38, 199, 89)
const RED = combineRgb(204, 0, 0)
const BLUE = combineRgb(74, 144, 226)
const GREY = combineRgb(100, 100, 100)
const WHITE = combineRgb(255, 255, 255)
const DARK = combineRgb(20, 26, 38)
const AMBER = combineRgb(245, 184, 38)
// CueState.swift's own near-black, for ink on a light ground.
const INK_DARK = combineRgb(26, 26, 26)

/**
 * Whether the Timer Entry keys wear a pre-rendered Inter glyph (src/glyphs.ts)
 * rather than a label set in Companion's own bundled font. On, the pad's
 * digits match the app's screen, the web pager, and the ESP32 pagers —
 * slashed zero included. Set this to `false` to go back to plain text on every
 * key; the text each key would show is passed to `keyFace` either way, so
 * that's the whole revert.
 */
const USE_GLYPH_KEY_FACES = true

/**
 * A key's face. Companion draws a button's `png64` first and its `text` on top,
 * so a glyph key's label has to be empty or the default font prints straight
 * over the artwork. Falls back to text for any key the generated file has no
 * glyph for, so a partial re-render can't produce blank buttons.
 */
function keyFace(glyphId: string, text: string): Pick<CompanionButtonStyleProps, 'text' | 'size' | 'png64'> {
	const glyph = USE_GLYPH_KEY_FACES ? TIMER_ENTRY_GLYPHS[glyphId] : undefined
	return glyph ? { text: '', size: '30', png64: glyph } : { text, size: '30' }
}

/**
 * The style a feedback paints over a key while it's lit.
 *
 * A glyph is ink on transparency, so repainting the background underneath it
 * is exactly what makes a white key face vanish: Clear and Backspace go amber
 * the moment anything is typed, Enter goes green as soon as the buffer parses,
 * and white-on-amber is a blank button. Every lit state therefore swaps in the
 * dark-ink cut of the same glyph (`TIMER_ENTRY_GLYPHS_DARK`) rather than only
 * changing the colour behind it. The feedback *definitions* keep their own
 * defaults for anyone who adds one to a plain text button by hand; these are
 * the per-preset overrides.
 */
function litFace(
	glyphId: string,
	text: string,
	bgcolor: number,
	ink: 'light' | 'dark',
): { text: string; size: '30'; png64?: string; color: number; bgcolor: number } {
	const map = ink === 'dark' ? TIMER_ENTRY_GLYPHS_DARK : TIMER_ENTRY_GLYPHS
	const glyph = USE_GLYPH_KEY_FACES ? map[glyphId] : undefined
	const color = ink === 'dark' ? INK_DARK : WHITE
	return glyph ? { text: '', size: '30', png64: glyph, color, bgcolor } : { text, size: '30', color, bgcolor }
}

export function getPresetDefinitions(state: ModuleState): CompanionPresetDefinitions {
	const presets: CompanionPresetDefinitions = {}
	const roleSlugs = state.roleSlugs()

	// MARK: - Cues (Selected Roles)
	for (const cueState of FIRABLE_CUE_STATES) {
		const bgcolor = combineRgb(...CUE_STATE_COLOR[cueState])
		const color = combineRgb(...CUE_STATE_TEXT_COLOR[cueState])
		const label = CUE_STATE_LABELS[cueState]

		presets[`cue_selected_${cueState.toLowerCase()}`] = {
			type: 'button',
			category: 'Cues',
			name: `Selected • ${label}`,
			style: {
				text: `Selected\n${label}`,
				size: 'auto',
				color: color,
				bgcolor: bgcolor,
			},
			steps: [
				{
					down: [{ actionId: 'fireSelectedCue', options: { state: cueState } }],
					up: [],
				},
			],
			feedbacks: [],
		}
	}

	// Clear All Cues
	presets['cue_clear_all'] = {
		type: 'button',
		category: 'Cues',
		name: 'Clear All Cues',
		style: {
			text: 'Clear\nAll',
			size: 'auto',
			color: WHITE,
			bgcolor: GREY,
		},
		steps: [
			{
				down: [{ actionId: 'clearAllCues', options: {} }],
				up: [],
			},
		],
		feedbacks: [],
	}

	// MARK: - Cues Per Role
	for (const role of state.roles) {
		const slug = roleSlugs.get(role.id) || 'unknown'

		// Cue state buttons for this role
		for (const cueState of FIRABLE_CUE_STATES) {
			const bgcolor = combineRgb(...CUE_STATE_COLOR[cueState])
			const color = combineRgb(...CUE_STATE_TEXT_COLOR[cueState])
			const label = CUE_STATE_LABELS[cueState]

			presets[`role_${slug}_cue_${cueState.toLowerCase()}`] = {
				type: 'button',
				category: 'Cues — Per Role',
				name: `${role.name} • ${label}`,
				style: {
					text: `${role.name}\n${label}`,
					size: 'auto',
					color: color,
					bgcolor: bgcolor,
				},
				steps: [
					{
						down: [{ actionId: 'fireRoleCue', options: { roleId: role.id, state: cueState } }],
						up: [],
					},
				],
				feedbacks: [
					// `roleCueIs`'s own defaultStyle is fixed to GO's green — override
					// per preset so a STANDBY/FLASH_* button confirms in its own
					// color instead of flashing green for every state.
					{
						feedbackId: 'roleCueIs',
						options: { roleId: role.id, state: cueState },
						style: { bgcolor, color },
					},
				],
			}
		}

		// Toggle button for this role: one button that both shows the role's
		// live cue color/label (roleCueColor feedback) AND, on press, advances
		// to the next state in the Standby → Go! → Clear cycle — the next
		// action fires is read off the exact same state the feedback is
		// already painting the button with, so the button never needs to know
		// its own "current" state ahead of time the way a fixed-state button does.
		presets[`role_${slug}_toggle`] = {
			type: 'button',
			category: 'Cues — Toggle',
			name: `${role.name} — Toggle`,
			style: {
				text: `${role.name}\n$(self:role_${slug}_label)`,
				size: 'auto',
				color: WHITE,
				bgcolor: DARK,
			},
			steps: [
				{
					down: [{ actionId: 'cycleRoleCue', options: { roleId: role.id } }],
					up: [],
				},
			],
			feedbacks: [
				{
					feedbackId: 'roleCueColor',
					options: { roleId: role.id },
				},
			],
		}
	}

	// MARK: - Timer Transport
	presets['timer_start'] = {
		type: 'button',
		category: 'Timer Transport',
		name: 'Timer Start',
		style: {
			text: 'Start',
			size: 'auto',
			color: WHITE,
			bgcolor: GREEN,
		},
		steps: [
			{
				down: [{ actionId: 'timerStart', options: {} }],
				up: [],
			},
		],
		feedbacks: [],
	}

	presets['timer_pause'] = {
		type: 'button',
		category: 'Timer Transport',
		name: 'Timer Pause',
		style: {
			text: 'Pause',
			size: 'auto',
			color: WHITE,
			bgcolor: GREY,
		},
		steps: [
			{
				down: [{ actionId: 'timerPause', options: {} }],
				up: [],
			},
		],
		feedbacks: [],
	}

	presets['timer_toggle'] = {
		type: 'button',
		category: 'Timer Transport',
		name: 'Timer Toggle',
		style: {
			text: 'Toggle\n$(self:active_item_remaining)',
			size: 'auto',
			color: WHITE,
			bgcolor: BLUE,
		},
		steps: [
			{
				down: [{ actionId: 'timerToggle', options: {} }],
				up: [],
			},
		],
		feedbacks: [
			{
				feedbackId: 'timerRunning',
				options: {},
			},
		],
	}

	presets['timer_reset'] = {
		type: 'button',
		category: 'Timer Transport',
		name: 'Timer Reset',
		style: {
			text: 'Reset',
			size: 'auto',
			color: WHITE,
			bgcolor: GREY,
		},
		steps: [
			{
				down: [{ actionId: 'timerReset', options: {} }],
				up: [],
			},
		],
		feedbacks: [],
	}

	// MARK: - Timer Nudges
	const nudges = [
		{ label: '-5m', seconds: -300 },
		{ label: '-1m', seconds: -60 },
		{ label: '-30s', seconds: -30 },
		{ label: '+30s', seconds: 30 },
		{ label: '+1m', seconds: 60 },
		{ label: '+5m', seconds: 300 },
	]

	for (const nudge of nudges) {
		const bgcolor = nudge.seconds < 0 ? RED : GREEN
		presets[`timer_adjust_${nudge.seconds}`] = {
			type: 'button',
			category: 'Timer Nudges',
			name: `Timer ${nudge.label}`,
			style: {
				text: nudge.label,
				size: 'auto',
				color: WHITE,
				bgcolor: bgcolor,
			},
			steps: [
				{
					down: [{ actionId: 'timerAdjust', options: { seconds: nudge.seconds } }],
					up: [],
				},
			],
			feedbacks: [],
		}
	}

	// MARK: - Service Navigation
	presets['plan_previous'] = {
		type: 'button',
		category: 'Service Navigation',
		name: 'Previous Item',
		style: {
			text: '◂ Prev Item',
			size: 'auto',
			color: WHITE,
			bgcolor: BLUE,
		},
		steps: [
			{
				down: [{ actionId: 'planPrevious', options: {} }],
				up: [],
			},
		],
		feedbacks: [],
	}

	presets['plan_active_item_status'] = {
		type: 'button',
		category: 'Service Navigation',
		name: 'Active Item Status',
		style: {
			text: '$(self:active_item_title)\n$(self:active_item_remaining)',
			size: 'auto',
			color: WHITE,
			bgcolor: DARK,
		},
		steps: [
			{
				down: [],
				up: [],
			},
		],
		feedbacks: [
			{
				feedbackId: 'timerOvertime',
				options: {},
			},
			{
				feedbackId: 'timerUnderThreshold',
				options: { thresholdSeconds: 30 },
			},
		],
	}

	presets['plan_next'] = {
		type: 'button',
		category: 'Service Navigation',
		name: 'Next Item',
		style: {
			text: 'Next Item ▸',
			size: 'auto',
			color: WHITE,
			bgcolor: BLUE,
		},
		steps: [
			{
				down: [{ actionId: 'planNext', options: {} }],
				up: [],
			},
		],
		feedbacks: [],
	}

	presets['plan_next_service'] = {
		type: 'button',
		category: 'Service Navigation',
		name: 'Next Service',
		style: {
			text: 'Next Service',
			size: 'auto',
			color: WHITE,
			bgcolor: GREY,
		},
		steps: [
			{
				down: [{ actionId: 'planNextService', options: {} }],
				up: [],
			},
		],
		feedbacks: [],
	}

	// MARK: - Planning Center
	presets['pco_sign_in'] = {
		type: 'button',
		category: 'Planning Center',
		name: 'PCO Sign In',
		style: {
			text: 'PCO\nSign In',
			size: 'auto',
			color: WHITE,
			bgcolor: BLUE,
		},
		steps: [
			{
				down: [{ actionId: 'pcoSignIn', options: {} }],
				up: [],
			},
		],
		feedbacks: [],
	}

	presets['pco_refresh_plans'] = {
		type: 'button',
		category: 'Planning Center',
		name: 'Refresh Plans',
		style: {
			text: 'Refresh\nPlans',
			size: 'auto',
			color: WHITE,
			bgcolor: GREY,
		},
		steps: [
			{
				down: [{ actionId: 'pcoRefreshPlans', options: {} }],
				up: [],
			},
		],
		feedbacks: [],
	}

	presets['pco_live_sync'] = {
		type: 'button',
		category: 'Planning Center',
		name: 'PCO Live Sync',
		style: {
			text: 'Live\nSync',
			size: 'auto',
			color: WHITE,
			bgcolor: BLUE,
		},
		steps: [
			{
				down: [{ actionId: 'pcoSetLiveSync', options: { enabled: true } }],
				up: [],
			},
		],
		feedbacks: [
			{
				feedbackId: 'pcoConnected',
				options: {},
			},
		],
	}

	presets['pco_sign_out'] = {
		type: 'button',
		category: 'Planning Center',
		name: 'PCO Sign Out',
		style: {
			text: 'PCO\nSign Out',
			size: 'auto',
			color: WHITE,
			bgcolor: GREY,
		},
		steps: [
			{
				down: [{ actionId: 'pcoSignOut', options: {} }],
				up: [],
			},
		],
		feedbacks: [],
	}

	// MARK: - Messages
	const messagePresets = [
		{ id: 'msg_2min', text: '2 minutes', action: '2 minutes' },
		{ id: 'msg_1min', text: '1 minute', action: '1 minute' },
		{ id: 'msg_standby', text: 'Standby', action: 'Standby' },
		{ id: 'msg_go', text: 'Go', action: 'Go', isHighPriority: true },
	]

	for (const preset of messagePresets) {
		presets[preset.id] = {
			type: 'button',
			category: 'Messages',
			name: `Send: ${preset.text}`,
			style: {
				text: preset.text,
				size: 'auto',
				color: WHITE,
				bgcolor: BLUE,
			},
			steps: [
				{
					down: [
						{
							actionId: 'sendMessage',
							options: {
								text: preset.action,
								targetRoleId: '',
								isHighPriority: preset.isHighPriority ?? false,
							},
						},
					],
					up: [],
				},
			],
			feedbacks: [],
		}
	}

	presets['msg_clear_all'] = {
		type: 'button',
		category: 'Messages',
		name: 'Clear Messages',
		style: {
			text: 'Clear',
			size: 'auto',
			color: WHITE,
			bgcolor: GREY,
		},
		steps: [
			{
				down: [{ actionId: 'clearMessages', options: {} }],
				up: [],
			},
		],
		feedbacks: [],
	}

	presets['msg_last_status'] = {
		type: 'button',
		category: 'Messages',
		name: 'Last Message',
		style: {
			text: '$(self:last_message_text)',
			size: 'auto',
			color: WHITE,
			bgcolor: DARK,
		},
		steps: [
			{
				down: [],
				up: [],
			},
		],
		feedbacks: [],
	}

	// MARK: - Status Displays
	presets['connection_status'] = {
		type: 'button',
		category: 'Status Displays',
		name: 'Producer Connection',
		style: {
			text: 'Producer\n$(self:connection_status)',
			size: 'auto',
			color: WHITE,
			bgcolor: DARK,
		},
		steps: [
			{
				down: [],
				up: [],
			},
		],
		feedbacks: [
			{
				feedbackId: 'connectionLost',
				options: {},
			},
		],
	}

	presets['plan_at_end_status'] = {
		type: 'button',
		category: 'Status Displays',
		name: 'End of Plan Indicator',
		style: {
			text: 'End of Plan',
			size: 'auto',
			color: WHITE,
			bgcolor: DARK,
		},
		steps: [
			{
				down: [],
				up: [],
			},
		],
		feedbacks: [
			{
				feedbackId: 'atEndOfPlan',
				options: {},
			},
		],
	}

	// MARK: - Timer Entry
	//
	// The app's calculator-style time-entry grid (TimeEntryKeypad in
	// TimeEntryPopover.swift), one Companion button per key. Every key types
	// into the same buffer this module holds; only Enter talks to the app.
	//
	// Companion presets are single buttons — nothing can span two cells — so the
	// popover's double-tall Enter and double-wide 0 are ordinary one-cell
	// buttons here, and Backspace (keyboard-only in the app) takes the cell that
	// frees up. Names carry their row/column so the whole pad can be dropped
	// onto a page in grid order:
	//
	//   R0    screen readout (the popover's screen sits above its grid)
	//   R1    C  h  m  s
	//   R2    7  8  9  −
	//   R3    4  5  6  +
	//   R4    1  2  3  ↵
	//   R5    0  :  ⌫
	// The popover's screen: what's been typed, over what it would resolve to.
	// Not a key — pressing it does nothing, same as the box in the app.
	presets['timer_entry_screen'] = {
		type: 'button',
		category: 'Timer Entry',
		name: 'R0 • Entry Screen',
		style: {
			text: '$(self:timer_entry_buffer)\n$(self:timer_entry_preview)',
			size: 'auto',
			color: WHITE,
			bgcolor: DARK,
		},
		steps: [
			{
				down: [],
				up: [],
			},
		],
		feedbacks: [],
	}

	const entryAppendKeys = [
		{ position: 'R1C2', key: 'h' },
		{ position: 'R1C3', key: 'm' },
		{ position: 'R1C4', key: 's' },
		{ position: 'R2C1', key: '7' },
		{ position: 'R2C2', key: '8' },
		{ position: 'R2C3', key: '9' },
		{ position: 'R3C1', key: '4' },
		{ position: 'R3C2', key: '5' },
		{ position: 'R3C3', key: '6' },
		{ position: 'R4C1', key: '1' },
		{ position: 'R4C2', key: '2' },
		{ position: 'R4C3', key: '3' },
		{ position: 'R5C1', key: '0' },
		{ position: 'R5C2', key: ':' },
	]

	for (const entry of entryAppendKeys) {
		const idSuffix = entry.key === ':' ? 'colon' : entry.key
		presets[`timer_entry_key_${idSuffix}`] = {
			type: 'button',
			category: 'Timer Entry',
			name: `${entry.position} • ${entry.key}`,
			style: {
				...keyFace(idSuffix, entry.key),
				color: WHITE,
				bgcolor: DARK,
			},
			steps: [
				{
					down: [{ actionId: 'timerEntryAppend', options: { key: entry.key } }],
					up: [],
				},
			],
			feedbacks: [],
		}
	}

	// The two sign keys light up while their sign is the one on the buffer —
	// pressing the lit one again clears it, exactly as in the popover.
	const entrySignKeys = [
		{ position: 'R2C4', id: 'minus', sign: '-', face: '−' },
		{ position: 'R3C4', id: 'plus', sign: '+', face: '+' },
	]

	for (const entry of entrySignKeys) {
		presets[`timer_entry_sign_${entry.id}`] = {
			type: 'button',
			category: 'Timer Entry',
			name: `${entry.position} • ${entry.face} (Relative)`,
			style: {
				...keyFace(entry.id, entry.face),
				color: WHITE,
				bgcolor: DARK,
			},
			steps: [
				{
					down: [{ actionId: 'timerEntrySign', options: { sign: entry.sign } }],
					up: [],
				},
			],
			feedbacks: [
				{
					feedbackId: 'timerEntrySignIs',
					options: { sign: entry.sign },
					style: litFace(entry.id, entry.face, BLUE, 'light'),
				},
			],
		}
	}

	presets['timer_entry_clear'] = {
		type: 'button',
		category: 'Timer Entry',
		name: 'R1C1 • C (Clear)',
		style: {
			...keyFace('clear', 'C'),
			color: WHITE,
			bgcolor: GREY,
		},
		steps: [
			{
				down: [{ actionId: 'timerEntryClear', options: {} }],
				up: [],
			},
		],
		feedbacks: [
			{
				feedbackId: 'timerEntryInProgress',
				options: {},
				style: litFace('clear', 'C', AMBER, 'dark'),
			},
		],
	}

	presets['timer_entry_backspace'] = {
		type: 'button',
		category: 'Timer Entry',
		name: 'R5C3 • ⌫ Backspace',
		style: {
			...keyFace('backspace', '⌫'),
			color: WHITE,
			bgcolor: GREY,
		},
		steps: [
			{
				down: [{ actionId: 'timerEntryBackspace', options: {} }],
				up: [],
			},
		],
		feedbacks: [
			{
				feedbackId: 'timerEntryInProgress',
				options: {},
				style: litFace('backspace', '\u232B', AMBER, 'dark'),
			},
		],
	}

	presets['timer_entry_enter'] = {
		type: 'button',
		category: 'Timer Entry',
		name: 'R4C4 • ↵ Enter (Commit)',
		style: {
			...keyFace('enter', '↵'),
			color: WHITE,
			bgcolor: GREY,
		},
		steps: [
			{
				down: [{ actionId: 'timerEntryCommit', options: {} }],
				up: [],
			},
		],
		feedbacks: [
			{
				feedbackId: 'timerEntryCommittable',
				options: {},
				style: litFace('enter', '\u21B5', GREEN, 'dark'),
			},
		],
	}

	return presets
}
