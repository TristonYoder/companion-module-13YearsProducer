// Pure unit tests for the Standby → Go! → Clear toggle cycle used by the
// cycleRoleCue action and the per-role "Cues — Toggle" preset.
//
//   npm run test:unit
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

const { nextCueStateInCycle } = await import('../dist/types.js')

describe('nextCueStateInCycle', () => {
	test('cycles Standby -> Go! -> Clear -> Standby', () => {
		assert.equal(nextCueStateInCycle('STANDBY'), 'GO')
		assert.equal(nextCueStateInCycle('GO'), 'OFF')
		assert.equal(nextCueStateInCycle('OFF'), 'STANDBY')
	})

	test('a flashing role advances like its base state instead of getting stuck', () => {
		assert.equal(nextCueStateInCycle('FLASH_STANDBY'), 'GO')
		assert.equal(nextCueStateInCycle('FLASH_GO'), 'OFF')
	})

	test('three presses in a row return to the starting state (the cycle is closed)', () => {
		let state = 'OFF'
		for (let i = 0; i < 3; i++) state = nextCueStateInCycle(state)
		assert.equal(state, 'OFF')
	})
})
