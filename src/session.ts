import type { ModuleState } from './state.js'
import { computeHashes, mismatchedSections, msToNextBoundary } from './sync.js'
import type { CommandReply, ControlAPIState, DigestData, SyncReplyData } from './types.js'

/** Samples in the burst right after connecting, spaced `SYNC_BURST_GAP_MS` apart. */
export const SYNC_BURST_COUNT = 5
export const SYNC_BURST_GAP_MS = 100
/** Steady-state sampling period after the burst. */
export const SYNC_INTERVAL_MS = 30000
/** How long `proto` / `sync` may go unanswered before the app is treated as not speaking v2. */
export const COMMAND_TIMEOUT_MS = 5000

export interface Scheduler {
	setTimeout(fn: () => void, ms: number): unknown
	clearTimeout(handle: unknown): void
}

const realScheduler: Scheduler = {
	setTimeout: (fn, ms) => setTimeout(fn, ms),
	clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

export interface SessionDeps {
	state: ModuleState
	/** The socket's command path (`ControlSocket.sendCommand`). */
	sendCommand: (op: string, body?: unknown) => Promise<CommandReply>
	/** One `GET /v1/state`. */
	fetchState: () => Promise<ControlAPIState>
	/** Hands a fetched snapshot to the module's rev-guarded snapshot path. */
	adopt: (snapshot: ControlAPIState) => void
	/** Something the variables/feedbacks derive from changed (the local timer ticked, an offset landed, v2 switched on or off). */
	onChange: () => void
	/** The negotiated protocol changed; the socket widens or restores its liveness deadline. */
	onProtocol?: (version: 1 | 2) => void
	log?: (level: 'debug' | 'info' | 'warn', message: string) => void
	scheduler?: Scheduler
}

/**
 * Per-connection driver of sync protocol v2 on the Control API socket:
 * negotiates `proto`, measures the clock offset with the `sync` op, runs the
 * timer locally from its anchor on second boundaries of the app's clock, and
 * answers a digest mismatch with one `GET /v1/state`.
 *
 * Every step degrades to the legacy behaviour: an app that does not answer
 * `proto` with 200 leaves `ModuleState.protoVersion` at 1 and this class idle.
 */
export class SyncSession {
	private scheduler: Scheduler
	private generation = 0
	private syncTimer: unknown
	private tickTimer: unknown
	private fetching = false

	constructor(private deps: SessionDeps) {
		this.scheduler = deps.scheduler ?? realScheduler
	}

	get isV2(): boolean {
		return this.deps.state.protoVersion === 2
	}

	/** Call when the socket opens. Resolves once negotiation is settled (not once syncing is done). */
	async start(): Promise<void> {
		this.stop()
		const generation = ++this.generation
		let acknowledged = false
		try {
			const reply = await this.command('proto', { version: 2 })
			acknowledged = reply.status === 200
		} catch (err) {
			this.log('debug', `proto negotiation failed, staying on legacy: ${err instanceof Error ? err.message : err}`)
		}
		if (generation !== this.generation || !acknowledged) return

		this.deps.state.setProtoVersion(2)
		this.deps.onProtocol?.(2)
		this.log('info', 'Control API sync protocol v2 enabled')
		this.deps.onChange()
		this.scheduleTick()
		void this.runBurst(generation)
	}

	/** Call when the socket closes or the module is torn down. */
	stop(): void {
		this.generation++
		if (this.syncTimer !== undefined) this.scheduler.clearTimeout(this.syncTimer)
		if (this.tickTimer !== undefined) this.scheduler.clearTimeout(this.tickTimer)
		this.syncTimer = undefined
		this.tickTimer = undefined
		this.fetching = false
		if (this.isV2) {
			this.deps.state.setProtoVersion(1)
			this.deps.onProtocol?.(1)
		}
	}

	// MARK: - Clock sync

	private async runBurst(generation: number): Promise<void> {
		for (let i = 0; i < SYNC_BURST_COUNT; i++) {
			if (i > 0) await this.sleep(SYNC_BURST_GAP_MS)
			if (generation !== this.generation) return
			await this.sample(generation)
		}
		this.scheduleSteadySync(generation)
	}

	private scheduleSteadySync(generation: number): void {
		this.syncTimer = this.scheduler.setTimeout(() => {
			void this.steadySample(generation)
		}, SYNC_INTERVAL_MS)
	}

	private async steadySample(generation: number): Promise<void> {
		if (generation !== this.generation) return
		await this.sample(generation)
		if (generation === this.generation) this.scheduleSteadySync(generation)
	}

	/** One request/response exchange. Failures are dropped: the previous offset stays in force. */
	async sample(generation = this.generation): Promise<void> {
		const { state } = this.deps
		const t0 = state.clock()
		try {
			const reply = await this.command('sync', { t0 })
			const t3 = state.clock()
			if (generation !== this.generation || reply.status !== 200) return
			const data = reply.data as Partial<SyncReplyData> | undefined
			if (!data || typeof data.t1 !== 'number' || typeof data.t2 !== 'number') return
			state.sync.addSample(t0, data.t1, data.t2, t3)
		} catch (err) {
			this.log('debug', `sync sample failed: ${err instanceof Error ? err.message : err}`)
			return
		}
		this.scheduleTick()
		this.deps.onChange()
	}

	// MARK: - Local timer

	/**
	 * (Re)arms the tick for the next second boundary of the running timer's
	 * anchor on the app's clock. Call after anything that can move the anchor
	 * or the offset; idle when there is nothing counting.
	 */
	scheduleTick(): void {
		if (this.tickTimer !== undefined) this.scheduler.clearTimeout(this.tickTimer)
		this.tickTimer = undefined
		const { state } = this.deps
		const anchor = state.timerAnchor
		if (!this.isV2 || !anchor || !anchor.isRunning) return
		const generation = this.generation
		this.tickTimer = this.scheduler.setTimeout(
			() => {
				this.tickTimer = undefined
				if (generation !== this.generation) return
				this.deps.onChange()
				this.scheduleTick()
			},
			msToNextBoundary(anchor, state.nowMs),
		)
	}

	// MARK: - Digest

	/**
	 * Compares the app's hashes with ones taken over the held snapshot. Any
	 * difference (or no snapshot at all) costs exactly one `GET /v1/state`,
	 * adopted through the usual rev guard; a digest older than what is held, or
	 * one that arrives while a fetch is in flight, is ignored.
	 */
	async handleDigest(digest: DigestData): Promise<void> {
		const { state } = this.deps
		if (!this.isV2 || this.fetching) return
		const snapshot = state.snapshot
		if (snapshot) {
			if (typeof digest.rev === 'number' && state.rev !== null && digest.rev < state.rev) return
			if (mismatchedSections(computeHashes(snapshot), digest.hashes ?? {}).length === 0) return
		}
		const generation = this.generation
		this.fetching = true
		try {
			const fresh = await this.deps.fetchState()
			if (generation === this.generation) this.deps.adopt(fresh)
		} catch (err) {
			this.log('warn', `Digest mismatch; GET /v1/state failed: ${err instanceof Error ? err.message : err}`)
		} finally {
			if (generation === this.generation) this.fetching = false
		}
	}

	// MARK: - Plumbing

	private async command(op: string, body: unknown): Promise<CommandReply> {
		return new Promise<CommandReply>((resolve, reject) => {
			const timeout = this.scheduler.setTimeout(() => reject(new Error(`${op} timed out`)), COMMAND_TIMEOUT_MS)
			this.deps.sendCommand(op, body).then(
				(reply) => {
					this.scheduler.clearTimeout(timeout)
					resolve(reply)
				},
				(err: unknown) => {
					this.scheduler.clearTimeout(timeout)
					reject(err instanceof Error ? err : new Error(String(err)))
				},
			)
		})
	}

	private async sleep(ms: number): Promise<void> {
		return new Promise((resolve) => this.scheduler.setTimeout(resolve, ms))
	}

	private log(level: 'debug' | 'info' | 'warn', message: string): void {
		this.deps.log?.(level, message)
	}
}
