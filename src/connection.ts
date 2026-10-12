import { isIPv6 } from 'node:net'
import { DEFAULT_PORT } from './config.js'

export type ResolvedConnection = { ok: true; host: string; port: number } | { ok: false; reason: string }

const EMPTY_HOST = 'Set the Producer host/IP in the connection settings'

export function normalizeHost(raw: unknown): { ok: true; host: string } | { ok: false; reason: string } {
	const text = typeof raw === 'string' ? raw.trim() : ''
	if (!text) return { ok: false, reason: EMPTY_HOST }
	if (/\s/.test(text) || /[/?#@\\]/.test(text)) {
		return { ok: false, reason: 'The Producer host must be just an address or name — no http://, path or spaces' }
	}

	const encodeZone = (value: string) => value.replace('%', '%25')
	if (text.startsWith('[') || text.endsWith(']')) {
		const inner = text.slice(1, -1)
		if (text.startsWith('[') && text.endsWith(']') && isIPv6(inner)) return { ok: true, host: `[${encodeZone(inner)}]` }
		return { ok: false, reason: 'The Producer host looks like a malformed IPv6 address' }
	}
	if (text.includes(':')) {
		if (isIPv6(text)) return { ok: true, host: `[${encodeZone(text)}]` }
		return { ok: false, reason: 'Put only the address in Producer Host — the port goes in the Port field' }
	}
	if (!/^[A-Za-z0-9._-]+$/.test(text)) {
		return { ok: false, reason: 'The Producer host contains characters an address cannot have' }
	}
	return { ok: true, host: text }
}

export function resolveConnection(config: { host?: unknown; port?: unknown } | undefined): ResolvedConnection {
	const host = normalizeHost(config?.host)
	if (!host.ok) return host
	const port =
		config?.port === undefined || config.port === null || config.port === '' ? DEFAULT_PORT : Number(config.port)
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		return { ok: false, reason: 'The port must be a whole number from 1 to 65535' }
	}
	return { ok: true, host: host.host, port }
}

export function connectionChanged(
	previous: { host?: unknown; port?: unknown } | undefined,
	next: { host?: unknown; port?: unknown } | undefined,
): boolean {
	const a = resolveConnection(previous)
	const b = resolveConnection(next)
	if (a.ok && b.ok) return a.host !== b.host || a.port !== b.port
	if (!a.ok && !b.ok) return a.reason !== b.reason
	return true
}

interface ErrorLike {
	code?: unknown
	name?: unknown
	message?: unknown
	cause?: unknown
	errors?: unknown
}

function codeOf(err: unknown): string | undefined {
	if (typeof err !== 'object' || err === null) return undefined
	const like = err as ErrorLike
	if (typeof like.code === 'string') return like.code
	if (like.cause) {
		const fromCause = codeOf(like.cause)
		if (fromCause) return fromCause
	}
	if (Array.isArray(like.errors)) {
		for (const inner of like.errors) {
			const code = codeOf(inner)
			if (code) return code
		}
	}
	return undefined
}

export function describeConnectionError(err: unknown): string | null {
	const code = codeOf(err)
	const message =
		typeof err === 'object' && err !== null && typeof (err as ErrorLike).message === 'string'
			? (err as { message: string }).message
			: ''
	const rawName = typeof err === 'object' && err !== null ? (err as ErrorLike).name : undefined
	const name = typeof rawName === 'string' ? rawName : ''

	if (code === 'ECONNREFUSED') return 'Connection refused — turn on Settings → Control API in the Producer'
	if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT' || name === 'TimeoutError' || name === 'AbortError') {
		return 'Timed out reaching host'
	}
	if (/handshake has timed out/i.test(message)) return 'Timed out reaching host'
	if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'Host not found — check the Producer host/IP'
	if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH')
		return 'Host unreachable — check the network and the Producer host/IP'
	if (code === 'ECONNRESET') return 'Connection reset by the host'

	const upgrade = /Unexpected server response: (\d+)/.exec(message)
	if (upgrade) {
		return upgrade[1] === '404'
			? 'Reached a device that is not serving the Control API (404) — check the host and port'
			: `Control socket upgrade failed (HTTP ${upgrade[1]})`
	}
	return null
}
