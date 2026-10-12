import { MAX_REV_JUMP, type ModuleState } from './state.js'
import { computeHashes, mismatchedSections, msToNextBoundary } from './sync.js'
import type { CommandReply, ControlAPIState, DigestData, SyncReplyData } from './types.js'

/** Samples in the burst right after connecting, spaced `SYNC_BURST_GAP_MS` apart. */
export const SYNC_BURST_COUNT = 5
export const SYNC_BURST_GAP_MS = 100
/** Steady-state sampling period after the burst. */
export const SYNC_INTERVAL_MS = 30000
/** How long `proto` / `sync` may go unanswered before the app is treated as not speaking v2. */
export const COMMAND_TIMEOUT_MS = 5000
/** The 1 s housekeeping tick finding the wall clock moved by more than this against the monotonic one (sleep, a clock step) restarts clock sync. */
export const WAKE_DRIFT_MS = 2000
/** ... and so does a gap this long between ticks, whatever the cause. */
export const WAKE_GAP_MS = 5000

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
	/** Hands a fetched catch-up snapshot to the module's rev-guarded snapshot path (which rebases the gate to accept an equal rev). */
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
	/** Bumped whenever the clock-sync run is cancelled or restarted, so a burst or reply from before the restart is dropped. */
	private syncGeneration = 0
	private lastTick: { wall: number; mono: number } | null = null
	private syncTimer: unknown
	private tickTimer: unknown
	private fetching = false

	constructor(private deps: SessionDeps) {
		this.scheduler = deps.scheduler ?? realScheduler
		deps.state.onEpochChange = (needsState) => this.handleEpochChange(needsState)
	}

	get isV2(): boolean {
		return this.deps.state.protoVersion === 2
	}

	/** Call when the socket opens. Resolves once negotiation is settled (not once syncing is done). */
	async start(): Promise<void> {
		this.stop()
		const generation = ++this.generation
		this.deps.state.sync.reset()
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
		void this.runBurst(generation, this.syncGeneration)
	}

	/** Call when the socket closes or the module is torn down. */
	stop(): void {
		this.generation++
		this.syncGeneration++
		this.lastTick = null
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

	/**
	 * Throws away every clock sample and measures again with a fresh burst: the
	 * answer to a system clock change, a wake from sleep, or the app having
	 * restarted. In-flight replies from before the restart are dropped.
	 */
	restartSync(): void {
		if (!this.isV2) return
		if (this.syncTimer !== undefined) this.scheduler.clearTimeout(this.syncTimer)
		this.syncTimer = undefined
		const syncGeneration = ++this.syncGeneration
		this.deps.state.sync.reset()
		this.deps.onChange()
		void this.runBurst(this.generation, syncGeneration)
	}

	/**
	 * Call from a ~1 s housekeeping tick with the wall clock. The monotonic clock
	 * (`state.clock`) does not run during sleep and ignores clock steps, so the
	 * wall clock pulling away from it, or a long gap between ticks, means the
	 * offset measured so far may no longer hold.
	 */
	checkWake(wallMs: number): void {
		const mono = this.deps.state.clock()
		const last = this.lastTick
		this.lastTick = { wall: wallMs, mono }
		if (!last || !this.isV2) return
		const wallDelta = wallMs - last.wall
		const drift = wallDelta - (mono - last.mono)
		if (Math.abs(drift) > WAKE_DRIFT_MS || wallDelta > WAKE_GAP_MS || wallDelta < 0) this.restartSync()
	}

	/**
	 * The app restarted (a new `epoch`): restart clock sync and, when the packet
	 * that announced it was not a full snapshot, fetch one.
	 */
	handleEpochChange(needsState: boolean): void {
		if (!this.isV2) return
		this.restartSync()
		if (needsState) void this.catchUp()
	}

	private async runBurst(generation: number, syncGeneration: number): Promise<void> {
		for (let i = 0; i < SYNC_BURST_COUNT; i++) {
			if (i > 0) await this.sleep(SYNC_BURST_GAP_MS)
			if (generation !== this.generation || syncGeneration !== this.syncGeneration) return
			await this.sample(generation, syncGeneration)
		}
		if (generation === this.generation && syncGeneration === this.syncGeneration) {
			this.scheduleSteadySync(generation, syncGeneration)
		}
	}

	private scheduleSteadySync(generation: number, syncGeneration: number): void {
		this.syncTimer = this.scheduler.setTimeout(() => {
			void this.steadySample(generation, syncGeneration)
		}, SYNC_INTERVAL_MS)
	}

	private async steadySample(generation: number, syncGeneration: number): Promise<void> {
		if (generation !== this.generation || syncGeneration !== this.syncGeneration) return
		await this.sample(generation, syncGeneration)
		if (generation === this.generation && syncGeneration === this.syncGeneration) {
			this.scheduleSteadySync(generation, syncGeneration)
		}
	}

	/** One request/response exchange. Failures are dropped: the previous offset stays in force. */
	async sample(generation = this.generation, syncGeneration = this.syncGeneration): Promise<void> {
		const { state } = this.deps
		const t0 = state.clock()
		try {
			const reply = await this.command('sync', { t0 })
			const t3 = state.clock()
			if (generation !== this.generation || syncGeneration !== this.syncGeneration || reply.status !== 200) return
			const data = reply.data as Partial<SyncReplyData> | undefined
			if (!data || typeof data.t1 !== 'number' || typeof data.t2 !== 'number') return
			if (typeof data.t0 === 'number' && data.t0 !== t0) return
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
		if (!this.isV2) return
		// A new epoch resets the gate and fetches on its own (`handleEpochChange`), whatever the hashes say.
		if (state.observeEpoch(digest.epoch, true)) return
		if (this.fetching) return
		const snapshot = state.snapshot
		if (snapshot) {
			// Verification only: a digest repeats the app's current rev, so an equal one is the normal heartbeat; it never advances the gate.
			if (typeof digest.rev === 'number' && state.rev !== null) {
				if (digest.rev < state.rev || digest.rev - state.rev > MAX_REV_JUMP) return
			}
			if (mismatchedSections(computeHashes(snapshot), digest.hashes ?? {}).length === 0) return
		}
		await this.catchUp()
	}

	/** One `GET /v1/state`, adopted through the rev gate. Concurrent calls collapse into the one in flight. */
	private async catchUp(): Promise<void> {
		if (this.fetching) return
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
