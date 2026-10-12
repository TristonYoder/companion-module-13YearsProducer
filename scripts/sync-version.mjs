#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const PKG = join(root, 'package.json')
const MANIFEST = join(root, 'companion', 'manifest.json')
const SEMVER = /^\d+\.\d+\.\d+$/

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'))

function writeVersion(path, version) {
	const before = readFileSync(path, 'utf8')
	const after = before.replace(/("version"\s*:\s*)"[^"]*"/, `$1"${version}"`)
	if (before === after) return false
	writeFileSync(path, after)
	return true
}

function compare(a, b) {
	const [pa, pb] = [a.split('.').map(Number), b.split('.').map(Number)]
	for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i]
	return 0
}

const args = process.argv.slice(2)
const pkgVersion = readJson(PKG).version
const manifestVersion = readJson(MANIFEST).version

if (args.includes('--check')) {
	if (pkgVersion !== manifestVersion) {
		console.error(
			`[sync-version] drift: package.json is ${pkgVersion}, companion/manifest.json is ${manifestVersion}.\n` +
				`manifest.json is the version Companion shows users — run \`npm run sync-version -- <version>\` to realign.`,
		)
		process.exit(1)
	}
	console.log(`[sync-version] package.json and companion/manifest.json agree at ${pkgVersion}`)
	process.exit(0)
}

const target = args.find((a) => !a.startsWith('--'))
if (!target) {
	console.error('[sync-version] usage: sync-version.mjs <x.y.z> | --check')
	process.exit(1)
}
if (!SEMVER.test(target)) {
	console.error(`[sync-version] "${target}" is not a valid x.y.z version`)
	process.exit(1)
}

if (compare(target, pkgVersion) < 0) {
	console.error(
		`[sync-version] refusing to downgrade ${pkgVersion} -> ${target}.\n` +
			`Released versions can't be reissued; use a version past ${pkgVersion} instead.`,
	)
	process.exit(1)
}

const changed = [
	writeVersion(PKG, target) && 'package.json',
	writeVersion(MANIFEST, target) && 'companion/manifest.json',
].filter(Boolean)

console.log(
	changed.length ? `[sync-version] set ${changed.join(' and ')} to ${target}` : `[sync-version] already at ${target}`,
)
