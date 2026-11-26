import type { TimerColorScale, TimerColorStop } from './types.js'

export interface TimerColorStyle {
	/** Six hex digits without '#', or null for the normal text color. */
	colorHex: string | null
	/** 'none' unless the level animates the countdown text. */
	effect: string
	/** Which level is showing, for variables: 'none', 'on_time', 'lead_up', 'overtime' or 'overtime_deep'. */
	level: string
}

const NO_STYLE: TimerColorStyle = { colorHex: null, effect: 'none', level: 'none' }

function thresholdSeconds(value: number, unit: string, lengthSeconds: number): number {
	return unit === 'percent' ? (lengthSeconds * Math.min(value, 100)) / 100 : value
}

function stopThreshold(stop: TimerColorStop, lengthSeconds: number): number {
	return thresholdSeconds(stop.value, stop.unit, lengthSeconds)
}

/**
 * The look for the time left on an item, using the scale the producer sent. Mirrors the app's
 * TimerColorScale.style: of the lead-up stops reached the one closest to zero wins, of the overtime stops the
 * deepest does, and the overtime color waits for `overtimeStart`. Returns no color when the producer sent no scale;
 * the module never assumes one.
 */
export function timerColorStyle(
	scale: TimerColorScale | null | undefined,
	remainingSeconds: number | null,
	lengthSeconds: number,
): TimerColorStyle {
	if (!scale || remainingSeconds === null) return NO_STYLE
	const stops = scale.stops ?? []

	if (remainingSeconds < 0) {
		const over = -remainingSeconds
		const start = scale.overtimeStart
		const startThreshold = start ? thresholdSeconds(Math.max(0, start.value), start.unit, lengthSeconds) : 0
		// Not over by enough yet: keep the lead-up look, as if exactly at zero.
		if (over < startThreshold) return timerColorStyle({ ...scale, overtimeStart: undefined }, 0, lengthSeconds)

		let deepest: { stop: TimerColorStop; threshold: number } | null = null
		for (const stop of stops) {
			if (stop.phase !== 'overtime') continue
			const threshold = stopThreshold(stop, lengthSeconds)
			if (over >= threshold && (!deepest || threshold > deepest.threshold)) deepest = { stop, threshold }
		}
		if (deepest) {
			return { colorHex: deepest.stop.colorHex, effect: deepest.stop.effect ?? 'none', level: 'overtime_deep' }
		}
		return { colorHex: scale.overtimeHex, effect: scale.overtimeEffect ?? 'none', level: 'overtime' }
	}

	let nearest: { stop: TimerColorStop; threshold: number } | null = null
	for (const stop of stops) {
		if ((stop.phase ?? 'remaining') !== 'remaining') continue
		const threshold = stopThreshold(stop, lengthSeconds)
		if (remainingSeconds <= threshold && (!nearest || threshold < nearest.threshold)) nearest = { stop, threshold }
	}
	if (nearest) return { colorHex: nearest.stop.colorHex, effect: nearest.stop.effect ?? 'none', level: 'lead_up' }
	return { colorHex: scale.onTimeHex ?? null, effect: 'none', level: scale.onTimeHex ? 'on_time' : 'none' }
}

/** Packs six hex digits into the 24-bit number Companion styles use, or null when it is not valid hex. */
export function hexToRgbNumber(hex: string | null): number | null {
	if (!hex || !/^[0-9a-fA-F]{6}$/.test(hex)) return null
	return parseInt(hex, 16)
}
