// @ts-check

import { generateEslintConfig } from '@companion-module/tools/eslint/config.mjs'

export default generateEslintConfig({
	enableTypescript: true,
	typescriptRules: {
		'n/no-missing-import': 'off',
		'n/no-unsupported-features/node-builtins': 'warn',
	},
})
