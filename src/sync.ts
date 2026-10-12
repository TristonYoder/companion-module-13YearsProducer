import { performance } from 'node:perf_hooks'
import type { ControlAPIState, DigestHashes, InterTeamMessage, TimerAnchor } from './types.js'

// Sync protocol v2 building blocks (Server/PROTOCOL-V2.md in the app repo):
// the hash, the canonical strings it is taken over, the clock-offset estimator
// and the anchor arithmetic. Everything here is pure.

const FNV_OFFSET_BASIS = 0xcbf29ce484222325n
const FNV_PRIME = 0x100000001b3n

/** Unit separator between fields. */
const US = '\u001f'
/** Record separator between rows. */
const RS = '\u001e'

/** FNV-1a 64-bit over the UTF-8 bytes of `text`, as exactly 16 lowercase hex digits. */
export function fnv1a64(text: string): string {
	let hash = FNV_OFFSET_BASIS
	for (const byte of Buffer.from(text, 'utf8')) {
		hash ^= BigInt(byte)
		hash = BigInt.asUintN(64, hash * FNV_PRIME)
	}
	return hash.toString(16).padStart(16, '0')
}

const flag = (value: boolean): string => (value ? '1' : '0')

/** `id` US `name` US `state` RS, per role in array order. */
export function canonicalRoles(state: Pick<ControlAPIState, 'roles'>): string {
	return state.roles.map((r) => `${r.id}${US}${r.name}${US}${r.state}${RS}`).join('')
}

/** `none` without an active item, else the anchor's fields. */
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

/** Byte-wise (UTF-8) ordering of two strings, which is not what `<` does for characters outside the BMP. */
function compareBytes(a: string, b: string): number {
	return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'))
}

/** Epoch ms of an ISO-8601 timestamp; `NaN` sorts last (oldest). */
function timestampMs(message: Pick<InterTeamMessage, 'timestamp'>): number {
	const ms = Date.parse(message.timestamp)
	return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms
}

/**
 * Message ids ordered by `timestamp` descending, ties broken by `id`
 * ascending in byte order (PROTOCOL-V2.md, v2.1), joined with RS. The order
 * is imposed here rather than trusted from the snapshot, so a thread held in
 * arrival order hashes the same as the app's.
 */
export function canonicalMessages(state: Pick<ControlAPIState, 'messages'>): string {
	return [...state.messages]
		.sort((a, b) => {
			const byTime = timestampMs(b) - timestampMs(a)
			if (byTime !== 0 && !Number.isNaN(byTime)) return byTime
			return compareBytes(a.id, b.id)
		})
		.map((m) => m.id)
		.join(RS)
}

/** Each item as `id` US `title` US `length` US `isActual` RS, then the active index. */
export function canonicalPlan(state: Pick<ControlAPIState, 'plan'>): string {
	const items = state.plan.items
		.map((i) => `${i.id}${US}${i.title}${US}${i.lengthInSeconds}${US}${flag(i.isDurationActual)}${RS}`)
		.join('')
	return `${items}${state.plan.activeItemIndex}`
}

/** The four section hashes of a held snapshot, the same way the app hashes its own. */
export function computeHashes(state: ControlAPIState): DigestHashes {
	return {
		roles: fnv1a64(canonicalRoles(state)),
		timer: fnv1a64(canonicalTimer(state.timer?.anchor)),
		plan: fnv1a64(canonicalPlan(state)),
		messages: fnv1a64(canonicalMessages(state)),
	}
}

/** Names of the sections whose hash differs. A section the digest leaves out is not compared. */
export function mismatchedSections(local: DigestHashes, remote: Partial<DigestHashes>): (keyof DigestHashes)[] {
	return (['roles', 'timer', 'plan', 'messages'] as const).filter(
		(key) => remote[key] !== undefined && remote[key] !== local[key],
	)
}

// MARK: - Anchor

/** Elapsed ms at producer time `producerNowMs`, never below 0. */
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

/**
 * Milliseconds until the next displayed digit flips: the next
 * `anchorMs + k * 1000` on the producer clock strictly after `producerNowMs`.
 * Always in (0, 1000].
 */
export function msToNextBoundary(anchor: TimerAnchor, producerNowMs: number): number {
	const phase = (((producerNowMs - anchor.anchorMs) % 1000) + 1000) % 1000
	return 1000 - phase
}

// MARK: - Clock offset

/**
 * Milliseconds since the epoch, but advanced by the monotonic clock: the wall
 * clock is read once at start-up and `performance.now()` carries it forward.
 * A system clock step (NTP, a manual change) cannot move it, so a measured
 * offset against it stays valid; sleep, which pauses the monotonic clock,
 * is what `SyncSession.checkWake` watches for.
 */
const MONOTONIC_BASE = Date.now() - performance.now()
export function monotonicEpochNow(): number {
	return MONOTONIC_BASE + performance.now()
}

export interface SyncSample {
	rtt: number
	/** Producer time minus local time. */
	offset: number
	/** Local monotonic time the reply arrived (`t3`), which is what ages it. */
	receivedAt: number
}

/** Samples kept; the one with the smallest round trip wins. */
export const SYNC_SAMPLE_COUNT = 8
/** Offset changes under this are slewed, anything larger is jumped. */
export const SYNC_SLEW_LIMIT_MS = 20
/** Share of a sub-limit change applied per new sample. */
export const SYNC_SLEW_FRACTION = 0.25
/** A sample older than this is ignored. */
export const SYNC_MAX_AGE_MS = 90_000
/** A reply that took longer than this is ignored. */
export const SYNC_MAX_RTT_MS = 10_000
/** An offset beyond a day is a bogus reply, not a clock. */
export const SYNC_MAX_OFFSET_MS = 86_400_000
/** A fresh offset further than `max(this, 2 * rtt)` from the held best means the older samples are no longer true. */
export const SYNC_DISCARD_FLOOR_MS = 50

/**
 * NTP-style estimator of the producer's clock against this machine's.
 * `t0`/`t3` are local send/receive times on the monotonic clock, `t1`/`t2`
 * the producer's receive/send times, all epoch ms.
 */
export class ClockSync {
	private samples: SyncSample[] = []
	private current: number | null = null

	constructor(private clock: () => number = monotonicEpochNow) {}

	/** `null` until the first sample lands. */
	get offsetMs(): number | null {
		return this.current
	}

	/** Round trip of the best sample still young enough to count; `null` when none is. */
	get rttMs(): number | null {
		return this.best()?.rtt ?? null
	}

	get hasOffset(): boolean {
		return this.current !== null
	}

	/** The producer's "now": this machine's monotonic clock plus the offset (the plain local clock before any sample). */
	producerNowMs(): number {
		return this.clock() + (this.current ?? 0)
	}

	reset(): void {
		this.samples = []
		this.current = null
	}

	/** Returns `null` for a reply that is ignored (absurd round trip or offset). */
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

	/** Smallest round trip among the young samples; the newest of equals. */
	private best(): SyncSample | undefined {
		let best: SyncSample | undefined
		for (const sample of this.fresh()) {
			if (!best || sample.rtt <= best.rtt) best = sample
		}
		return best
	}
}
