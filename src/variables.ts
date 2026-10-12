import type { CompanionVariableDefinition, CompanionVariableValues } from '@companion-module/base'
import { RUNDOWN_ROWS, type ModuleState } from './state.js'
import { CUE_STATE_LABELS } from './types.js'

/**
 * Definitions are rebuilt on every snapshot, not just at init: roles, waypoints
 * and schedules are all producer-defined and change mid-service, and each one
 * gets its own variables so a button can be authored against a name instead of
 * an index.
 */
export function getVariableDefinitions(state: ModuleState): CompanionVariableDefinition[] {
	const definitions: CompanionVariableDefinition[] = [
		// Connection
		{ variableId: 'connection_status', name: 'Connection Status' },
		{ variableId: 'connection_stale', name: 'Connection Is Stale (connected, but no data lately)' },
		{ variableId: 'connected_api_clients', name: 'Connected Control API Clients' },
		{ variableId: 'network_is_producer_live', name: 'Producer Is Live' },
		{ variableId: 'network_is_lan_connected', name: 'LAN Connected' },
		{ variableId: 'network_connected_master_name', name: 'Connected Master Name' },
		{ variableId: 'network_lan_port', name: 'LAN Port' },
		{ variableId: 'relay_enabled', name: 'Cloud Relay Enabled' },
		{ variableId: 'relay_host', name: 'Cloud Relay Host' },

		// App
		{ variableId: 'app_mode', name: 'App Mode' },
		{ variableId: 'settings_hour_format_threshold', name: 'HH:MM:SS Formatting Threshold' },

		// Plan
		{ variableId: 'plan_title', name: 'Plan Title' },
		{ variableId: 'plan_item_count', name: 'Plan Item Count' },
		{ variableId: 'plan_item_index', name: 'Plan Item Index (1-based)' },
		{ variableId: 'plan_is_at_end', name: 'Plan Is At End' },
		{ variableId: 'plan_can_load_next_service', name: 'Can Load Next Service' },

		// Active item
		{ variableId: 'active_item_title', name: 'Active Item Title' },
		{ variableId: 'active_item_type', name: 'Active Item Type' },
		{ variableId: 'active_item_service_plan_title', name: 'Active Item Service Plan Title' },
		{ variableId: 'active_item_remaining', name: 'Active Item Time Remaining' },
		{ variableId: 'active_item_remaining_seconds', name: 'Active Item Time Remaining (Seconds)' },
		{ variableId: 'active_item_is_overtime', name: 'Active Item Is Overtime' },
		{ variableId: 'active_item_is_running', name: 'Active Item Is Running' },
		{ variableId: 'active_item_duration_type', name: 'Active Item Duration Type (Projected/Actual)' },
		{ variableId: 'next_item_title', name: 'Next Item Title' },
		{ variableId: 'next_item_type', name: 'Next Item Type' },
		{ variableId: 'next_item_length', name: 'Next Item Length' },
		{ variableId: 'active_item_progress_pct', name: 'Active Item Progress (0-100)' },

		// Service timing
		{ variableId: 'projected_end_time', name: 'Projected End Time (local HH:MM)' },
		{ variableId: 'service_remaining_total', name: 'Service Time Remaining (live item + everything after)' },
		{ variableId: 'service_over_under', name: 'Service Over/Under vs. Next Schedule (+ is over)' },

		// Rundown
		{ variableId: 'rundown_page', name: 'Rundown Page (1-based)' },
		{ variableId: 'rundown_page_count', name: 'Rundown Page Count' },

		// Timer entry keypad (this module's own buffer, not the app's)
		{ variableId: 'timer_entry_buffer', name: 'Timer Entry Buffer (what the keypad has typed)' },
		{ variableId: 'timer_entry_preview', name: 'Timer Entry Preview (what committing it would read)' },

		// Roles
		{ variableId: 'selected_role_names', name: 'Selected Role Names' },
		{ variableId: 'role_count', name: 'Role Count' },

		// Messages
		{ variableId: 'last_message_text', name: 'Last Message Text' },
		{ variableId: 'last_message_sender', name: 'Last Message Sender' },
		{ variableId: 'last_message_is_high_priority', name: 'Last Message Is High Priority' },
		{ variableId: 'message_count', name: 'Message Count' },
		{ variableId: 'notification_standing', name: 'Notification Is Standing' },

		// Planning Center
		{ variableId: 'pco_connected', name: 'Planning Center Connected' },
		{ variableId: 'pco_user_name', name: 'Planning Center User Name' },
		{ variableId: 'pco_live_sync_enabled', name: 'Planning Center Live Sync Enabled' },
		{ variableId: 'pco_plan_filter', name: 'Planning Center Plan Filter' },
		{ variableId: 'pco_last_error', name: 'Planning Center Last Error' },

		// Plotiphar
		{ variableId: 'plotiphar_pairing_state', name: 'Plotiphar Pairing State' },
		{ variableId: 'plotiphar_pairing_code', name: 'Plotiphar Pairing Code' },
		{ variableId: 'plotiphar_assignment_sync_status', name: 'Plotiphar Assignment Sync Status' },

		// Waypoints & schedules
		{ variableId: 'waypoint_count', name: 'Waypoint Count' },
		{ variableId: 'waypoints_assigned_count', name: 'Waypoints Assigned In This Plan' },
		{ variableId: 'schedule_count', name: 'Schedule Count' },
		{ variableId: 'next_schedule_title', name: 'Next Schedule Title' },
		{ variableId: 'next_schedule_starts_at', name: 'Next Schedule Starts At' },
		{ variableId: 'next_schedule_go_live_at', name: 'Next Schedule Goes Live At' },
		{ variableId: 'next_schedule_recurrence', name: 'Next Schedule Recurrence' },
	]

	for (let row = 1; row <= RUNDOWN_ROWS; row++) {
		definitions.push(
			{ variableId: `rundown_row_${row}_title`, name: `Rundown Row ${row} — title` },
			{ variableId: `rundown_row_${row}_length`, name: `Rundown Row ${row} — length` },
		)
	}

	const roleSlugs = state.roleSlugs()
	for (const role of state.roles) {
		const slug = roleSlugs.get(role.id)
		if (!slug) continue
		definitions.push(
			{ variableId: `role_${slug}_name`, name: `Role: ${role.name} — name` },
			{ variableId: `role_${slug}_state`, name: `Role: ${role.name} — cue state` },
			{ variableId: `role_${slug}_label`, name: `Role: ${role.name} — cue label` },
			{ variableId: `role_${slug}_person`, name: `Role: ${role.name} — assigned person` },
		)
	}

	// Keyed by the waypoint's own slug — the same token the API resolves and a
	// preset button is authored against, so `$(13years:waypoint_sermon_item)`
	// reads as the waypoint you pressed.
	for (const waypoint of state.waypoints) {
		definitions.push(
			{ variableId: `waypoint_${waypoint.slug}_item`, name: `Waypoint: ${waypoint.name} — assigned item` },
			{ variableId: `waypoint_${waypoint.slug}_assigned`, name: `Waypoint: ${waypoint.name} — is assigned` },
		)
	}

	return definitions
}

export function getVariableValues(state: ModuleState): CompanionVariableValues {
	const plotiphar = state.plotiphar
	const nextSchedule = state.nextSchedule
	const nextItem = state.nextPlanItem()

	const values: CompanionVariableValues = {
		connection_status: state.isSocketConnected ? 'connected' : 'disconnected',
		connection_stale: state.isStale ? 'yes' : 'no',
		connected_api_clients: state.settings?.connectedAPIClients ?? 0,
		network_is_producer_live: state.network?.isProducerLive ? 'yes' : 'no',
		network_is_lan_connected: state.network?.isLANConnected ? 'yes' : 'no',
		network_connected_master_name: state.network?.connectedMasterName ?? '',
		network_lan_port: state.network?.lanPort ?? 0,
		relay_enabled: state.network?.relayEnabled ? 'yes' : 'no',
		relay_host: state.network?.relayHost ?? '',

		app_mode: state.snapshot?.appMode ?? '',
		settings_hour_format_threshold: state.settings?.hourFormatThreshold ?? '',

		plan_title: state.plan?.title ?? '',
		plan_item_count: state.plan?.items.length ?? 0,
		plan_item_index: state.plan ? state.plan.activeItemIndex + 1 : 0,
		plan_is_at_end: state.plan?.isAtEndOfPlan ? 'yes' : 'no',
		plan_can_load_next_service: state.plan?.canLoadNextService ? 'yes' : 'no',

		active_item_title: state.timer?.item.title ?? '',
		active_item_type: state.timer?.item.itemType ?? '',
		active_item_service_plan_title: state.timer?.item.servicePlanTitle ?? '',
		active_item_remaining: state.timer?.formattedRemaining ?? '',
		active_item_remaining_seconds: state.timer?.remainingSeconds ?? 0,
		active_item_is_overtime: state.timer?.isOvertime ? 'yes' : 'no',
		active_item_is_running: state.timer?.isRunning ? 'yes' : 'no',
		active_item_duration_type: state.timer?.isDurationActualForDisplay ? 'Actual' : 'Projected',
		next_item_title: state.nextPlanItem()?.title ?? '',
		next_item_type: state.nextPlanItem()?.itemType ?? '',
		next_item_length: nextItem ? state.formatSeconds(nextItem.lengthInSeconds) : '',
		active_item_progress_pct: state.activeItemProgressPct,

		projected_end_time: state.projectedEndText,
		service_remaining_total:
			state.serviceRemainingSeconds === null ? '' : state.formatSeconds(state.serviceRemainingSeconds),
		service_over_under: state.serviceOverUnderText,

		rundown_page: state.rundownPageIndex + 1,
		rundown_page_count: state.rundownPageCount,

		// Both blank when nothing is typed, deliberately — the app's own popover
		// leaves its preview line blank rather than showing an error for
		// half-typed input, and a blank readout button reads the same way.
		timer_entry_buffer: state.timerEntryBuffer,
		timer_entry_preview: state.timerEntryPreview,

		selected_role_names: state.selectedRoleIds
			.map((id) => state.roleById(id)?.name)
			.filter((name): name is string => name !== undefined)
			.join(', '),
		role_count: state.roles.length,

		last_message_text: state.lastMessage?.text ?? '',
		last_message_sender: state.lastMessage?.sender ?? '',
		last_message_is_high_priority: state.lastMessage?.isHighPriority ? 'yes' : 'no',
		message_count: state.snapshot?.messages.length ?? 0,
		notification_standing: state.hasStandingNotification ? 'yes' : 'no',

		pco_connected: state.pco?.isConnected ? 'yes' : 'no',
		pco_user_name: state.pco?.userName ?? '',
		pco_live_sync_enabled: state.pco?.isLiveSyncEnabled ? 'yes' : 'no',
		pco_plan_filter: state.pco?.planFilter ?? '',
		pco_last_error: state.pco?.lastError ?? '',

		plotiphar_pairing_state: plotiphar?.pairingState ?? '',
		plotiphar_pairing_code: plotiphar?.pairingCode ?? '',
		plotiphar_assignment_sync_status: plotiphar?.assignmentSyncStatus ?? '',

		waypoint_count: state.waypoints.length,
		waypoints_assigned_count: state.waypoints.filter((w) => w.itemId != null).length,
		schedule_count: state.scheduleEntries.length,
		next_schedule_title: nextSchedule?.title ?? '',
		next_schedule_starts_at: nextSchedule?.startsAt ?? '',
		next_schedule_go_live_at: nextSchedule?.goLiveAt ?? '',
		next_schedule_recurrence: nextSchedule?.recurrence ?? '',
	}

	for (let row = 1; row <= RUNDOWN_ROWS; row++) {
		const item = state.rundownRow(row)
		values[`rundown_row_${row}_title`] = item?.title ?? ''
		values[`rundown_row_${row}_length`] = item ? state.formatSeconds(item.lengthInSeconds) : ''
	}

	const roleSlugs = state.roleSlugs()
	for (const role of state.roles) {
		const slug = roleSlugs.get(role.id)
		if (!slug) continue
		values[`role_${slug}_name`] = role.name
		values[`role_${slug}_state`] = role.state
		values[`role_${slug}_label`] = CUE_STATE_LABELS[role.state]
		values[`role_${slug}_person`] = role.personName ?? ''
	}

	for (const waypoint of state.waypoints) {
		values[`waypoint_${waypoint.slug}_item`] = waypoint.itemTitle ?? ''
		values[`waypoint_${waypoint.slug}_assigned`] = waypoint.itemId ? 'yes' : 'no'
	}

	return values
}
