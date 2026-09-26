import type { CompanionActionDefinitions, CompanionActionEvent, CompanionActionContext } from '@companion-module/base'
import { ApiError, ControlApi } from './api'
import { ModuleState } from './state'
import {
	CUE_STATE_LABELS,
	FIRABLE_CUE_STATES,
	type CueStateValue,
	APP_MODES,
	PCO_PLAN_FILTERS,
	HOUR_FORMAT_THRESHOLDS,
	nextCueStateInCycle,
} from './types'
import type { TimerEntrySign } from './timerEntry'

export interface ActionDeps {
	api: ControlApi
	state: ModuleState
	log: (level: 'info' | 'warn' | 'error' | 'debug', message: string) => void
	/**
	 * Pushes variable values and re-runs feedbacks right now. Everything else in
	 * this module changes state on the *app's* side and finds out about it from
	 * the next socket push — the Timer Entry keypad is the exception: its buffer
	 * only exists here, so a key press has to announce itself.
	 */
	refresh: () => void
}

// Wrapper that catches ApiError and logs it, with special handling for fireSelectedCue 409
function guarded(
	callback: (action: CompanionActionEvent, context: CompanionActionContext) => Promise<void> | void,
	deps: ActionDeps,
	isFireSelectedCue: boolean = false,
): (action: CompanionActionEvent, context: CompanionActionContext) => Promise<void> {
	return async (action, context) => {
		try {
			await Promise.resolve(callback(action, context))
		} catch (err) {
			if (err instanceof ApiError) {
				if (isFireSelectedCue && err.status === 409) {
					deps.log('warn', 'No roles are selected. Use the "Set Selection" action first to select roles for this cue.')
				} else {
					deps.log('error', `API error: ${err.message}`)
				}
			} else {
				deps.log('error', `Action failed: ${err instanceof Error ? err.message : String(err)}`)
			}
		}
	}
}

/** The keys of the app's grid that simply append themselves to the buffer: digits, the unit suffixes, and the `:` separator. */
const TIMER_ENTRY_APPEND_KEYS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'h', 'm', 's', ':']

export function getActionDefinitions(deps: ActionDeps): CompanionActionDefinitions {
	const roleChoices = deps.state.roleChoices()
	const planItemChoices = deps.state.planItemChoices()
	const serviceTypeChoices = (deps.state.pco?.serviceTypes ?? []).map((t) => ({ id: t.id, label: t.name }))
	const planChoices = (deps.state.pco?.plans ?? []).map((p) => ({ id: p.id, label: p.title }))

	return {
		fireSelectedCue: {
			name: 'Fire Selected Cue',
			options: [
				{
					type: 'dropdown',
					id: 'state',
					label: 'State',
					choices: FIRABLE_CUE_STATES.map((s) => ({ id: s, label: CUE_STATE_LABELS[s] })),
					default: 'GO',
				},
			],
			callback: guarded(
				async (action) => {
					const state = String(action.options.state) as CueStateValue
					await deps.api.fireSelectedCue(state)
				},
				deps,
				true,
			),
		},

		fireRoleCue: {
			name: 'Fire Role Cue',
			options: [
				{
					type: 'dropdown',
					id: 'roleId',
					label: 'Role',
					choices: roleChoices,
					default: roleChoices[0]?.id ?? '',
					allowCustom: true,
				},
				{
					type: 'dropdown',
					id: 'state',
					label: 'State',
					choices: FIRABLE_CUE_STATES.map((s) => ({ id: s, label: CUE_STATE_LABELS[s] })),
					default: 'GO',
				},
			],
			callback: guarded(async (action) => {
				const roleId = String(action.options.roleId)
				const state = String(action.options.state) as CueStateValue
				await deps.api.fireRoleCue(roleId, state)
			}, deps),
		},

		// The toggle a single template button presses through: Standby → Go! →
		// Clear → Standby → … The next state is read off the SAME live cue
		// state a feedback like roleCueColor paints the button with — press
		// the button, and whatever it's currently showing decides what it
		// becomes next, rather than the button needing a fixed target state.
		cycleRoleCue: {
			name: 'Cycle Role Cue (Standby → Go! → Clear)',
			options: [
				{
					type: 'dropdown',
					id: 'roleId',
					label: 'Role',
					choices: roleChoices,
					default: roleChoices[0]?.id ?? '',
					allowCustom: true,
				},
			],
			callback: guarded(async (action) => {
				const roleId = String(action.options.roleId)
				const current = deps.state.roleById(roleId)?.state ?? 'OFF'
				const next = nextCueStateInCycle(current)
				await deps.api.fireRoleCue(roleId, next)
			}, deps),
		},

		clearAllCues: {
			name: 'Clear All Cues',
			options: [],
			callback: guarded(async () => {
				await deps.api.clearAllCues()
			}, deps),
		},

		setSelection: {
			name: 'Set Selection',
			options: [
				{
					type: 'multidropdown',
					id: 'roleIds',
					label: 'Roles',
					choices: roleChoices,
					default: [],
				},
			],
			callback: guarded(async (action) => {
				const roleIds = (action.options.roleIds as string[]) ?? []
				await deps.api.setSelection(roleIds)
			}, deps),
		},

		timerStart: {
			name: 'Timer Start',
			options: [],
			callback: guarded(async () => {
				await deps.api.timerStart()
			}, deps),
		},

		timerPause: {
			name: 'Timer Pause',
			options: [],
			callback: guarded(async () => {
				await deps.api.timerPause()
			}, deps),
		},

		timerToggle: {
			name: 'Timer Toggle',
			options: [],
			callback: guarded(async () => {
				await deps.api.timerToggle()
			}, deps),
		},

		timerReset: {
			name: 'Timer Reset',
			options: [],
			callback: guarded(async () => {
				await deps.api.timerReset()
			}, deps),
		},

		timerAdjust: {
			name: 'Timer Adjust',
			options: [
				{
					type: 'number',
					id: 'seconds',
					label: 'Seconds',
					default: 30,
					min: -3600,
					max: 3600,
				},
			],
			callback: guarded(async (action) => {
				const seconds = Number(action.options.seconds)
				await deps.api.timerAdjust(seconds)
			}, deps),
		},

		timerSetRemainingSeconds: {
			name: 'Timer Set Remaining (Seconds)',
			options: [
				{
					type: 'number',
					id: 'seconds',
					label: 'Seconds',
					default: 300,
					min: 0,
					max: 86400,
				},
			],
			callback: guarded(async (action) => {
				const seconds = Number(action.options.seconds)
				await deps.api.timerSetRemaining({ seconds })
			}, deps),
		},

		timerSetRemainingInput: {
			name: 'Timer Set Remaining (Input)',
			options: [
				{
					type: 'textinput',
					id: 'input',
					label: 'Input',
					default: '+30s',
					useVariables: true,
				},
			],
			callback: guarded(async (action) => {
				const input = String(action.options.input)
				await deps.api.timerSetRemaining({ input })
			}, deps),
		},

		// MARK: - Timer entry keypad
		//
		// The app's calculator-style time-entry popover (TimeEntryPopover.swift)
		// spread across physical buttons: every key edits one shared buffer in
		// this module (`state.timerEntryBuffer`), and only Enter talks to the
		// app — posting the raw typed text to `POST /v1/timer/remaining` so the
		// app's own parser, not this module, decides what it meant.

		timerEntryAppend: {
			name: 'Timer Entry: Append Key',
			options: [
				{
					type: 'dropdown',
					id: 'key',
					label: 'Key',
					choices: TIMER_ENTRY_APPEND_KEYS.map((key) => ({ id: key, label: key })),
					default: '0',
					// Custom text appends whole fragments ("30s", "1h") from one
					// button, for a pad that wants shortcuts the app's grid has no
					// room for.
					allowCustom: true,
				},
			],
			callback: guarded(async (action) => {
				deps.state.appendTimerEntry(String(action.options.key))
				deps.refresh()
			}, deps),
		},

		timerEntrySign: {
			name: 'Timer Entry: Sign (+/−)',
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
			callback: guarded(async (action) => {
				deps.state.setTimerEntrySign(String(action.options.sign) as TimerEntrySign)
				deps.refresh()
			}, deps),
		},

		timerEntryBackspace: {
			name: 'Timer Entry: Backspace',
			options: [],
			callback: guarded(async () => {
				deps.state.backspaceTimerEntry()
				deps.refresh()
			}, deps),
		},

		timerEntryClear: {
			name: 'Timer Entry: Clear',
			options: [],
			callback: guarded(async () => {
				deps.state.clearTimerEntry()
				deps.refresh()
			}, deps),
		},

		// Enter. An empty or unparseable buffer commits nothing — same as the
		// popover, where Return on junk just dismisses. The buffer is cleared
		// either way *except* when the post itself fails (a 409 because no plan
		// is loaded or no item is active, say): there's nothing to re-type in
		// that case, so what was typed is kept for a second press.
		timerEntryCommit: {
			name: 'Timer Entry: Enter (Commit)',
			options: [],
			callback: guarded(async () => {
				const input = deps.state.timerEntryBuffer
				if (!deps.state.timerEntryAction) {
					deps.state.clearTimerEntry()
					deps.refresh()
					return
				}
				await deps.api.timerSetRemaining({ input })
				deps.state.clearTimerEntry()
				deps.refresh()
			}, deps),
		},

		timerActualOverride: {
			name: 'Timer Actual Override',
			options: [
				{
					type: 'checkbox',
					id: 'isActual',
					label: 'Is Actual',
					default: false,
				},
			],
			callback: guarded(async (action) => {
				const isActual = Boolean(action.options.isActual)
				await deps.api.timerActualOverride(isActual)
			}, deps),
		},

		planNext: {
			name: 'Plan Next',
			options: [],
			callback: guarded(async () => {
				await deps.api.planNext()
			}, deps),
		},

		planPrevious: {
			name: 'Plan Previous',
			options: [],
			callback: guarded(async () => {
				await deps.api.planPrevious()
			}, deps),
		},

		planNextService: {
			name: 'Plan Next Service',
			options: [],
			callback: guarded(async () => {
				await deps.api.planNextService()
			}, deps),
		},

		planJumpToItem: {
			name: 'Plan Jump to Item',
			options: [
				{
					type: 'dropdown',
					id: 'itemId',
					label: 'Item',
					choices: planItemChoices,
					default: planItemChoices[0]?.id ?? '',
					allowCustom: true,
				},
			],
			callback: guarded(async (action) => {
				const itemId = String(action.options.itemId)
				await deps.api.setActiveItem(itemId)
			}, deps),
		},

		planAddItem: {
			name: 'Plan Add Item',
			options: [
				{
					type: 'textinput',
					id: 'title',
					label: 'Title',
					default: '',
				},
				{
					type: 'textinput',
					id: 'itemType',
					label: 'Item Type',
					default: 'Item',
				},
				{
					type: 'number',
					id: 'lengthInSeconds',
					label: 'Length (Seconds)',
					default: 300,
					min: 0,
					max: 86400,
				},
				{
					type: 'checkbox',
					id: 'isDurationActual',
					label: 'Is Duration Actual',
					default: false,
				},
			],
			callback: guarded(async (action) => {
				const title = String(action.options.title)
				const itemType = String(action.options.itemType)
				const lengthInSeconds = Number(action.options.lengthInSeconds)
				const isDurationActual = Boolean(action.options.isDurationActual)
				await deps.api.addPlanItem({ title, itemType, lengthInSeconds, isDurationActual })
			}, deps),
		},

		planUpdateItem: {
			name: 'Plan Update Item',
			options: [
				{
					type: 'dropdown',
					id: 'itemId',
					label: 'Item',
					choices: planItemChoices,
					default: planItemChoices[0]?.id ?? '',
				},
				{
					type: 'textinput',
					id: 'title',
					label: 'Title',
					default: '',
				},
				{
					type: 'textinput',
					id: 'itemType',
					label: 'Item Type',
					default: '',
				},
				{
					type: 'number',
					id: 'lengthInSeconds',
					label: 'Length (Seconds) — 0 leaves it unchanged',
					default: 0,
					min: 0,
					max: 86400,
				},
			],
			callback: guarded(async (action) => {
				const itemId = String(action.options.itemId)
				const title = String(action.options.title)
				const itemType = String(action.options.itemType)
				const lengthInSeconds = Number(action.options.lengthInSeconds)

				const body: Record<string, string | number | boolean> = {}
				if (title) body.title = title
				if (itemType) body.itemType = itemType
				if (lengthInSeconds) body.lengthInSeconds = lengthInSeconds

				await deps.api.updatePlanItem(itemId, body)
			}, deps),
		},

		planDeleteItem: {
			name: 'Plan Delete Item',
			options: [
				{
					type: 'dropdown',
					id: 'itemId',
					label: 'Item',
					choices: planItemChoices,
					default: planItemChoices[0]?.id ?? '',
				},
			],
			callback: guarded(async (action) => {
				const itemId = String(action.options.itemId)
				await deps.api.deletePlanItem(itemId)
			}, deps),
		},

		planSetItemDurationActual: {
			name: 'Plan Set Item Duration Actual',
			options: [
				{
					type: 'dropdown',
					id: 'itemId',
					label: 'Item',
					choices: planItemChoices,
					default: planItemChoices[0]?.id ?? '',
				},
				{
					type: 'checkbox',
					id: 'isActual',
					label: 'Is Actual',
					default: true,
				},
			],
			callback: guarded(async (action) => {
				const itemId = String(action.options.itemId)
				const isActual = Boolean(action.options.isActual)
				await deps.api.setPlanItemDurationActual(itemId, isActual)
			}, deps),
		},

		planReorderItems: {
			name: 'Plan Reorder Items',
			options: [
				{
					type: 'textinput',
					id: 'itemIds',
					label: 'Item IDs (comma-separated)',
					default: '',
				},
			],
			callback: guarded(async (action) => {
				const itemIds = String(action.options.itemIds)
					.split(',')
					.map((s) => s.trim())
					.filter(Boolean)
				await deps.api.reorderPlanItems(itemIds)
			}, deps),
		},

		planImport: {
			name: 'Plan Import',
			options: [
				{
					type: 'textinput',
					id: 'text',
					label: 'Plan Text',
					default: '',
					useVariables: true,
				},
				{
					type: 'textinput',
					id: 'title',
					label: 'Title',
					default: '',
				},
			],
			callback: guarded(async (action) => {
				const text = String(action.options.text)
				const title = String(action.options.title)
				await deps.api.importPlan(text, title || undefined)
			}, deps),
		},

		pcoSignIn: {
			name: 'Planning Center Sign In',
			options: [],
			callback: guarded(async () => {
				await deps.api.pcoSignIn()
			}, deps),
		},

		pcoSignOut: {
			name: 'Planning Center Sign Out',
			options: [],
			callback: guarded(async () => {
				await deps.api.pcoSignOut()
			}, deps),
		},

		pcoSelectServiceType: {
			name: 'Planning Center Select Service Type',
			options: [
				{
					type: 'dropdown',
					id: 'serviceTypeId',
					label: 'Service Type',
					choices: serviceTypeChoices,
					default: serviceTypeChoices[0]?.id ?? '',
					allowCustom: true,
				},
			],
			callback: guarded(async (action) => {
				const serviceTypeId = String(action.options.serviceTypeId)
				await deps.api.selectPcoServiceType(serviceTypeId)
			}, deps),
		},

		pcoRefreshServiceTypes: {
			name: 'Planning Center Refresh Service Types',
			options: [],
			callback: guarded(async () => {
				await deps.api.refreshPcoServiceTypes()
			}, deps),
		},

		pcoRefreshPlans: {
			name: 'Planning Center Refresh Plans',
			options: [],
			callback: guarded(async () => {
				await deps.api.refreshPcoPlans()
			}, deps),
		},

		pcoSetPlanFilter: {
			name: 'Planning Center Set Plan Filter',
			options: [
				{
					type: 'dropdown',
					id: 'filter',
					label: 'Filter',
					choices: PCO_PLAN_FILTERS,
					default: 'future',
				},
			],
			callback: guarded(async (action) => {
				const filter = String(action.options.filter)
				await deps.api.setPcoPlanFilter(filter)
			}, deps),
		},

		pcoSync: {
			name: 'Planning Center Sync',
			options: [
				{
					type: 'dropdown',
					id: 'serviceTypeId',
					label: 'Service Type',
					choices: serviceTypeChoices,
					default: serviceTypeChoices[0]?.id ?? '',
					allowCustom: true,
				},
				{
					type: 'dropdown',
					id: 'planId',
					label: 'Plan',
					choices: planChoices,
					default: planChoices[0]?.id ?? '',
					allowCustom: true,
				},
			],
			callback: guarded(async (action) => {
				const serviceTypeId = String(action.options.serviceTypeId)
				const planId = String(action.options.planId)
				await deps.api.syncPco(serviceTypeId, planId)
			}, deps),
		},

		pcoSetLiveSync: {
			name: 'Planning Center Set Live Sync',
			options: [
				{
					type: 'checkbox',
					id: 'enabled',
					label: 'Enabled',
					default: true,
				},
			],
			callback: guarded(async (action) => {
				const enabled = Boolean(action.options.enabled)
				await deps.api.setPcoLiveSync(enabled)
			}, deps),
		},

		sendMessage: {
			name: 'Send Message',
			options: [
				{
					type: 'textinput',
					id: 'text',
					label: 'Message',
					default: '',
					useVariables: true,
				},
				{
					type: 'dropdown',
					id: 'targetRoleId',
					label: 'Target Role',
					choices: [{ id: '', label: 'Everyone' }, ...roleChoices],
					default: '',
				},
				{
					type: 'checkbox',
					id: 'isHighPriority',
					label: 'High Priority',
					default: false,
				},
			],
			callback: guarded(async (action) => {
				const text = String(action.options.text)
				const targetRoleId = String(action.options.targetRoleId)
				const isHighPriority = Boolean(action.options.isHighPriority)
				await deps.api.sendMessage({
					text,
					targetRoleId: targetRoleId || undefined,
					isHighPriority,
				})
			}, deps),
		},

		clearMessages: {
			name: 'Clear Messages',
			options: [],
			callback: guarded(async () => {
				await deps.api.clearMessages()
			}, deps),
		},

		setUiMode: {
			name: 'Set UI Mode',
			options: [
				{
					type: 'dropdown',
					id: 'mode',
					label: 'Mode',
					choices: APP_MODES,
					default: 'PRODUCER_CONTROL',
				},
			],
			callback: guarded(async (action) => {
				const mode = String(action.options.mode)
				await deps.api.setUiMode(mode)
			}, deps),
		},

		createRole: {
			name: 'Create Role',
			options: [
				{
					type: 'textinput',
					id: 'name',
					label: 'Name',
					default: '',
				},
			],
			callback: guarded(async (action) => {
				const name = String(action.options.name)
				await deps.api.createRole(name)
			}, deps),
		},

		updateRole: {
			name: 'Update Role',
			options: [
				{
					type: 'dropdown',
					id: 'roleId',
					label: 'Role',
					choices: roleChoices,
					default: roleChoices[0]?.id ?? '',
				},
				{
					type: 'textinput',
					id: 'name',
					label: 'Name',
					default: '',
				},
				{
					type: 'textinput',
					id: 'personName',
					label: 'Person Name',
					default: '',
				},
			],
			callback: guarded(async (action) => {
				const roleId = String(action.options.roleId)
				const name = String(action.options.name)
				const personName = String(action.options.personName)

				const body: Record<string, string> = {}
				if (name) body.name = name
				if (personName) body.personName = personName

				await deps.api.updateRole(roleId, body)
			}, deps),
		},

		deleteRole: {
			name: 'Delete Role',
			options: [
				{
					type: 'dropdown',
					id: 'roleId',
					label: 'Role',
					choices: roleChoices,
					default: roleChoices[0]?.id ?? '',
				},
			],
			callback: guarded(async (action) => {
				const roleId = String(action.options.roleId)
				await deps.api.deleteRole(roleId)
			}, deps),
		},

		plotipharPairStart: {
			name: 'Plotiphar Start Pairing',
			options: [],
			callback: guarded(async () => {
				await deps.api.startPlotipharPairing()
			}, deps),
		},

		plotipharPairCancel: {
			name: 'Plotiphar Cancel Pairing',
			options: [],
			callback: guarded(async () => {
				await deps.api.cancelPlotipharPairing()
			}, deps),
		},

		plotipharSyncAssignments: {
			name: 'Plotiphar Sync Assignments',
			options: [],
			callback: guarded(async () => {
				await deps.api.syncPlotipharAssignments()
			}, deps),
		},

		plotipharDisconnect: {
			name: 'Plotiphar Disconnect',
			options: [],
			callback: guarded(async () => {
				await deps.api.disconnectPlotiphar()
			}, deps),
		},

		networkPing: {
			name: 'Network Ping',
			options: [
				{
					type: 'textinput',
					id: 'ip',
					label: 'IP Address',
					default: '',
				},
			],
			callback: guarded(async (action) => {
				const ip = String(action.options.ip)
				await deps.api.networkPing(ip)
			}, deps),
		},

		networkForgetProducer: {
			name: 'Network Forget Producer',
			options: [],
			callback: guarded(async () => {
				await deps.api.forgetProducer()
			}, deps),
		},

		networkSetMaster: {
			name: 'Network Set Master',
			options: [
				{
					type: 'checkbox',
					id: 'isMaster',
					label: 'Is Master',
					default: true,
				},
			],
			callback: guarded(async (action) => {
				const isMaster = Boolean(action.options.isMaster)
				await deps.api.setMasterMode(isMaster)
			}, deps),
		},

		updateSettings: {
			name: 'Update Settings',
			options: [
				{
					type: 'dropdown',
					id: 'hourFormatThreshold',
					label: 'Hour Format Threshold',
					choices: HOUR_FORMAT_THRESHOLDS,
					default: 'over60Minutes',
				},
			],
			callback: guarded(async (action) => {
				const hourFormatThreshold = String(action.options.hourFormatThreshold)
				await deps.api.updateSettings(hourFormatThreshold)
			}, deps),
		},

		setRelay: {
			name: 'Set Relay',
			options: [
				{
					type: 'checkbox',
					id: 'enabled',
					label: 'Enabled',
					default: true,
				},
				{
					type: 'textinput',
					id: 'host',
					label: 'Host',
					default: '',
				},
			],
			callback: guarded(async (action) => {
				const enabled = Boolean(action.options.enabled)
				const host = String(action.options.host)
				await deps.api.setRelay({
					enabled,
					host: host || undefined,
				})
			}, deps),
		},
	}
}
