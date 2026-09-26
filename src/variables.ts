import type { CompanionVariableDefinition, CompanionVariableValues } from '@companion-module/base'
import type { ModuleState } from './state'
import { CUE_STATE_LABELS } from './types'

export function getVariableDefinitions(state: ModuleState): CompanionVariableDefinition[] {
	const definitions: CompanionVariableDefinition[] = [
		// Fixed variables
		{ variableId: 'connection_status', name: 'Connection Status' },
		{ variableId: 'connected_api_clients', name: 'Connected Control API Clients' },
		{ variableId: 'app_mode', name: 'App Mode' },
		{ variableId: 'plan_title', name: 'Plan Title' },
		{ variableId: 'plan_item_count', name: 'Plan Item Count' },
		{ variableId: 'plan_item_index', name: 'Plan Item Index (1-based)' },
		{ variableId: 'plan_is_at_end', name: 'Plan Is At End' },
		{ variableId: 'active_item_title', name: 'Active Item Title' },
		{ variableId: 'active_item_type', name: 'Active Item Type' },
		{ variableId: 'active_item_service_plan_title', name: 'Active Item Service Plan Title' },
		{ variableId: 'active_item_remaining', name: 'Active Item Time Remaining' },
		{ variableId: 'active_item_remaining_seconds', name: 'Active Item Time Remaining (Seconds)' },
		{ variableId: 'active_item_is_overtime', name: 'Active Item Is Overtime' },
		{ variableId: 'active_item_is_running', name: 'Active Item Is Running' },
		{ variableId: 'timer_entry_buffer', name: 'Timer Entry Buffer (what the keypad has typed)' },
		{ variableId: 'timer_entry_preview', name: 'Timer Entry Preview (what committing it would read)' },
		{ variableId: 'next_item_title', name: 'Next Item Title' },
		{ variableId: 'next_item_type', name: 'Next Item Type' },
		{ variableId: 'selected_role_names', name: 'Selected Role Names' },
		{ variableId: 'last_message_text', name: 'Last Message Text' },
		{ variableId: 'last_message_sender', name: 'Last Message Sender' },
		{ variableId: 'last_message_is_high_priority', name: 'Last Message Is High Priority' },
		{ variableId: 'pco_connected', name: 'Planning Center Connected' },
		{ variableId: 'pco_user_name', name: 'Planning Center User Name' },
		{ variableId: 'pco_live_sync_enabled', name: 'Planning Center Live Sync Enabled' },
		{ variableId: 'network_is_producer_live', name: 'Producer Is Live' },
		{ variableId: 'network_is_lan_connected', name: 'LAN Connected' },
	]

	// Dynamic per-role variables
	const roleSlugs = state.roleSlugs()
	for (const role of state.roles) {
		const slug = roleSlugs.get(role.id)
		if (slug) {
			definitions.push(
				{ variableId: `role_${slug}_name`, name: `Role: ${role.name} — name` },
				{ variableId: `role_${slug}_state`, name: `Role: ${role.name} — cue state` },
				{ variableId: `role_${slug}_label`, name: `Role: ${role.name} — cue label` },
				{ variableId: `role_${slug}_person`, name: `Role: ${role.name} — assigned person` },
			)
		}
	}

	return definitions
}

export function getVariableValues(state: ModuleState): CompanionVariableValues {
	const values: CompanionVariableValues = {
		// Fixed variables
		connection_status: state.isSocketConnected ? 'connected' : 'disconnected',
		connected_api_clients: state.settings?.connectedAPIClients ?? 0,
		app_mode: state.snapshot?.appMode ?? '',
		plan_title: state.plan?.title ?? '',
		plan_item_count: state.plan?.items.length ?? 0,
		plan_item_index: state.plan ? state.plan.activeItemIndex + 1 : 0,
		plan_is_at_end: state.plan?.isAtEndOfPlan ? 'yes' : 'no',
		active_item_title: state.timer?.item.title ?? '',
		active_item_type: state.timer?.item.itemType ?? '',
		active_item_service_plan_title: state.timer?.item.servicePlanTitle ?? '',
		active_item_remaining: state.timer?.formattedRemaining ?? '',
		active_item_remaining_seconds: state.timer?.remainingSeconds ?? 0,
		active_item_is_overtime: state.timer?.isOvertime ? 'yes' : 'no',
		active_item_is_running: state.timer?.isRunning ? 'yes' : 'no',
		// The keypad's "screen": the raw buffer over what it resolves to. Both are
		// blank when nothing is typed, deliberately — the app's popover leaves
		// its preview line blank rather than showing an error for half-typed
		// input, and a blank readout button reads the same way.
		timer_entry_buffer: state.timerEntryBuffer,
		timer_entry_preview: state.timerEntryPreview,
		next_item_title: state.nextPlanItem()?.title ?? '',
		next_item_type: state.nextPlanItem()?.itemType ?? '',
		selected_role_names: state.selectedRoleIds
			.map((id) => state.roleById(id)?.name)
			.filter((name): name is string => name !== undefined)
			.join(', '),
		last_message_text: state.lastMessage?.text ?? '',
		last_message_sender: state.lastMessage?.sender ?? '',
		last_message_is_high_priority: state.lastMessage?.isHighPriority ? 'yes' : 'no',
		pco_connected: state.pco?.isConnected ? 'yes' : 'no',
		pco_user_name: state.pco?.userName ?? '',
		pco_live_sync_enabled: state.pco?.isLiveSyncEnabled ? 'yes' : 'no',
		network_is_producer_live: state.network?.isProducerLive ? 'yes' : 'no',
		network_is_lan_connected: state.network?.isLANConnected ? 'yes' : 'no',
	}

	// Dynamic per-role variables
	const roleSlugs = state.roleSlugs()
	for (const role of state.roles) {
		const slug = roleSlugs.get(role.id)
		if (slug) {
			values[`role_${slug}_name`] = role.name
			values[`role_${slug}_state`] = role.state
			values[`role_${slug}_label`] = CUE_STATE_LABELS[role.state]
			values[`role_${slug}_person`] = role.personName ?? ''
		}
	}

	return values
}
