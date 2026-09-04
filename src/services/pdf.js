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
 * Extracts the text layer.
 *
 * Layout, tables and anything drawn rather than written are lost — that is
 * what pdfPageToImage() is for.
 *
 * @param {ArrayBuffer} buffer the file
 * @param {object} [options] options
 * @param {number} [options.maxChars] cap across all pages
 * @return {Promise<object>} `{pages, num_pages, total_chars, truncated}`
 */
export async function pdfToText(buffer, { maxChars = 24000 } = {}) {
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
			const text = content.items
				.map((item) => (item.str ?? '') + (item.hasEOL ? '\n' : ''))
				.join('')
				.replace(/[ \t]+\n/g, '\n')
				.trim()

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
			note: 'this PDF has no text layer — it is probably a scan. '
				+ 'Use nc_read_pdf_page to look at a page as an image.',
		}
	}

	return { pages, num_pages: numPages, total_chars: used, truncated }
}

/**
 * Renders one page to a PNG.
 *
 * @param {ArrayBuffer} buffer the file
 * @param {number} pageNumber 1-based
 * @param {object} [options] options
 * @param {number} [options.width] target width in pixels
 * @return {Promise<object>} `{page, b64, mime, width, height}` or `{error}`
 */
export async function pdfPageToImage(buffer, pageNumber, { width = 1024 } = {}) {
	const doc = await open(buffer)

	try {
		if (pageNumber < 1 || pageNumber > doc.numPages) {
			return { error: `page ${pageNumber} does not exist — this PDF has ${doc.numPages} pages` }
		}

		const page = await doc.getPage(pageNumber)
		const base = page.getViewport({ scale: 1 })
		const viewport = page.getViewport({ scale: width / base.width })

		const canvas = document.createElement('canvas')
		canvas.width = Math.floor(viewport.width)
		canvas.height = Math.floor(viewport.height)

		await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise
		page.cleanup()

		const blob = await new Promise((resolve, reject) => {
			canvas.toBlob(
				(result) => (result ? resolve(result) : reject(new Error('could not encode the page as PNG'))),
				'image/png',
			)
		})

		return {
			page: pageNumber,
			b64: await blobToBase64(blob),
			mime: 'image/png',
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
