import type { CompanionActionDefinitions, CompanionActionEvent, CompanionActionContext } from '@companion-module/base'
import { ApiError, ControlApi } from './api.js'
import { ModuleState, RUNDOWN_ROWS } from './state.js'
import {
	optString,
	CUE_STATE_LABELS,
	FIRABLE_CUE_STATES,
	type CueStateValue,
	APP_MODES,
	PCO_PLAN_FILTERS,
	HOUR_FORMAT_THRESHOLDS,
	SCHEDULE_RECURRENCES,
	nextCueStateInCycle,
	type PlanItemUpdateBody,
	type RoleUpdateBody,
} from './types.js'
import { lengthFromOption, normalizeClockTime } from './timerEntry.js'
import type { TimerEntrySign } from './timerEntry.js'

export interface ActionDeps {
	api: ControlApi
	state: ModuleState
	log: (level: 'info' | 'warn' | 'error' | 'debug', message: string) => void
	refresh: () => void
}

function guarded(
	callback: (action: CompanionActionEvent, context: CompanionActionContext) => Promise<void> | void,
	deps: ActionDeps,
	explain?: (err: ApiError) => string | undefined,
): (action: CompanionActionEvent, context: CompanionActionContext) => Promise<void> {
	return async (action, context) => {
		try {
			await Promise.resolve(callback(action, context))
		} catch (err) {
			let shown: string
			if (err instanceof ApiError) {
				const explained = explain?.(err)
				if (explained) {
					deps.log('warn', explained)
					shown = explained
				} else {
					deps.log('error', `API error: ${err.message}`)
					shown = err.message
				}
			} else {
				shown = err instanceof Error ? err.message : String(err)
				deps.log('error', `Action failed: ${shown}`)
			}
			deps.state.noteActionError(shown)
			deps.refresh()
		}
	}
}

function explainWaypointFailure(err: ApiError): string | undefined {
	const which = err.detail ? `"${err.detail}"` : 'That waypoint'
	if (err.status === 404) {
		return `${which} is not a waypoint. Check the name, or create it with the Create Waypoint action.`
	}
	if (err.status === 409) {
		return `${which} exists, but nothing in the plan currently loaded carries it — assign it to an item first.`
	}
	return undefined
}

const START_TIMER_OPTION = {
	type: 'checkbox',
	id: 'startTimer',
	label: 'Start the timer on arrival',
	default: true,
} as const

export function startTimerOption(options: { startTimer?: unknown }): boolean {
	return options.startTimer === undefined || options.startTimer === null ? true : Boolean(options.startTimer)
}

export function isoWithoutFraction(text: string): string | null {
	const ms = Date.parse(text.trim())
	if (Number.isNaN(ms)) return null
	return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

const REPEAT_GUARD_OPTION = {
	type: 'number',
	id: 'ignoreRepeatMs',
	label: 'Ignore repeat presses for N ms',
	tooltip:
		'Presses within this window of the last accepted one are dropped, so a double-tap cannot skip an item. 0 turns it off.',
	default: 0,
	min: 0,
	max: 10000,
} as const

const TIMER_ENTRY_APPEND_KEYS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'h', 'm', 's', ':']

export function getActionDefinitions(deps: ActionDeps): CompanionActionDefinitions {
	const roleChoices = deps.state.roleChoices()
	const planItemChoices = deps.state.planItemChoices()
	const waypointChoices = deps.state.waypointChoices()
	const scheduleChoices = deps.state.scheduleChoices()
	const eventTimeChoices = deps.state.eventTimeChoices()
	const serviceTypeChoices = (deps.state.pco?.serviceTypes ?? []).map((t) => ({ id: t.id, label: t.name }))
	const planChoices = (deps.state.pco?.plans ?? []).map((p) => ({ id: p.id, label: p.title }))
	const noteCategoryChoices = (deps.state.pco?.noteCategories ?? []).map((c) => ({ id: c.id, label: c.name }))

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
					const state = optString(action.options.state) as CueStateValue
					await deps.api.fireSelectedCue(state)
				},
				deps,
				(err) =>
					err.status === 409
						? 'No roles are selected. Use the "Set Selection" action first to choose which roles this cue goes to.'
						: undefined,
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
				const roleId = optString(action.options.roleId)
				const state = optString(action.options.state) as CueStateValue
				await deps.api.fireRoleCue(roleId, state)
			}, deps),
		},

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
				const roleId = optString(action.options.roleId)
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
				const input = optString(action.options.input)
				await deps.api.timerSetRemaining({ input })
			}, deps),
		},

		timerEntryAppend: {
			name: 'Timer Entry: Append Key',
			options: [
				{
					type: 'dropdown',
					id: 'key',
					label: 'Key',
					choices: TIMER_ENTRY_APPEND_KEYS.map((key) => ({ id: key, label: key })),
					default: '0',
					allowCustom: true,
				},
			],
			callback: guarded(async (action) => {
				deps.state.appendTimerEntry(optString(action.options.key))
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
				deps.state.setTimerEntrySign(optString(action.options.sign) as TimerEntrySign)
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

		timerEndAt: {
			name: 'Timer: End At',
			description:
				'Makes the active timer end at a clock time on the producer\u2019s clock. 24-hour (14:30) or 12-hour (2:30 PM); sent to the app as HH:mm.',
			options: [
				{
					type: 'textinput',
					id: 'time',
					label: 'Time (HH:mm or h:mm AM/PM)',
					default: '',
					useVariables: true,
				},
			],
			callback: guarded(
				async (action, context) => {
					const raw = await context.parseVariablesInString(optString(action.options.time))
					const time = normalizeClockTime(raw)
					if (!time) {
						deps.log('warn', `Timer: End At needs a time like 14:30 or 2:30 PM, not "${raw.trim()}".`)
						return
					}
					await deps.api.timerEndAt(time)
				},
				deps,
				(err) => (err.status === 409 ? 'There is no active item to set an end time on.' : undefined),
			),
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
			options: [START_TIMER_OPTION, REPEAT_GUARD_OPTION],
			callback: guarded(async (action) => {
				if (deps.state.shouldIgnoreRepeat('planNext', Number(action.options.ignoreRepeatMs) || 0)) return
				await deps.api.planNext(startTimerOption(action.options))
			}, deps),
		},

		planPrevious: {
			name: 'Plan Previous',
			options: [START_TIMER_OPTION, REPEAT_GUARD_OPTION],
			callback: guarded(async (action) => {
				if (deps.state.shouldIgnoreRepeat('planPrevious', Number(action.options.ignoreRepeatMs) || 0)) return
				await deps.api.planPrevious(startTimerOption(action.options))
			}, deps),
		},

		waypointNext: {
			name: 'Go To Next Waypoint',
			description:
				'Jumps to the next waypoint ahead of the live item. Does nothing (with a warning) when there is none.',
			options: [START_TIMER_OPTION],
			callback: guarded(
				async (action) => {
					await deps.api.waypointNext(startTimerOption(action.options))
				},
				deps,
				(err) => (err.status === 409 ? 'There is no waypoint ahead of the live item.' : undefined),
			),
		},

		planJumpToRow: {
			name: 'Rundown: Jump to Row',
			description: 'Jumps to the item shown on this row of the current rundown page.',
			options: [{ type: 'number', id: 'rowIndex', label: 'Row (1-8)', default: 1, min: 1, max: RUNDOWN_ROWS }],
			callback: guarded(async (action) => {
				const item = deps.state.rundownRow(Number(action.options.rowIndex))
				if (item) await deps.api.setActiveItem(item.id)
			}, deps),
		},

		rundownPageUp: {
			name: 'Rundown: Previous Page',
			options: [],
			callback: guarded(() => {
				deps.state.pageRundown(-1)
				deps.refresh()
			}, deps),
		},

		rundownPageDown: {
			name: 'Rundown: Next Page',
			options: [],
			callback: guarded(() => {
				deps.state.pageRundown(1)
				deps.refresh()
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
				const itemId = optString(action.options.itemId)
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
					type: 'textinput',
					id: 'lengthInSeconds',
					label: 'Length (seconds, mm:ss or h:mm:ss; variables allowed)',
					default: '5:00',
					useVariables: true,
				},
				{
					type: 'checkbox',
					id: 'isDurationActual',
					label: 'Is Duration Actual',
					default: false,
				},
			],
			callback: guarded(async (action) => {
				const title = optString(action.options.title)
				const itemType = optString(action.options.itemType)
				const lengthInSeconds = lengthFromOption(optString(action.options.lengthInSeconds), { allowEmpty: false }) ?? 0
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
					type: 'textinput',
					id: 'lengthInSeconds',
					label: 'Length (seconds, mm:ss or h:mm:ss; variables allowed; empty or 0 leaves it unchanged)',
					default: '',
					useVariables: true,
				},
				{
					type: 'dropdown',
					id: 'noteCategoryId',
					label: 'Note category (leave empty to keep notes unchanged)',
					choices: [{ id: '', label: '— leave notes unchanged —' }, ...noteCategoryChoices],
					default: '',
					allowCustom: true,
				},
				{
					type: 'textinput',
					id: 'noteText',
					label: 'Note text for that category (empty clears it)',
					default: '',
					useVariables: true,
					isVisibleExpression: '$(options:noteCategoryId) != ""',
				},
			],
			callback: guarded(async (action) => {
				const itemId = optString(action.options.itemId)
				const title = optString(action.options.title)
				const itemType = optString(action.options.itemType)
				const lengthInSeconds = lengthFromOption(optString(action.options.lengthInSeconds), { allowEmpty: true })
				const noteCategoryId = optString(action.options.noteCategoryId)

				const body: PlanItemUpdateBody = {}
				if (title) body.title = title
				if (itemType) body.itemType = itemType
				if (lengthInSeconds) body.lengthInSeconds = lengthInSeconds
				if (noteCategoryId) {
					const held = deps.state.plan?.items.find((i) => i.id === itemId)?.notes ?? {}
					body.notes = { ...held, [noteCategoryId]: optString(action.options.noteText) }
				}

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
				const itemId = optString(action.options.itemId)
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
				const itemId = optString(action.options.itemId)
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
				const itemIds = optString(action.options.itemIds)
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
				const text = optString(action.options.text)
				const title = optString(action.options.title)
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
					isVisibleExpression: '!$(options:clear)',
				},
				{
					type: 'checkbox',
					id: 'clear',
					label: 'Clear selection',
					default: false,
				},
			],
			callback: guarded(async (action) => {
				const serviceTypeId = optString(action.options.serviceTypeId)
				await deps.api.selectPcoServiceType(action.options.clear === true ? null : serviceTypeId)
			}, deps),
		},

		pcoSetDefaultServiceType: {
			name: 'Planning Center Set Default Service Type',
			description: 'Remembers a service type for next time. Tick Clear default to forget it.',
			options: [
				{
					type: 'dropdown',
					id: 'serviceTypeId',
					label: 'Service Type',
					choices: serviceTypeChoices,
					default: serviceTypeChoices[0]?.id ?? '',
					allowCustom: true,
					isVisibleExpression: '!$(options:clear)',
				},
				{
					type: 'checkbox',
					id: 'clear',
					label: 'Clear default',
					default: false,
				},
			],
			callback: guarded(async (action) => {
				const serviceTypeId = optString(action.options.serviceTypeId)
				await deps.api.setPcoDefaultServiceType(action.options.clear === true ? null : serviceTypeId)
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
				const filter = optString(action.options.filter)
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
				const serviceTypeId = optString(action.options.serviceTypeId)
				const planId = optString(action.options.planId)
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
					type: 'dropdown',
					id: 'senderRoleId',
					label: 'Send As Role',
					choices: [{ id: '', label: 'The Producer' }, ...roleChoices],
					default: '',
					allowCustom: true,
				},
				{
					type: 'checkbox',
					id: 'isHighPriority',
					label: 'High Priority',
					default: false,
				},
			],
			callback: guarded(async (action) => {
				const text = optString(action.options.text)
				const targetRoleId = optString(action.options.targetRoleId)
				const senderRoleId = optString(action.options.senderRoleId)
				const isHighPriority = Boolean(action.options.isHighPriority)
				await deps.api.sendMessage({
					text,
					targetRoleId: targetRoleId || undefined,
					senderRoleId: senderRoleId || undefined,
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
				const mode = optString(action.options.mode)
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
				const name = optString(action.options.name)
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
					isVisibleExpression: '!$(options:clearPerson)',
				},
				{
					type: 'checkbox',
					id: 'clearPerson',
					label: 'Clear the assigned person',
					default: false,
				},
				{
					type: 'checkbox',
					id: 'setNoteCategories',
					label: 'Replace the assigned note categories',
					default: false,
				},
				{
					type: 'multidropdown',
					id: 'assignedNoteCategories',
					label: 'Assigned note categories (none selected clears them)',
					choices: noteCategoryChoices,
					default: [],
					isVisibleExpression: '$(options:setNoteCategories)',
				},
			],
			callback: guarded(async (action) => {
				const roleId = optString(action.options.roleId)
				const name = optString(action.options.name)
				const personName = optString(action.options.personName)

				const body: RoleUpdateBody = {}
				if (name) body.name = name
				if (action.options.clearPerson === true) body.personName = ''
				else if (personName) body.personName = personName
				if (action.options.setNoteCategories === true) {
					const selected = action.options.assignedNoteCategories
					body.assignedNoteCategories = Array.isArray(selected) ? selected.map(optString).filter(Boolean) : []
				}

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
				const roleId = optString(action.options.roleId)
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
				const ip = optString(action.options.ip)
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
			name: 'Network Set Master (deprecated)',
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
				const hourFormatThreshold = optString(action.options.hourFormatThreshold)
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
				const host = optString(action.options.host)
				await deps.api.setRelay({
					enabled,
					host: host || undefined,
				})
			}, deps),
		},

		timerActualToggle: {
			name: 'Toggle Projected/Actual (live item)',
			description:
				'Flips the live item between Projected and Actual. This is the transient override — it changes what the pagers show and is never written into the plan, so it goes stale as soon as a different item becomes active.',
			options: [],
			callback: guarded(async () => {
				const timer = deps.state.timer
				if (!timer) {
					deps.log('warn', 'No active plan item to toggle Projected/Actual on.')
					return
				}
				await deps.api.timerActualOverride(!timer.isDurationActualForDisplay)
			}, deps),
		},

		planToggleItemDurationActual: {
			name: 'Toggle Projected/Actual (plan item)',
			description:
				"Flips a plan item's own Projected/Actual flag. Unlike the live override this persists — it is the item's real duration type, and it comes back next time the plan loads.",
			options: [
				{
					type: 'dropdown',
					id: 'itemId',
					label: 'Plan Item (blank = the live item)',
					choices: planItemChoices,
					default: planItemChoices[0]?.id ?? '',
					allowCustom: true,
				},
			],
			callback: guarded(async (action) => {
				const requested = optString(action.options.itemId)
				const itemId = requested || deps.state.timer?.item.id
				if (!itemId) {
					deps.log('warn', 'No plan item selected and nothing is live.')
					return
				}
				const item = deps.state.plan?.items.find((i) => i.id === itemId)
				if (!item) {
					deps.log('warn', `Plan item ${itemId} is not in the plan currently loaded.`)
					return
				}
				await deps.api.setPlanItemDurationActual(itemId, !item.isDurationActual)
			}, deps),
		},

		dismissNotification: {
			name: 'Dismiss Standing Notification',
			description:
				'Takes the lower third down on every pager. Leaves the message history intact — use Clear Messages to wipe that.',
			options: [],
			callback: guarded(async () => {
				await deps.api.dismissNotification()
			}, deps),
		},

		waypointGo: {
			name: 'Go To Waypoint',
			description:
				'Jumps the service to whichever item carries this waypoint. Warns rather than fails silently when the waypoint is unassigned in this week\u2019s plan.',
			options: [
				{
					type: 'dropdown',
					id: 'waypoint',
					label: 'Waypoint',
					choices: waypointChoices,
					default: waypointChoices[0]?.id ?? '',
					allowCustom: true,
				},
				{
					type: 'checkbox',
					id: 'startTimer',
					label: 'Start the timer on arrival',
					default: true,
				},
			],
			callback: guarded(
				async (action) => {
					const ref = optString(action.options.waypoint)
					await deps.api.fireWaypoint(ref, startTimerOption(action.options))
				},
				deps,
				explainWaypointFailure,
			),
		},

		waypointAssign: {
			name: 'Assign Waypoint To Item',
			options: [
				{
					type: 'dropdown',
					id: 'waypoint',
					label: 'Waypoint',
					choices: waypointChoices,
					default: waypointChoices[0]?.id ?? '',
					allowCustom: true,
				},
				{
					type: 'dropdown',
					id: 'itemId',
					label: 'Plan Item (leave blank to unassign)',
					choices: planItemChoices,
					default: planItemChoices[0]?.id ?? '',
					allowCustom: true,
				},
			],
			callback: guarded(async (action) => {
				const ref = optString(action.options.waypoint)
				const itemId = optString(action.options.itemId)
				await deps.api.assignWaypoint(ref, itemId || null)
			}, deps),
		},

		waypointUnassign: {
			name: 'Unassign Waypoint',
			description: 'Takes the waypoint off whatever item carries it this week. The waypoint stays in the library.',
			options: [
				{
					type: 'dropdown',
					id: 'waypoint',
					label: 'Waypoint',
					choices: waypointChoices,
					default: waypointChoices[0]?.id ?? '',
					allowCustom: true,
				},
			],
			callback: guarded(async (action) => {
				await deps.api.assignWaypoint(optString(action.options.waypoint), null)
			}, deps),
		},

		waypointAssignToActiveItem: {
			name: 'Assign Waypoint To Active Item',
			description:
				'Tags whatever item is live right now with this waypoint — the one-press way to build a waypoint set during a rehearsal.',
			options: [
				{
					type: 'dropdown',
					id: 'waypoint',
					label: 'Waypoint',
					choices: waypointChoices,
					default: waypointChoices[0]?.id ?? '',
					allowCustom: true,
				},
			],
			callback: guarded(async (action) => {
				const ref = optString(action.options.waypoint)
				const activeId = deps.state.timer?.item.id
				if (!activeId) {
					deps.log('warn', 'No active plan item to assign a waypoint to.')
					return
				}
				await deps.api.assignWaypoint(ref, activeId)
			}, deps),
		},

		waypointCreate: {
			name: 'Create Waypoint',
			options: [
				{
					type: 'textinput',
					id: 'name',
					label: 'Name',
					default: '',
					useVariables: true,
				},
			],
			callback: guarded(async (action) => {
				const name = optString(action.options.name).trim()
				if (!name) {
					deps.log('warn', 'Create Waypoint needs a name.')
					return
				}
				await deps.api.createWaypoint(name)
			}, deps),
		},

		waypointRename: {
			name: 'Rename Waypoint',
			options: [
				{
					type: 'dropdown',
					id: 'waypoint',
					label: 'Waypoint',
					choices: waypointChoices,
					default: waypointChoices[0]?.id ?? '',
					allowCustom: true,
				},
				{
					type: 'textinput',
					id: 'name',
					label: 'New Name',
					default: '',
					useVariables: true,
				},
			],
			callback: guarded(async (action) => {
				const ref = optString(action.options.waypoint)
				const name = optString(action.options.name).trim()
				if (!name) {
					deps.log('warn', 'Rename Waypoint needs a new name.')
					return
				}
				await deps.api.updateWaypoint(ref, { name })
			}, deps),
		},

		waypointDelete: {
			name: 'Delete Waypoint',
			options: [
				{
					type: 'dropdown',
					id: 'waypoint',
					label: 'Waypoint',
					choices: waypointChoices,
					default: waypointChoices[0]?.id ?? '',
					allowCustom: true,
				},
			],
			callback: guarded(async (action) => {
				await deps.api.deleteWaypoint(optString(action.options.waypoint))
			}, deps),
		},

		planSetItemWaypoints: {
			name: 'Set Plan Item Waypoints',
			description: 'Replaces the complete set of waypoints an item carries. Comma-separated names or slugs.',
			options: [
				{
					type: 'dropdown',
					id: 'itemId',
					label: 'Plan Item',
					choices: planItemChoices,
					default: planItemChoices[0]?.id ?? '',
					allowCustom: true,
				},
				{
					type: 'textinput',
					id: 'waypoints',
					label: 'Waypoints (comma-separated, blank clears)',
					default: '',
					useVariables: true,
				},
			],
			callback: guarded(async (action) => {
				const itemId = optString(action.options.itemId)
				const raw = optString(action.options.waypoints)
				const waypoints = raw
					.split(',')
					.map((w: string) => w.trim())
					.filter((w: string) => w.length > 0)
				await deps.api.setPlanItemWaypoints(itemId, waypoints)
			}, deps),
		},

		scheduleCreate: {
			name: 'Create Schedule',
			description:
				'Adds a service schedule. Start time is ISO-8601 (2026-10-18T10:00:00-04:00); without an offset it is read as this machine\u2019s local time.',
			options: [
				{ type: 'textinput', id: 'title', label: 'Title', default: '', useVariables: true },
				{
					type: 'textinput',
					id: 'startsAt',
					label: 'Starts at (ISO-8601)',
					default: '',
					useVariables: true,
				},
				{
					type: 'number',
					id: 'minutes',
					label: 'Lead time (minutes before the start)',
					default: 30,
					min: 0,
					max: 720,
				},
				{
					type: 'dropdown',
					id: 'recurrence',
					label: 'Repeats',
					choices: SCHEDULE_RECURRENCES,
					default: 'once',
				},
				{ type: 'checkbox', id: 'isEnabled', label: 'Enabled', default: true },
			],
			callback: guarded(async (action) => {
				const title = optString(action.options.title).trim()
				if (!title) throw new Error('Create Schedule needs a title')
				const startsAt = isoWithoutFraction(optString(action.options.startsAt))
				if (!startsAt) throw new Error('Create Schedule needs a start time in ISO-8601, e.g. 2026-10-18T10:00:00-04:00')
				await deps.api.createSchedule({
					title,
					startsAt,
					goLiveOffsetMinutes: Number(action.options.minutes),
					recurrence: optString(action.options.recurrence) || 'once',
					isEnabled: action.options.isEnabled !== false,
				})
			}, deps),
		},

		eventTimeSetLive: {
			name: 'Set Live Event Time',
			description: 'Makes this event time (service time) the live one. The active item stays where it is.',
			options: [
				{
					type: 'dropdown',
					id: 'eventTimeId',
					label: 'Event time',
					choices: eventTimeChoices,
					default: eventTimeChoices[0]?.id ?? '',
					allowCustom: true,
				},
			],
			callback: guarded(
				async (action) => {
					const id = optString(action.options.eventTimeId).trim()
					if (!id) {
						deps.log('warn', 'Set Live Event Time needs an event time.')
						return
					}
					await deps.api.setLiveEventTime(id)
				},
				deps,
				(err) => (err.status === 404 ? 'That event time does not exist. Pick one from the list.' : undefined),
			),
		},

		eventTimeNext: {
			name: 'Next Event Time',
			description:
				'At the end of the run sheet, makes the next event time live and returns to the first item, paused. Warns when there is no next one.',
			options: [],
			callback: guarded(
				async () => {
					await deps.api.nextEventTime()
				},
				deps,
				(err) => (err.status === 409 ? 'There is no next event time.' : undefined),
			),
		},

		scheduleGoLive: {
			name: 'Bring Schedule Live Now',
			description: 'Loads a scheduled service immediately rather than waiting for its go-live time.',
			options: [
				{
					type: 'dropdown',
					id: 'scheduleId',
					label: 'Schedule',
					choices: scheduleChoices,
					default: scheduleChoices[0]?.id ?? '',
					allowCustom: true,
				},
			],
			callback: guarded(async (action) => {
				await deps.api.scheduleGoLive(optString(action.options.scheduleId))
			}, deps),
		},

		scheduleGoLiveNext: {
			name: 'Bring Next Schedule Live Now',
			description: 'Whichever service the app says is next — no dropdown to keep current as schedules come and go.',
			options: [],
			callback: guarded(async () => {
				const next = deps.state.nextSchedule
				if (!next) {
					deps.log('warn', 'No upcoming enabled schedule to bring live.')
					return
				}
				await deps.api.scheduleGoLive(next.id)
			}, deps),
		},

		scheduleSetEnabled: {
			name: 'Enable/Disable Schedule',
			options: [
				{
					type: 'dropdown',
					id: 'scheduleId',
					label: 'Schedule',
					choices: scheduleChoices,
					default: scheduleChoices[0]?.id ?? '',
					allowCustom: true,
				},
				{
					type: 'checkbox',
					id: 'isEnabled',
					label: 'Enabled',
					default: true,
				},
			],
			callback: guarded(async (action) => {
				await deps.api.updateSchedule(optString(action.options.scheduleId), {
					isEnabled: Boolean(action.options.isEnabled),
				})
			}, deps),
		},

		scheduleSetOffset: {
			name: 'Set Schedule Lead Time',
			description: 'How many minutes before the service start the app brings it up.',
			options: [
				{
					type: 'dropdown',
					id: 'scheduleId',
					label: 'Schedule',
					choices: scheduleChoices,
					default: scheduleChoices[0]?.id ?? '',
					allowCustom: true,
				},
				{
					type: 'number',
					id: 'minutes',
					label: 'Lead time (minutes)',
					default: 30,
					min: 0,
					max: 720,
				},
			],
			callback: guarded(async (action) => {
				await deps.api.updateSchedule(optString(action.options.scheduleId), {
					goLiveOffsetMinutes: Number(action.options.minutes),
				})
			}, deps),
		},

		scheduleDelete: {
			name: 'Delete Schedule',
			options: [
				{
					type: 'dropdown',
					id: 'scheduleId',
					label: 'Schedule',
					choices: scheduleChoices,
					default: scheduleChoices[0]?.id ?? '',
					allowCustom: true,
				},
			],
			callback: guarded(async (action) => {
				await deps.api.deleteSchedule(optString(action.options.scheduleId))
			}, deps),
		},
	}
}
