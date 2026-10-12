import type { HourFormatThreshold } from './types.js'

export type TimerInputAction = { kind: 'setAbsolute'; seconds: number } | { kind: 'adjustRelative'; bySeconds: number }

export type TimerEntrySign = '+' | '-'

export function parseTimerInput(raw: string): TimerInputAction | null {
	const trimmed = raw.trim()
	if (!trimmed) return null

	let text = trimmed
	let isRelative = false
	let sign = 1
	if (text.startsWith('+')) {
		isRelative = true
		text = text.slice(1)
	} else if (text.startsWith('-')) {
		isRelative = true
		sign = -1
		text = text.slice(1)
	}
	text = text.trim()

	const magnitude = parseMagnitude(text)
	if (magnitude === null) return null
	return isRelative
		? { kind: 'adjustRelative', bySeconds: sign * magnitude }
		: { kind: 'setAbsolute', seconds: magnitude }
}

function parseMagnitude(text: string): number | null {
	if (!text) return null

	const combined = parseCombinedUnits(text.toLowerCase())
	if (combined !== null) return combined

	const separatorIndex = findSeparatorIndex(text)
	if (separatorIndex !== -1) {
		const minutesText = text.slice(0, separatorIndex)
		const secondsText = text.slice(separatorIndex + 1)
		if (!minutesText && !secondsText) return null
		const minutes = parseInteger(minutesText || '0')
		const seconds = parseInteger(secondsText || '0')
		if (minutes === null || seconds === null) return null
		return Math.max(0, minutes) * 60 + Math.max(0, seconds)
	}

	if (!/^[0-9]+$/.test(text)) return null
	const padded = text.length < 2 ? text.padStart(2, '0') : text
	const minutesPart = padded.slice(0, -2)
	const minutes = minutesPart ? Number(minutesPart) : 0
	const seconds = Number(padded.slice(-2))
	return minutes * 60 + seconds
}

function findSeparatorIndex(text: string): number {
	for (let i = 0; i < text.length; i++) {
		const char = text[i]
		if (char === ':' || char === '.') return i
	}
	return -1
}

function parseInteger(text: string): number | null {
	if (!/^[+-]?[0-9]+$/.test(text)) return null
	return Number(text)
}

function parseCombinedUnits(lowercasedText: string): number | null {
	let total = 0
	let digits = ''
	let matchedAny = false
	const seenUnits = new Set<string>()

	for (const char of lowercasedText) {
		if (char >= '0' && char <= '9') {
			digits += char
		} else if (char === 'h' || char === 'm' || char === 's') {
			if (!digits || seenUnits.has(char)) return null
			seenUnits.add(char)
			const value = Number(digits)
			if (char === 'h') total += value * 3600
			else if (char === 'm') total += value * 60
			else total += value
			digits = ''
			matchedAny = true
		} else {
			return null
		}
	}

	if (digits || !matchedAny) return null
	return Math.max(0, total)
}

const HOUR_FORMAT_CUTOFF_SECONDS: Record<HourFormatThreshold, number | null> = {
	over60Minutes: 60 * 60,
	over90Minutes: 90 * 60,
	never: null,
}

export function formatDuration(totalSeconds: number, threshold: HourFormatThreshold): string {
	const absSeconds = Math.abs(Math.trunc(totalSeconds))
	const cutoff = HOUR_FORMAT_CUTOFF_SECONDS[threshold] ?? null

	let core: string
	if (cutoff !== null && absSeconds >= cutoff) {
		core = `${Math.floor(absSeconds / 3600)}:${pad2(Math.floor((absSeconds % 3600) / 60))}:${pad2(absSeconds % 60)}`
	} else {
		core = `${pad2(Math.floor(absSeconds / 60))}:${pad2(absSeconds % 60)}`
	}
	return totalSeconds < 0 ? `+${core}` : core
}

function pad2(value: number): string {
	return String(value).padStart(2, '0')
}

export function resolvedSeconds(action: TimerInputAction, baseSeconds: number, elapsedSeconds = 0): number {
	return action.kind === 'setAbsolute'
		? Math.max(0, action.seconds)
		: Math.max(0 - elapsedSeconds, baseSeconds + action.bySeconds)
}

export function previewText(
	buffer: string,
	baseSeconds: number | null,
	threshold: HourFormatThreshold,
	elapsedSeconds = 0,
): string {
	const action = parseTimerInput(buffer)
	if (!action) return ''
	if (action.kind === 'adjustRelative' && baseSeconds === null) return ''

	const result = formatDuration(resolvedSeconds(action, baseSeconds ?? 0, elapsedSeconds), threshold)
	if (action.kind === 'setAbsolute') return result

	const sign = action.bySeconds < 0 ? '-' : '+'
	return `${sign}${formatDuration(Math.abs(action.bySeconds), threshold)}\n= ${result}`
}

export function withSign(buffer: string, sign: TimerEntrySign): string {
	if (buffer.startsWith(sign)) return buffer.slice(1)
	const rest = buffer.startsWith('+') || buffer.startsWith('-') ? buffer.slice(1) : buffer
	return sign + rest
}

export function signOf(buffer: string): TimerEntrySign | null {
	if (buffer.startsWith('+')) return '+'
	if (buffer.startsWith('-')) return '-'
	return null
}

export const MAX_LENGTH_SECONDS = 86400

export function parseDurationText(raw: string): number | null {
	let text = raw.trim()
	const equals = text.lastIndexOf('=')
	if (equals !== -1) text = text.slice(equals + 1)
	text = text.trim()
	if (!text || text.startsWith('+') || text.startsWith('-')) return null

	if (/^[0-9]+$/.test(text)) return Number(text)

	const units = parseCombinedUnits(text.toLowerCase())
	if (units !== null) return units

	const parts = text.split(':')
	if (parts.length < 2 || parts.length > 3) return null
	if (!parts.every((part) => /^[0-9]+$/.test(part))) return null
	const numbers = parts.map(Number)
	if (numbers.length === 3) {
		const [hours, minutes, seconds] = numbers
		if (minutes >= 60 || seconds >= 60) return null
		return hours * 3600 + minutes * 60 + seconds
	}
	const [minutes, seconds] = numbers
	if (seconds >= 60) return null
	return minutes * 60 + seconds
}

export function lengthFromOption(
	raw: string | number | boolean | null | undefined,
	options: { allowEmpty: boolean },
): number | null {
	const text = raw === undefined || raw === null ? '' : String(raw).trim()
	if (!text) {
		if (options.allowEmpty) return null
		throw new Error('Length is empty. Use seconds (90), mm:ss (1:30) or h:mm:ss (1:02:03).')
	}
	const seconds = parseDurationText(text)
	if (seconds === null) {
		throw new Error(`"${text}" is not a length. Use seconds (90), mm:ss (1:30) or h:mm:ss (1:02:03).`)
	}
	if (seconds > MAX_LENGTH_SECONDS) throw new Error(`"${text}" is longer than 24 hours.`)
	return seconds
}
