import { MAX_REV_JUMP, type ModuleState } from './state.js'
import { computeHashes, mismatchedSections, msToNextBoundary } from './sync.js'
import type { CommandReply, ControlAPIState, DigestData, SyncReplyData } from './types.js'

export const SYNC_BURST_COUNT = 5
export const SYNC_BURST_GAP_MS = 100
export const SYNC_INTERVAL_MS = 30000
export const COMMAND_TIMEOUT_MS = 5000
export const WAKE_DRIFT_MS = 2000
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
	sendCommand: (op: string, body?: unknown) => Promise<CommandReply>
	fetchState: () => Promise<ControlAPIState>
	adopt: (snapshot: ControlAPIState) => void
	onChange: () => void
	onProtocol?: (version: 1 | 2) => void
	log?: (level: 'debug' | 'info' | 'warn', message: string) => void
	scheduler?: Scheduler
}

export class SyncSession {
	private scheduler: Scheduler
	private generation = 0
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

	restartSync(): void {
		if (!this.isV2) return
		if (this.syncTimer !== undefined) this.scheduler.clearTimeout(this.syncTimer)
		this.syncTimer = undefined
		const syncGeneration = ++this.syncGeneration
		this.deps.state.sync.reset()
		this.deps.onChange()
		void this.runBurst(this.generation, syncGeneration)
	}

	checkWake(wallMs: number): void {
		const mono = this.deps.state.clock()
		const last = this.lastTick
		this.lastTick = { wall: wallMs, mono }
		if (!last || !this.isV2) return
		const wallDelta = wallMs - last.wall
		const drift = wallDelta - (mono - last.mono)
		if (Math.abs(drift) > WAKE_DRIFT_MS || wallDelta > WAKE_GAP_MS || wallDelta < 0) this.restartSync()
	}

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

	async handleDigest(digest: DigestData): Promise<void> {
		const { state } = this.deps
		if (!this.isV2) return
		if (state.observeEpoch(digest.epoch, true)) return
		if (this.fetching) return
		const snapshot = state.snapshot
		if (snapshot) {
			if (typeof digest.rev === 'number' && state.rev !== null) {
				if (digest.rev < state.rev || digest.rev - state.rev > MAX_REV_JUMP) return
			}
			if (mismatchedSections(computeHashes(snapshot), digest.hashes ?? {}).length === 0) return
		}
		await this.catchUp()
	}

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
