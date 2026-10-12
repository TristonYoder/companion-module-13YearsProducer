// Pure unit tests — no running Producer app required, unlike contract/.
//
//   npm run test:unit
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

const { ModuleState, slugify, uniqueRoleSlugs } = await import('../dist/state.js')

function role(id, name, overrides = {}) {
	return {
		id,
		name,
		personName: null,
		state: 'OFF',
		plotipharRoleId: null,
		lastUpdated: '2024-01-15T10:30:00Z',
		assignedNoteCategories: [],
		...overrides,
	}
}

function snapshot(overrides = {}) {
	return {
		appMode: 'PRODUCER_CONTROL',
		network: {
			isMasterServer: true,
			isLANConnected: true,
			isProducerLive: false,
			hasSyncedWithProducer: false,
			connectedMasterName: null,
			lanPort: 13380,
			relayEnabled: false,
			relayHost: '',
		},
		roles: [],
		selectedRoleIds: [],
		timer: null,
		plan: {
			title: null,
			items: [],
			activeItemIndex: 0,
			isAtEndOfPlan: false,
			canLoadNextService: false,
			pcoServiceTypeId: null,
			pcoPlanId: null,
		},
		messages: [],
		pco: {
			isConnected: false,
			userName: null,
			isLiveSyncEnabled: false,
			lastError: null,
			selectedServiceTypeId: null,
			defaultServiceTypeId: null,
			planFilter: 'all',
			serviceTypes: [],
			plans: [],
			noteCategories: [],
		},
		plotiphar: {
			pairingState: 'idle',
			pairingCode: null,
			pairingExpiresAt: null,
			pairingError: null,
			assignmentSyncStatus: 'notSynced',
			assignmentSyncEventId: null,
			assignmentSyncError: null,
			roles: [],
		},
		settings: { hourFormatThreshold: 'over1Hour', controlAPIPort: 13390, connectedAPIClients: 1 },
		...overrides,
	}
}

describe('slugify', () => {
	test('lowercases and underscores non-alphanumerics', () => {
		assert.equal(slugify('Stage Left Camera'), 'stage_left_camera')
	})

	test('strips leading/trailing separators', () => {
		assert.equal(slugify('  Host!!  '), 'host')
	})

	test('falls back to a placeholder for an all-punctuation name', () => {
		assert.equal(slugify('***'), 'role')
	})
})

describe('uniqueRoleSlugs', () => {
	test('assigns distinct slugs for distinct names', () => {
		const slugs = uniqueRoleSlugs([role('r1', 'Host'), role('r2', 'Operator')])
		assert.equal(slugs.get('r1'), 'host')
		assert.equal(slugs.get('r2'), 'operator')
	})

	test('appends a counter when two roles slugify identically', () => {
		const slugs = uniqueRoleSlugs([role('r1', 'Host'), role('r2', 'HOST'), role('r3', 'host')])
		assert.equal(slugs.get('r1'), 'host')
		assert.equal(slugs.get('r2'), 'host_2')
		assert.equal(slugs.get('r3'), 'host_3')
	})
})

describe('ModuleState', () => {
	test('getters return empty/null defaults before any snapshot arrives', () => {
		const state = new ModuleState()
		assert.deepEqual(state.roles, [])
		assert.deepEqual(state.selectedRoleIds, [])
		assert.equal(state.timer, null)
		assert.equal(state.plan, null)
		assert.equal(state.pco, null)
		assert.equal(state.isSocketConnected, false)
		assert.equal(state.nextPlanItem(), undefined)
		assert.deepEqual(state.roleChoices(), [])
	})

	test('applyState populates derived getters', () => {
		const state = new ModuleState()
		state.applyState(snapshot({ roles: [role('r1', 'Host', { state: 'GO' })], selectedRoleIds: ['r1'] }))
		assert.equal(state.roles.length, 1)
		assert.equal(state.roleById('r1').state, 'GO')
		assert.equal(state.isRoleSelected('r1'), true)
		assert.equal(state.isRoleSelected('nope'), false)
		assert.deepEqual(state.roleChoices(), [{ id: 'r1', label: 'Host' }])
	})

	test('nextPlanItem returns the item after the active index, or undefined at the end', () => {
		const state = new ModuleState()
		const items = [
			{
				id: 'a',
				title: 'Welcome',
				itemType: 'Item',
				sequence: 1,
				lengthInSeconds: 60,
				elapsedSeconds: 0,
				isRunning: false,
				servicePlanTitle: null,
				notes: {},
				noteIds: {},
				pcoServiceTypeId: null,
				pcoPlanId: null,
				isDurationActual: false,
			},
			{
				id: 'b',
				title: 'Worship',
				itemType: 'Song',
				sequence: 2,
				lengthInSeconds: 240,
				elapsedSeconds: 0,
				isRunning: false,
				servicePlanTitle: null,
				notes: {},
				noteIds: {},
				pcoServiceTypeId: null,
				pcoPlanId: null,
				isDurationActual: false,
			},
		]
		state.applyState(
			snapshot({
				plan: {
					title: 'Sunday',
					items,
					activeItemIndex: 0,
					isAtEndOfPlan: false,
					canLoadNextService: false,
					pcoServiceTypeId: null,
					pcoPlanId: null,
				},
			}),
		)
		assert.equal(state.nextPlanItem().id, 'b')

		state.applyState(
			snapshot({
				plan: {
					title: 'Sunday',
					items,
					activeItemIndex: 1,
					isAtEndOfPlan: true,
					canLoadNextService: false,
					pcoServiceTypeId: null,
					pcoPlanId: null,
				},
			}),
		)
		assert.equal(state.nextPlanItem(), undefined)
	})

	test('applyMessage records the latest message independently of state snapshots', () => {
		const state = new ModuleState()
		const message = {
			id: 'm1',
			sender: 'Producer',
			targetRoleId: null,
			senderRoleId: null,
			text: '30 seconds',
			timestamp: '2024-01-15T10:30:45Z',
			isHighPriority: true,
		}
		state.applyMessage(message)
		assert.equal(state.lastMessage.text, '30 seconds')
	})

	test('setSocketConnected flips isSocketConnected independently of the snapshot', () => {
		const state = new ModuleState()
		state.setSocketConnected(true)
		assert.equal(state.isSocketConnected, true)
		state.setSocketConnected(false)
		assert.equal(state.isSocketConnected, false)
	})
})
