import type { SomeCompanionConfigField } from '@companion-module/base'

export const DEFAULT_PORT = 13390

export interface ModuleConfig {
	host: string
	port: number
	overtimeRed?: boolean
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
				"The Mac or iPad's LAN address (shown in the app under Settings → Control API), or the hostname or IP of a headless Producer server, which can be on any network (for example over a VPN or Tailscale). The app also advertises the API over Bonjour (service _13years._tcp, TXT keys ip and apiport), but this module always dials host:port directly. Use just the address: no http://, path or port.",
			width: 8,
			default: '',
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
		},
		{
			type: 'checkbox',
			id: 'overtimeRed',
			label: 'Turn countdown buttons red in overtime',
			tooltip:
				'Applies to the countdown presets. Takes effect when the presets are rebuilt, which happens as soon as you save.',
			width: 12,
			default: true,
		},
	]
}
