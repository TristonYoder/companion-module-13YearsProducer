// Pure unit tests for the Standby → Go! → Clear toggle cycle used by the
// cycleRoleCue action and the per-role "Cues — Toggle" preset.
//
//   npm run test:unit
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

const { nextCueStateInCycle, CUE_STATES } = await import('../dist/types.js')

describe('nextCueStateInCycle', () => {
	test('cycles Standby -> Go! -> Clear -> Standby', () => {
		assert.equal(nextCueStateInCycle('STANDBY'), 'GO')
		assert.equal(nextCueStateInCycle('GO'), 'OFF')
		assert.equal(nextCueStateInCycle('OFF'), 'STANDBY')
	})

	test('the FLASH_* states the app deleted are gone from the cycle', () => {
		// CueState.swift dropped FLASH_STANDBY/FLASH_GO outright, so the router
		// 400s on either. They used to be cycle entries here; this asserts they
		// stay gone rather than quietly coming back as unpressable buttons.
		assert.equal(nextCueStateInCycle('FLASH_STANDBY'), undefined)
		assert.equal(nextCueStateInCycle('FLASH_GO'), undefined)
		assert.deepEqual(CUE_STATES, ['OFF', 'STANDBY', 'GO'])
	})

	test('three presses in a row return to the starting state (the cycle is closed)', () => {
		let state = 'OFF'
		for (let i = 0; i < 3; i++) state = nextCueStateInCycle(state)
		assert.equal(state, 'OFF')
	})
})
