// @ts-check

import { generateEslintConfig } from '@companion-module/tools/eslint/config.mjs'

export default generateEslintConfig({
	enableTypescript: true,
	typescriptRules: {
		// tsc already resolves every extensionless TS import at build time, so this
		// rule is pure noise here: eslint-plugin-n's resolver doesn't understand
		// TypeScript's extensionless module resolution and flags real, working imports.
		'n/no-missing-import': 'off',
		// Real portability finding: engines.node allows Node 18.12+, but global fetch
		// was experimental before Node 21. Kept visible as a warning rather than
		// silenced — resolving it (bump engines vs. swap fetch) is a maintainer call.
		'n/no-unsupported-features/node-builtins': 'warn',
	},
})
