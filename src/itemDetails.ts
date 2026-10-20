import type { PCOTimerItem } from './types.js'

const SEPARATOR = ' · '

function nonEmpty(value: string | null | undefined): string {
	return typeof value === 'string' ? value.trim() : ''
}

export function isHeaderItem(item: PCOTimerItem | null | undefined): boolean {
	return item?.itemType?.toLowerCase() === 'header'
}

function detailsOf(item: PCOTimerItem | null | undefined) {
	if (!item || isHeaderItem(item)) return null
	return item.details ?? null
}

export function itemKeyText(item: PCOTimerItem | null | undefined): string {
	const details = detailsOf(item)
	if (!details) return ''
	for (const candidate of [details.key?.startingKey, details.keyName, details.key?.name]) {
		const text = nonEmpty(candidate)
		if (text) return text
	}
	return ''
}

export function itemBpmText(item: PCOTimerItem | null | undefined): string {
	const bpm = detailsOf(item)?.arrangement?.bpm
	if (typeof bpm !== 'number' || !Number.isFinite(bpm) || bpm <= 0) return ''
	return Number.isInteger(bpm) ? String(bpm) : bpm.toFixed(1)
}

export function itemMeterText(item: PCOTimerItem | null | undefined): string {
	return nonEmpty(detailsOf(item)?.arrangement?.meter)
}

export function itemArrangementText(item: PCOTimerItem | null | undefined): string {
	return nonEmpty(detailsOf(item)?.arrangement?.name)
}

export function itemSequenceText(item: PCOTimerItem | null | undefined): string {
	const details = detailsOf(item)
	if (!details) return ''
	const custom = Array.isArray(details.customSequenceShort) ? details.customSequenceShort : []
	const arrangement = Array.isArray(details.arrangement?.sequenceShort) ? details.arrangement.sequenceShort : []
	return (custom.length > 0 ? custom : arrangement).join(' ')
}

export function itemLeaderText(item: PCOTimerItem | null | undefined): string {
	const leaders = detailsOf(item)?.leaders
	if (!Array.isArray(leaders)) return ''
	const names = leaders.map((leader) => nonEmpty(leader?.firstName)).filter((name) => name !== '')
	if (names.length === 0) return ''
	if (names.length === 1) return names[0]
	if (names.length === 2) return `${names[0]} & ${names[1]}`
	return `${names[0]} + ${names.length - 1}`
}

export function itemMusicLine(item: PCOTimerItem | null | undefined): string {
	const bpm = itemBpmText(item)
	return [itemKeyText(item), bpm ? `${bpm} BPM` : '', itemMeterText(item)].filter((part) => part !== '').join(SEPARATOR)
}
