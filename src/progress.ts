import { deflateSync } from 'node:zlib'

const SIZE = 72
const BAR_TOP = 54
const BAR_HEIGHT = 10
const BAR_INSET = 6

const CRC_TABLE = (() => {
	const table = new Uint32Array(256)
	for (let n = 0; n < 256; n++) {
		let c = n
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
		table[n] = c >>> 0
	}
	return table
})()

function crc32(bytes: Buffer): number {
	let c = 0xffffffff
	for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
	return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Buffer): Buffer {
	const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
	const out = Buffer.alloc(body.length + 8)
	out.writeUInt32BE(data.length, 0)
	body.copy(out, 4)
	out.writeUInt32BE(crc32(body), body.length + 4)
	return out
}

const cache = new Map<number, string>()

/**
 * A 72x72 transparent PNG with a horizontal progress bar near the bottom edge:
 * a dim track with the filled part in green. Cached per whole percent — there
 * are only 101 distinct images.
 */
export function progressBarPng(pct: number): string {
	const clamped = Math.max(0, Math.min(100, Math.round(pct)))
	const cached = cache.get(clamped)
	if (cached) return cached

	const trackWidth = SIZE - BAR_INSET * 2
	const fillWidth = Math.round((trackWidth * clamped) / 100)
	const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE)
	for (let y = 0; y < SIZE; y++) {
		const row = y * (SIZE * 4 + 1)
		raw[row] = 0
		if (y < BAR_TOP || y >= BAR_TOP + BAR_HEIGHT) continue
		for (let x = BAR_INSET; x < SIZE - BAR_INSET; x++) {
			const at = row + 1 + x * 4
			const filled = x - BAR_INSET < fillWidth
			raw[at] = filled ? 38 : 255
			raw[at + 1] = filled ? 199 : 255
			raw[at + 2] = filled ? 89 : 255
			raw[at + 3] = filled ? 255 : 70
		}
	}

	const header = Buffer.alloc(13)
	header.writeUInt32BE(SIZE, 0)
	header.writeUInt32BE(SIZE, 4)
	header[8] = 8
	header[9] = 6
	const png = Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk('IHDR', header),
		chunk('IDAT', deflateSync(raw)),
		chunk('IEND', Buffer.alloc(0)),
	]).toString('base64')
	cache.set(clamped, png)
	return png
}
