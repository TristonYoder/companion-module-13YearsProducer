import type { SomeCompanionConfigField } from '@companion-module/base'

/** Sits beside the app's LAN cue port (13380) and producer-assign port (13381) — see ControlAPIServer.swift. */
export const DEFAULT_PORT = 13390

export interface ModuleConfig {
	host: string
	port: number
}

export function getConfigFields(): SomeCompanionConfigField[] {
	return [
		{
			type: 'static-text',
			id: 'info',
			label: 'About',
			width: 12,
			value:
				'The Control API is off by default — enable it in the app under Settings → Control API, on the Mac or iPad running the show. There is no authentication: anything that can reach this host/port can fire a cue or clear the plan, so only point this at a device on a trusted production network.',
		},
		{
			type: 'textinput',
			id: 'host',
			label: 'Producer Host / IP',
			tooltip:
				"The Mac or iPad's LAN address, shown in the app under Settings → Control API. Bonjour discovery exists (_13years-api._tcp) but macOS often refuses the registration, so this module always dials host:port directly.",
			width: 8,
			default: '',
			required: true,
		},
		{
			type: 'number',
			id: 'port',
			label: 'Port',
			tooltip: 'Default 13390.',
			width: 4,
			default: DEFAULT_PORT,
			min: 1,
			max: 65535,
			required: true,
		},
	]
}
