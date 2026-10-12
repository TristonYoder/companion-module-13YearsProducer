import type { ControlAPIState, DigestHashes, TimerAnchor } from './types.js'

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

/** Message ids, newest first (the order the snapshot already holds), joined with RS. */
export function canonicalMessages(state: Pick<ControlAPIState, 'messages'>): string {
	return state.messages.map((m) => m.id).join(RS)
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

export interface SyncSample {
	rtt: number
	/** Producer time minus local time. */
	offset: number
}

/** Samples kept; the one with the smallest round trip wins. */
export const SYNC_SAMPLE_COUNT = 8
/** Offset changes under this are slewed, anything larger is jumped. */
export const SYNC_SLEW_LIMIT_MS = 20
/** Share of a sub-limit change applied per new sample. */
export const SYNC_SLEW_FRACTION = 0.25

/**
 * NTP-style estimator of the producer's clock against this machine's.
 * `t0`/`t3` are local send/receive times, `t1`/`t2` the producer's
 * receive/send times, all epoch ms.
 */
export class ClockSync {
	private samples: SyncSample[] = []
	private current: number | null = null

	constructor(private clock: () => number = Date.now) {}

	/** `null` until the first sample lands. */
	get offsetMs(): number | null {
		return this.current
	}

	/** Round trip of the best sample held. */
	get rttMs(): number | null {
		return this.best()?.rtt ?? null
	}

	get hasOffset(): boolean {
		return this.current !== null
	}

	/** The producer's "now": this machine's clock plus the offset (the plain local clock before any sample). */
	producerNowMs(): number {
		return this.clock() + (this.current ?? 0)
	}

	reset(): void {
		this.samples = []
		this.current = null
	}

	addSample(t0: number, t1: number, t2: number, t3: number): SyncSample {
		const sample: SyncSample = {
			rtt: t3 - t0 - (t2 - t1),
			offset: (t1 - t0 + (t2 - t3)) / 2,
		}
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

	/** Smallest round trip; the newest of equals. */
	private best(): SyncSample | undefined {
		let best: SyncSample | undefined
		for (const sample of this.samples) {
			if (!best || sample.rtt <= best.rtt) best = sample
		}
		return best
	}
}
