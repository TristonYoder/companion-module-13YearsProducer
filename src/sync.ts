import { performance } from 'node:perf_hooks'
import type { ControlAPIState, DigestHashes, InterTeamMessage, TimerAnchor } from './types.js'

const FNV_OFFSET_BASIS = 0xcbf29ce484222325n
const FNV_PRIME = 0x100000001b3n

const US = '\u001f'
const RS = '\u001e'

export function fnv1a64(text: string): string {
	let hash = FNV_OFFSET_BASIS
	for (const byte of Buffer.from(text, 'utf8')) {
		hash ^= BigInt(byte)
		hash = BigInt.asUintN(64, hash * FNV_PRIME)
	}
	return hash.toString(16).padStart(16, '0')
}

const flag = (value: boolean): string => (value ? '1' : '0')

export function canonicalRoles(state: Pick<ControlAPIState, 'roles'>): string {
	return state.roles.map((r) => `${r.id}${US}${r.name}${US}${r.state}${RS}`).join('')
}

export function canonicalTimer(anchor: TimerAnchor | null | undefined): string {
	if (!anchor) return 'none'
	return [
		anchor.itemId,
		anchor.lengthInSeconds,
		flag(anchor.isRunning),
		flag(anchor.isDurationActual),
		anchor.elapsedMs,
		anchor.anchorMs,
	].join(US)
}

function compareBytes(a: string, b: string): number {
	return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'))
}

function timestampMs(message: Pick<InterTeamMessage, 'timestamp'>): number {
	const ms = Date.parse(message.timestamp)
	return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms
}

export function canonicalMessages(state: Pick<ControlAPIState, 'messages'>): string {
	return [...state.messages]
		.sort((a, b) => {
			const byTime = timestampMs(b) - timestampMs(a)
			if (byTime !== 0 && !Number.isNaN(byTime)) return byTime
			return compareBytes(a.id, b.id)
		})
		.slice(0, 16)
		.map((m) => m.id)
		.join(RS)
}

export function canonicalPlan(state: Pick<ControlAPIState, 'plan'>): string {
	const items = state.plan.items
		.map((i) => `${i.id}${US}${i.title}${US}${i.lengthInSeconds}${US}${flag(i.isDurationActual)}${RS}`)
		.join('')
	return `${items}${state.plan.activeItemIndex}`
}

export function computeHashes(state: ControlAPIState): DigestHashes {
	return {
		roles: fnv1a64(canonicalRoles(state)),
		timer: fnv1a64(canonicalTimer(state.timer?.anchor)),
		plan: fnv1a64(canonicalPlan(state)),
		messages: fnv1a64(canonicalMessages(state)),
	}
}

export function mismatchedSections(local: DigestHashes, remote: Partial<DigestHashes>): (keyof DigestHashes)[] {
	return (['roles', 'timer', 'plan', 'messages'] as const).filter(
		(key) => remote[key] !== undefined && remote[key] !== local[key],
	)
}

export function anchorElapsedMs(anchor: TimerAnchor, producerNowMs: number): number {
	const elapsed = anchor.elapsedMs + (anchor.isRunning ? producerNowMs - anchor.anchorMs : 0)
	return Math.max(0, elapsed)
}

export function anchorElapsedSeconds(anchor: TimerAnchor, producerNowMs: number): number {
	return Math.floor(anchorElapsedMs(anchor, producerNowMs) / 1000)
}

export function anchorRemainingSeconds(anchor: TimerAnchor, producerNowMs: number): number {
	return anchor.lengthInSeconds - anchorElapsedSeconds(anchor, producerNowMs)
}

export function msToNextBoundary(anchor: TimerAnchor, producerNowMs: number): number {
	const phase = (((producerNowMs - anchor.anchorMs) % 1000) + 1000) % 1000
	return 1000 - phase
}

const MONOTONIC_BASE = Date.now() - performance.now()
export function monotonicEpochNow(): number {
	return MONOTONIC_BASE + performance.now()
}

export interface SyncSample {
	rtt: number
	offset: number
	receivedAt: number
}

export const SYNC_SAMPLE_COUNT = 8
export const SYNC_SLEW_LIMIT_MS = 20
export const SYNC_SLEW_FRACTION = 0.25
export const SYNC_MAX_AGE_MS = 90_000
export const SYNC_MAX_RTT_MS = 10_000
export const SYNC_MAX_OFFSET_MS = 86_400_000
export const SYNC_DISCARD_FLOOR_MS = 50

export class ClockSync {
	private samples: SyncSample[] = []
	private current: number | null = null

	constructor(private clock: () => number = monotonicEpochNow) {}

	get offsetMs(): number | null {
		return this.current
	}

	get rttMs(): number | null {
		return this.best()?.rtt ?? null
	}

	get hasOffset(): boolean {
		return this.current !== null
	}

	producerNowMs(): number {
		return this.clock() + (this.current ?? 0)
	}

	reset(): void {
		this.samples = []
		this.current = null
	}

	addSample(t0: number, t1: number, t2: number, t3: number): SyncSample | null {
		const rtt = Math.max(0, t3 - t0 - (t2 - t1))
		const offset = (t1 - t0 + (t2 - t3)) / 2
		if (!Number.isFinite(rtt) || !Number.isFinite(offset)) return null
		if (rtt > SYNC_MAX_RTT_MS || Math.abs(offset) > SYNC_MAX_OFFSET_MS) return null

		const sample: SyncSample = { rtt, offset, receivedAt: t3 }
		this.samples = this.fresh()
		const held = this.best()
		if (held && Math.abs(offset - held.offset) > Math.max(SYNC_DISCARD_FLOOR_MS, 2 * rtt)) this.samples = []
		this.samples.push(sample)
		if (this.samples.length > SYNC_SAMPLE_COUNT) this.samples.shift()

		const target = this.best()?.offset ?? sample.offset
		if (this.current === null || Math.abs(target - this.current) >= SYNC_SLEW_LIMIT_MS) {
			this.current = target
		} else {
			this.current += (target - this.current) * SYNC_SLEW_FRACTION
		}
		return sample
	}

	private fresh(): SyncSample[] {
		const now = this.clock()
		return this.samples.filter((s) => now - s.receivedAt <= SYNC_MAX_AGE_MS)
	}

	private best(): SyncSample | undefined {
		let best: SyncSample | undefined
		for (const sample of this.fresh()) {
			if (!best || sample.rtt <= best.rtt) best = sample
		}
		return best
	}
}
