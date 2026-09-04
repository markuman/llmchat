/**
 * Image preparation for the vision tools.
 *
 * Sits between "the bytes as they lie in Nextcloud" and "what may be put into
 * a request body". The reason is not the token bill — Anthropic and OpenAI
 * downscale server-side anyway, and the price hangs off the resolution *after*
 * their resize, so an 8 MB phone photo costs no more than a tidy 300 KB one.
 * What actually hurts:
 *
 * - Anthropic refuses anything over 5 MB per image, with an HTTP 400 that
 *   arrives *after* the tool ran and the user approved it. A tool that
 *   succeeds and then kills the turn is the worst of both worlds.
 * - The agent loop re-sends its whole message array every round, and the API
 *   is stateless. Three tool calls after the image means uploading it three
 *   more times.
 * - Local backends (Ollama, llama.cpp) decode and preprocess the full image
 *   themselves and simply get slow.
 *
 * The numbers match pdfPageToImage() on purpose: 1568 px on the longer edge,
 * JPEG q0.85. Same reasoning, and two different answers to the same question
 * would only be confusing.
 */

import { arrayBufferToBase64 } from './nextcloud.js'

/** Long edge a resized image is scaled to. */
export const MAX_EDGE = 1568

/** JPEG quality for re-encoded images. */
export const JPEG_QUALITY = 0.85

/**
 * Anthropic's hard per-image ceiling, and the tightest of the providers we
 * can reach. Enforced here rather than left to the API, because there the
 * failure lands after the tool call has already been approved and run.
 */
export const PROVIDER_MAX_BYTES = 5 * 1024 * 1024

/**
 * Below this a re-encode is not worth it. A small PNG screenshot pushed
 * through a JPEG encoder comes out blurrier and often no smaller — the whole
 * point is to stop wasting bytes, not to add a lossy pass for its own sake.
 */
const PASSTHROUGH_BYTES = 1024 * 1024

/**
 * Types canvas cannot be pointed at. Only SVG: it is markup, and
 * createImageBitmap either refuses it outright or needs an intrinsic size the
 * file may not carry.
 *
 * Animated formats are deliberately *not* here. Preserving the animation
 * sounds right and buys nothing: no provider looks at more than one frame —
 * OpenAI documents GIF support as non-animated, Anthropic takes a single
 * frame — so the other frames are bytes paid for and never read. Losing them
 * to a resize is a feature, and an 8 MB animation refused for being over the
 * limit would be strictly worse than the first frame at 200 KB. Small ones
 * still keep their animation by falling into the size passthrough below,
 * where it costs nothing either way.
 */
const PASSTHROUGH_MIMES = ['image/svg+xml']

/**
 * Byte count in the unit a human would use, for messages the model relays.
 *
 * @param {number} bytes size
 * @return {string} e.g. "6.2 MB"
 */
function describeBytes(bytes) {
	return bytes >= 1024 * 1024
		? `${(bytes / 1024 / 1024).toFixed(1)} MB`
		: `${Math.round(bytes / 1024)} KB`
}

/**
 * Base64 of a Blob, without the data-uri prefix.
 *
 * @param {Blob} blob source
 * @return {Promise<string>} base64
 */
export function blobToBase64(blob) {
	return new Promise((resolve, reject) => {
		const reader = new FileReader()
		reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '')
		reader.onerror = () => reject(reader.error ?? new Error('could not read the image'))
		reader.readAsDataURL(blob)
	})
}

/**
 * Encodes a canvas as JPEG.
 *
 * @param {HTMLCanvasElement} canvas source
 * @param {number} quality 0..1
 * @return {Promise<Blob>} the encoded image
 */
export function canvasToJpeg(canvas, quality = JPEG_QUALITY) {
	return new Promise((resolve, reject) => {
		canvas.toBlob(
			(result) => (result ? resolve(result) : reject(new Error('could not encode the image as JPEG'))),
			'image/jpeg',
			quality,
		)
	})
}

/**
 * Hands the bytes over unchanged, or refuses them when no provider would
 * take them.
 *
 * Every return of the original bytes goes through here, without exception.
 * The size check is the entire point of this module — a path that hands back
 * an oversized original is the HTTP 400 after approval that #14 exists to
 * prevent, and it is easy to reintroduce by returning the buffer "just this
 * once" from somewhere else.
 *
 * @param {ArrayBuffer} buffer original bytes
 * @param {string} mime original type
 * @param {string} why what makes this a passthrough, for the error message
 * @param {object} [size] pixel dimensions, when they are known
 * @param {number} [size.width] decoded width
 * @param {number} [size.height] decoded height
 * @return {object} the result shape, or `{error}`
 */
function passthrough(buffer, mime, why, { width = null, height = null } = {}) {
	if (buffer.byteLength > PROVIDER_MAX_BYTES) {
		return {
			error: `this image is ${describeBytes(buffer.byteLength)} and ${why}, so it cannot be `
				+ `shrunk — providers reject anything over ${describeBytes(PROVIDER_MAX_BYTES)} per `
				+ 'image. Ask the user for a smaller version, or pick a different file.',
		}
	}

	return {
		b64: arrayBufferToBase64(buffer),
		mime,
		size: buffer.byteLength,
		width,
		height,
		resized: false,
	}
}

/**
 * Scales an image down to something a model will actually accept.
 *
 * EXIF orientation is applied while decoding (`imageOrientation:
 * 'from-image'`), otherwise every portrait phone photo reaches the model
 * lying on its side — the rotation lives in the metadata, and a canvas draw
 * throws that away. Transparency is flattened onto white for the same reason
 * the PDF renderer does it: JPEG has no alpha, and undefined pixels come out
 * black.
 *
 * @param {ArrayBuffer} buffer the image file
 * @param {string} mime its content type
 * @param {object} [options] options
 * @param {number} [options.maxEdge] target size of the longer edge
 * @param {number} [options.quality] JPEG quality, 0..1
 * @return {Promise<object>} `{b64, mime, size, width, height, resized}` or `{error}`
 */
export async function downscaleImage(buffer, mime, { maxEdge = MAX_EDGE, quality = JPEG_QUALITY } = {}) {
	if (PASSTHROUGH_MIMES.includes(mime)) {
		return passthrough(buffer, mime, 'a vector image')
	}

	// no decoder, no resize — better the original than nothing, as long as it
	// is small enough to be accepted
	if (typeof createImageBitmap !== 'function') {
		return passthrough(buffer, mime, 'this browser cannot decode it for resizing')
	}

	let bitmap
	try {
		bitmap = await createImageBitmap(new Blob([buffer], { type: mime }), {
			imageOrientation: 'from-image',
		})
	} catch {
		// a broken or exotic file: the model may still make something of it,
		// the provider limit is what really matters
		return passthrough(buffer, mime, 'it could not be decoded')
	}

	try {
		const longEdge = Math.max(bitmap.width, bitmap.height)

		// already small in both senses: re-encoding would only lose detail —
		// and, for an animation, the frames after the first
		if (longEdge <= maxEdge && buffer.byteLength <= PASSTHROUGH_BYTES) {
			return passthrough(buffer, mime, 'already small', {
				width: bitmap.width,
				height: bitmap.height,
			})
		}

		const scale = Math.min(1, maxEdge / longEdge)
		const canvas = document.createElement('canvas')
		canvas.width = Math.max(1, Math.round(bitmap.width * scale))
		canvas.height = Math.max(1, Math.round(bitmap.height * scale))

		const context = canvas.getContext('2d')
		context.fillStyle = '#ffffff'
		context.fillRect(0, 0, canvas.width, canvas.height)
		context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)

		const blob = await canvasToJpeg(canvas, quality)

		// Pathological case: a flat graphic can encode larger as JPEG than it
		// was as PNG. Keep whichever is smaller, as long as nothing was scaled
		// away in the process — and only when the original is actually
		// acceptable, which is what passthrough() decides. A 6 MB screenshot
		// under 1568 px whose JPEG comes out larger still cannot be sent, and
		// returning it here because it is "the smaller of the two" would put
		// the HTTP 400 back exactly where this module removed it.
		if (scale === 1 && blob.size >= buffer.byteLength) {
			// Its own error when both are too big, not the one below: nothing
			// was scaled here, so "even scaled down" would be a lie, and the
			// JPEG is the larger of the two anyway.
			return passthrough(buffer, mime, 'a re-encode only makes it larger', {
				width: bitmap.width,
				height: bitmap.height,
			})
		}

		if (blob.size > PROVIDER_MAX_BYTES) {
			return {
				error: `even scaled down this image is ${describeBytes(blob.size)}, over the `
					+ `${describeBytes(PROVIDER_MAX_BYTES)} a provider will accept`,
			}
		}

		return {
			b64: await blobToBase64(blob),
			mime: 'image/jpeg',
			size: blob.size,
			width: canvas.width,
			height: canvas.height,
			resized: true,
			original_size: buffer.byteLength,
		}
	} finally {
		bitmap.close?.()
	}
}
