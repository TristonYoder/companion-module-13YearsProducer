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
