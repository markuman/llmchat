/**
 * PDF handling, in the browser.
 *
 * Not the `files_pdfviewer` app: that is a Vue application with its own bundle
 * and no exported module, it cannot be imported or called, and an admin can
 * disable it. Not a PHP parser either — tool calls deliberately do not grow
 * server-side dependencies (see the header of tools.js). pdfjs-dist is the
 * exact package files_pdfviewer itself uses, just bundled here.
 *
 * Loaded lazily: pdf.js plus its worker is around half a megabyte, and most
 * chats never touch a PDF.
 */

// ?url makes Vite emit the worker as an asset and hand back its hashed path.
// Static, because the query is only honoured on a statically analysable
// import — as a dynamic one Vite bundles the worker as an ordinary chunk and
// `default` is a module namespace instead of a URL. This costs nothing at
// runtime: it is a string, the worker file itself is only requested when
// pdf.js actually spawns it.
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

const NO_TEXT_LAYER_VISION = 'this PDF has no text layer — it is probably a scan. '
	+ 'Use nc_read_pdf_page to look at a page as an image.'

/**
 * Without vision `nc_read_pdf_page` is not among the profile's tools at all,
 * so pointing at it would send the model into a dead end whose only exit is
 * another dead end. Name the switch that actually helps instead.
 */
const NO_TEXT_LAYER_BLIND = 'this PDF has no text layer — it is a scan or an image-only export, '
	+ 'so its content cannot be read as text. This profile cannot see images either. Tell the '
	+ 'user to enable "Model can see images" in the profile settings if their model supports it, '
	+ 'and do not try other tools on this file.'

/**
 * Below this many characters per page the extraction is treated as suspect. A
 * page of prose runs 1500–3000; a timetable that linearises to a few hundred
 * words is the case this exists for, and it is the dangerous one because the
 * call *succeeded* — the model gets plausible words in a useless order and has
 * nothing telling it so.
 */
const SPARSE_CHARS_PER_PAGE = 600

const SPARSE_TEXT_VISION = 'very little text per page — this is probably a table, form or '
	+ 'otherwise layout-heavy document, and extraction keeps the words but loses where they '
	+ 'sat. Rows and columns cannot be recovered from the order below. Do not guess: use '
	+ 'nc_read_pdf_page on the relevant page and read the actual layout.'

const SPARSE_TEXT_BLIND = 'very little text per page — this is probably a table, form or '
	+ 'otherwise layout-heavy document, and extraction keeps the words but loses where they '
	+ 'sat. Rows and columns cannot be recovered from the order below, so do not infer which '
	+ 'value belongs to which heading. If the answer depends on the layout, say that it cannot '
	+ 'be read reliably and that "Model can see images" in the profile settings would let the '
	+ 'page be looked at directly.'

let pdfjsPromise = null

function pdfjs() {
	if (!pdfjsPromise) {
		pdfjsPromise = import('pdfjs-dist').then((lib) => {
			lib.GlobalWorkerOptions.workerSrc = workerUrl

			return lib
		}).catch((error) => {
			// a failed import must not poison every later call
			pdfjsPromise = null
			throw error
		})
	}

	return pdfjsPromise
}

/**
 * Opens a document. The buffer is copied because pdf.js transfers it to the
 * worker, which detaches it — the caller may still want to render a page from
 * the same bytes afterwards.
 *
 * @param {ArrayBuffer} buffer the file
 * @return {Promise<object>} pdf.js document
 */
async function open(buffer) {
	const { getDocument } = await pdfjs()

	return getDocument({ data: new Uint8Array(buffer.slice(0)) }).promise
}

/**
 * Text carried by annotations rather than by the page itself.
 *
 * getTextContent() only sees the content stream, so a filled-in AcroForm and
 * any comment or free-text annotation are invisible to it — for a form that
 * is the difference between nothing and everything.
 *
 * @param {object} page pdf.js page
 * @param {string} pageText what the text layer already yielded
 * @return {Promise<string>} extra text, empty when there is none
 */
async function annotationText(page, pageText) {
	let annotations
	try {
		annotations = await page.getAnnotations({ intent: 'display' })
	} catch {
		// a broken annotation dictionary must not lose the page's real text
		return ''
	}

	const seen = new Set()

	return annotations
		.map((annotation) => {
			// fieldValue is the form field, contentsObj the comment body;
			// fieldValue can be an array for a multi-select
			const value = annotation?.fieldValue ?? annotation?.contentsObj?.str ?? annotation?.contents
			const text = Array.isArray(value) ? value.join(', ') : value

			return typeof text === 'string' ? text.trim() : ''
		})
		.filter((text) => {
			// some producers write widget values into the content stream as
			// well — no point in handing the model the same string twice
			if (text === '' || seen.has(text) || pageText.includes(text)) {
				return false
			}
			seen.add(text)

			return true
		})
		.join('\n')
}

/**
 * Extracts the text layer, plus whatever the annotations carry.
 *
 * Layout, tables and anything drawn rather than written are lost — that is
 * what pdfPageToImage() is for.
 *
 * @param {ArrayBuffer} buffer the file
 * @param {object} [options] options
 * @param {number} [options.maxChars] cap across all pages
 * @param {boolean} [options.vision] the profile may show images to the model
 * @return {Promise<object>} `{pages, num_pages, total_chars, truncated}`
 */
export async function pdfToText(buffer, { maxChars = 24000, vision = false } = {}) {
	const doc = await open(buffer)
	// read before destroy(): the getter reaches into internal state that
	// today survives teardown, but nothing documents that it has to
	const numPages = doc.numPages
	const pages = []
	let used = 0
	let truncated = false

	try {
		for (let number = 1; number <= numPages; number++) {
			const page = await doc.getPage(number)
			const content = await page.getTextContent()

			// items carry no whitespace of their own; hasEOL marks a line end
			const layer = content.items
				.map((item) => (item.str ?? '') + (item.hasEOL ? '\n' : ''))
				.join('')
				.replace(/[ \t]+\n/g, '\n')
				.trim()

			const extra = await annotationText(page, layer)
			const text = [layer, extra].filter(Boolean).join('\n').trim()

			page.cleanup()

			if (text === '') {
				continue
			}

			const room = maxChars - used
			if (room <= 0) {
				truncated = true
				break
			}

			const slice = text.length > room ? text.slice(0, room) : text
			truncated = truncated || slice.length < text.length
			used += slice.length
			pages.push({ page: number, chars: slice.length, text: slice })
		}
	} finally {
		await doc.destroy()
	}

	if (pages.length === 0) {
		return {
			pages: [],
			num_pages: numPages,
			total_chars: 0,
			truncated: false,
			note: vision ? NO_TEXT_LAYER_VISION : NO_TEXT_LAYER_BLIND,
		}
	}

	// Measured over the pages that produced text, not over the whole document:
	// one cover page of prose in front of thirty blank ones is not sparse, it
	// is a mostly empty PDF. Skipped when truncated, where a low average only
	// says the cap was reached.
	const sparse = !truncated && used / pages.length < SPARSE_CHARS_PER_PAGE

	return {
		pages,
		num_pages: numPages,
		total_chars: used,
		truncated,
		...(sparse ? { note: vision ? SPARSE_TEXT_VISION : SPARSE_TEXT_BLIND } : {}),
	}
}

/**
 * Renders one page to a JPEG.
 *
 * The long edge is what gets scaled, not the width: a landscape timetable
 * scaled by width leaves its short edge — where the small print sits — at
 * roughly two thirds of the resolution, and that is exactly the kind of
 * document one renders instead of reading its text layer.
 *
 * JPEG, not PNG: this runs on the main thread, and deflating close to two
 * megapixels is by far the most expensive step here. JPEG encodes several
 * times faster and comes out around a tenth of the size, which matters again
 * on the way out because base64 adds a third. On rasterised text q0.85 is
 * indistinguishable to a vision model, and the resolution bought with it is
 * worth far more than the artefacts cost.
 *
 * @param {ArrayBuffer} buffer the file
 * @param {number} pageNumber 1-based
 * @param {object} [options] options
 * @param {number} [options.maxEdge] target size of the longer edge, in pixels
 * @param {number} [options.quality] JPEG quality, 0..1
 * @return {Promise<object>} `{page, b64, mime, width, height}` or `{error}`
 */
export async function pdfPageToImage(buffer, pageNumber, { maxEdge = 1568, quality = 0.85 } = {}) {
	const doc = await open(buffer)

	try {
		if (pageNumber < 1 || pageNumber > doc.numPages) {
			return { error: `page ${pageNumber} does not exist — this PDF has ${doc.numPages} pages` }
		}

		const page = await doc.getPage(pageNumber)
		const base = page.getViewport({ scale: 1 })
		// capped: a receipt or a label would otherwise be blown up to an
		// absurd scale for no detail that is not already there
		const scale = Math.min(maxEdge / Math.max(base.width, base.height), 6)
		const viewport = page.getViewport({ scale })

		const canvas = document.createElement('canvas')
		canvas.width = Math.floor(viewport.width)
		canvas.height = Math.floor(viewport.height)

		await page.render({
			canvasContext: canvas.getContext('2d'),
			viewport,
			// pdf.js defaults to white already, but with JPEG there is no
			// alpha channel to fall back on, so say it out loud
			background: '#ffffff',
		}).promise
		page.cleanup()

		const blob = await new Promise((resolve, reject) => {
			canvas.toBlob(
				(result) => (result ? resolve(result) : reject(new Error('could not encode the page as JPEG'))),
				'image/jpeg',
				quality,
			)
		})

		return {
			page: pageNumber,
			b64: await blobToBase64(blob),
			mime: 'image/jpeg',
			size: blob.size,
			width: canvas.width,
			height: canvas.height,
		}
	} finally {
		await doc.destroy()
	}
}

function blobToBase64(blob) {
	return new Promise((resolve, reject) => {
		const reader = new FileReader()
		reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '')
		reader.onerror = () => reject(reader.error ?? new Error('could not read the rendered page'))
		reader.readAsDataURL(blob)
	})
}
