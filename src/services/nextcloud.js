/**
 * Read-only access to this Nextcloud, straight from the browser.
 *
 * No PHP proxy involved: the page is same-origin, so the session cookie and
 * CSRF token are already there and every request runs as the logged-in user
 * with their own permissions. A server-side proxy would have to use one fixed
 * account for everybody — strictly worse.
 *
 * Every call goes through `ncFetch`, which always sets the full header set.
 * That is not tidiness. `CORSMiddleware::beforeController()` reacts to a
 * missing CSRF token on a `#[CORS]` controller — which the Notes app is — by
 * calling `$this->session->logout()`. One request built by hand without
 * `requesttoken` logs the user out of Nextcloud mid-chat.
 */

import { getCurrentUser, getRequestToken } from '@nextcloud/auth'
import { generateOcsUrl, generateRemoteUrl } from '@nextcloud/router'

const DEFAULT_LIMIT = 10
/** the OCS search endpoint clamps to 25 server-side anyway */
const MAX_SEARCH_LIMIT = 25
const REQUEST_TIMEOUT_MS = 15000
/** text handed to the model per read; roughly 6k tokens */
export const MAX_TEXT_CHARS = 24000
/**
 * One image per turn, and that image has a ceiling. Base64 inflates by a third
 * on the way out, and a 10 MB photo is already ~13 MB of request body plus
 * whatever the provider charges for it in tokens.
 */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024
/** reading a file is not a page fetch — a scan can be slow */
const FILE_TIMEOUT_MS = 60000

function headers(extra = {}) {
	return {
		// mandatory — see the file comment on the logout hazard
		requesttoken: getRequestToken() ?? '',
		// doubles as a valid CSRF check for OCS routes (Request::passesCSRFCheck)
		'OCS-APIRequest': 'true',
		// without it OCS answers XML
		Accept: 'application/json',
		// makes DAV reply with a dummy auth scheme instead of triggering the
		// browser's native basic-auth popup on 401
		'X-Requested-With': 'XMLHttpRequest',
		...extra,
	}
}

/**
 * @param {string} url absolute path on this instance
 * @param {object} [options] fetch options
 * @return {Promise<Response>} the raw response
 */
async function ncFetch(url, options = {}) {
	return fetch(url, {
		method: 'GET',
		credentials: 'same-origin',
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		...options,
		headers: headers(options.headers),
	})
}

/**
 * Unwraps the `{ocs: {meta, data}}` envelope and turns failures into thrown
 * errors carrying a message the model can act on.
 *
 * @param {string} url ocs url
 * @return {Promise<object>} the `data` payload
 */
async function ocs(url) {
	const response = await ncFetch(url)

	if (!response.ok) {
		let detail = ''
		try {
			const body = await response.json()
			detail = body?.ocs?.meta?.message ?? ''
		} catch {
			// non-JSON error body, status alone will have to do
		}
		throw new Error(`HTTP ${response.status}${detail ? `: ${detail}` : ''}`)
	}

	const body = await response.json()

	return body?.ocs?.data ?? body
}

/**
 * Lists the search providers this user actually has. Provider ids are not
 * hardcoded because a provider disappears from the list when its app is
 * disabled — a fixed id would just 404.
 *
 * @return {Promise<Array<{id: string, name: string}>>} providers
 */
export async function searchProviders() {
	const data = await ocs(generateOcsUrl('search/providers'))

	return (Array.isArray(data) ? data : []).map((p) => ({ id: p.id, name: p.name }))
}

/**
 * Unified search across the user's Nextcloud.
 *
 * @param {string} term what to look for
 * @param {object} [options] options
 * @param {string} [options.provider] restrict to one provider id
 * @param {number} [options.limit] per provider
 * @return {Promise<object>} results grouped by provider
 */
export async function search(term, { provider = null, limit = DEFAULT_LIMIT } = {}) {
	const query = String(term ?? '').trim()
	if (query === '') {
		// the endpoint answers 400 "No valid filters provided" for an empty
		// term, which is a confusing thing to hand a model
		return { error: 'a search term is required' }
	}

	const providers = provider
		? [{ id: provider, name: provider }]
		: await searchProviders()

	if (providers.length === 0) {
		return { term: query, results: [], note: 'no search providers are available' }
	}

	const capped = Math.min(Math.max(1, limit), MAX_SEARCH_LIMIT)

	const settled = await Promise.allSettled(providers.map(async (p) => {
		const url = generateOcsUrl('search/providers/{providerId}/search', { providerId: p.id })
			+ `?${new URLSearchParams({ term: query, limit: String(capped) })}`
		const data = await ocs(url)

		return {
			provider: p.id,
			entries: (data?.entries ?? []).map((e) => ({
				title: e.title ?? '',
				subline: e.subline ?? '',
				// relative link into the web UI, useful for the user but
				// deliberately not something the model should fetch
				url: e.resourceUrl ?? '',
			})),
		}
	}))

	const results = settled
		.filter((r) => r.status === 'fulfilled' && r.value.entries.length > 0)
		.map((r) => r.value)

	if (results.length === 0) {
		return {
			term: query,
			results: [],
			note: 'Nothing found in this Nextcloud. Do not guess — say that the search '
				+ 'returned nothing.',
		}
	}

	return { term: query, results }
}

/**
 * Lists the user's collectives.
 *
 * @return {Promise<object>} collectives
 */
export async function listCollectives() {
	const data = await ocs(generateOcsUrl('apps/collectives/api/v1.0/collectives'))

	const collectives = (data?.collectives ?? []).map((c) => ({
		id: c.id,
		name: c.name,
		emoji: c.emoji ?? null,
	}))

	return collectives.length === 0
		? { collectives: [], note: 'this user has no collectives' }
		: { collectives }
}

/**
 * Lists the pages of one collective. Metadata only — the text lives in a file
 * and is fetched separately, see readPage().
 *
 * @param {number} collectiveId collective
 * @return {Promise<object>} pages
 */
export async function listPages(collectiveId) {
	const data = await ocs(generateOcsUrl('apps/collectives/api/v1.0/collectives/{id}/pages', { id: collectiveId }))

	const pages = (data?.pages ?? []).map((p) => ({
		id: p.id,
		title: p.title,
		// kept so readPage() does not have to look them up again
		file_name: p.fileName,
		file_path: p.filePath ?? '',
		collective_path: p.collectivePath ?? '',
		modified: p.timestamp ?? null,
	}))

	return pages.length === 0
		? { pages: [], note: 'this collective has no pages' }
		: { pages }
}

/**
 * Reads the markdown of one collective page.
 *
 * Two requests, because Collectives has no content API — its own Vue app does
 * exactly the same: OCS for the metadata, then a WebDAV GET for the file. A
 * plain GET needs no CSRF token, but sending one costs nothing.
 *
 * @param {number} collectiveId collective
 * @param {number} pageId page
 * @return {Promise<object>} page with content
 */
export async function readPage(collectiveId, pageId) {
	const data = await ocs(generateOcsUrl('apps/collectives/api/v1.0/collectives/{cid}/pages/{pid}', {
		cid: collectiveId,
		pid: pageId,
	}))

	const page = data?.page
	if (!page) {
		return { error: 'page not found' }
	}

	const uid = getCurrentUser()?.uid
	if (!uid) {
		return { error: 'could not determine the current user' }
	}

	// each segment separately — encoding the joined path would escape the
	// slashes and produce a single bogus filename
	const segments = [page.collectivePath ?? '', page.filePath ?? '', page.fileName ?? '']
		.filter(Boolean)
		.flatMap((part) => part.split('/'))
		.filter(Boolean)
		.map(encodeURIComponent)

	const url = generateRemoteUrl(`dav/files/${encodeURIComponent(uid)}/${segments.join('/')}`)

	const response = await ncFetch(url, { headers: { Accept: 'text/markdown, text/plain, */*' } })
	if (!response.ok) {
		return { error: `could not read the page file (HTTP ${response.status})` }
	}

	const raw = await response.text()
	const truncated = raw.length > MAX_TEXT_CHARS

	return {
		title: page.title,
		collective_id: collectiveId,
		page_id: pageId,
		content: truncated ? raw.slice(0, MAX_TEXT_CHARS) : raw,
		truncated,
	}
}

/**
 * Full text search inside one collective.
 *
 * @param {number} collectiveId collective
 * @param {string} term what to look for
 * @return {Promise<object>} matching pages
 */
export async function searchCollective(collectiveId, term) {
	const query = String(term ?? '').trim()
	if (query === '') {
		return { error: 'a search term is required' }
	}

	const url = generateOcsUrl('apps/collectives/api/v1.0/collectives/{id}/search', { id: collectiveId })
		+ `?${new URLSearchParams({ searchString: query })}`
	const data = await ocs(url)

	const pages = (data?.pages ?? []).map((p) => ({
		id: p.id,
		title: p.title,
		modified: p.timestamp ?? null,
	}))

	return pages.length === 0 ? { pages: [], note: 'no matching pages' } : { pages }
}

/**
 * Turns a path relative to the user's home into an absolute WebDAV url.
 *
 * Each segment is encoded on its own — encoding the joined path would escape
 * the slashes and produce one bogus filename, same reasoning as in readPage().
 *
 * @param {string} path relative path, may be empty for the home itself
 * @return {{url: string}|{error: string}} url or a message for the model
 */
function davUrl(path) {
	const uid = getCurrentUser()?.uid
	if (!uid) {
		return { error: 'could not determine the current user' }
	}

	const segments = String(path ?? '')
		.split('/')
		.filter(Boolean)
		// "Documents/../.ssh" would be resolved by the server, not by us
		.filter((segment) => segment !== '.' && segment !== '..')
		.map(encodeURIComponent)

	const base = `dav/files/${encodeURIComponent(uid)}`

	return {
		url: generateRemoteUrl(segments.length ? `${base}/${segments.join('/')}` : base),
		// what actually got requested, after dropping traversal segments
		clean: segments.map(decodeURIComponent).join('/'),
	}
}

const PROPFIND_BODY = '<?xml version="1.0" encoding="UTF-8"?>'
	+ '<d:propfind xmlns:d="DAV:"><d:prop>'
	+ '<d:displayname/><d:getcontenttype/><d:getcontentlength/><d:resourcetype/>'
	+ '</d:prop></d:propfind>'

/**
 * Lists one directory of the user's files, by path relative to their home.
 *
 * Relative paths on purpose: that is what the user sees in the Files app and
 * what nc_search hands back, so the model can go straight from a search hit to
 * a read without translating anything.
 *
 * @param {string} [path] directory relative to the home, empty for the root
 * @return {Promise<object>} entries, directories first
 */
export async function listFiles(path = '') {
	const target = davUrl(path)
	if (target.error) {
		return target
	}

	const response = await ncFetch(target.url, {
		method: 'PROPFIND',
		headers: {
			Depth: '1',
			// this is DAV, not OCS — the OCS marker would be a lie here, but
			// the CSRF token still has to go out (see the file comment)
			'OCS-APIRequest': 'false',
			Accept: 'application/xml',
			'Content-Type': 'application/xml; charset=utf-8',
		},
		body: PROPFIND_BODY,
	})

	if (!response.ok) {
		return response.status === 404
			? { error: `no such directory: ${target.clean || '/'}` }
			: { error: `could not list the directory (HTTP ${response.status})` }
	}

	const doc = new DOMParser().parseFromString(await response.text(), 'application/xml')
	const prefix = new URL(target.url, window.location.origin).pathname.replace(/\/+$/, '')

	const files = [...doc.getElementsByTagNameNS('DAV:', 'response')]
		.map((entry) => {
			const href = entry.getElementsByTagNameNS('DAV:', 'href')[0]?.textContent ?? ''
			const isDir = entry.getElementsByTagNameNS('DAV:', 'collection').length > 0
			const text = (tag) => entry.getElementsByTagNameNS('DAV:', tag)[0]?.textContent ?? ''
			// href is url-encoded and absolute; make it relative to the request
			const relative = decodeURIComponent(href.replace(/\/+$/, ''))
				.replace(decodeURIComponent(prefix), '')
				.replace(/^\/+/, '')

			return {
				name: text('displayname') || relative.split('/').pop() || '',
				path: [target.clean, relative].filter(Boolean).join('/'),
				is_dir: isDir,
				size: isDir ? null : Number(text('getcontentlength') || 0),
				mime: isDir ? null : (text('getcontenttype') || null),
			}
		})
		// the first response is the directory itself
		.filter((entry) => entry.path !== target.clean && entry.name !== '')
		.sort((a, b) => (a.is_dir === b.is_dir ? a.name.localeCompare(b.name) : (a.is_dir ? -1 : 1)))

	return files.length === 0
		? { path: target.clean, files: [], note: 'this directory is empty' }
		: { path: target.clean, files }
}

/**
 * Reads one file as raw bytes.
 *
 * Deliberately without an Accept header: Nextcloud renders some types when
 * asked nicely, and for an image or a PDF the bytes are the whole point.
 *
 * @param {string} path file relative to the home
 * @return {Promise<object>} `{path, mime, size, bytes}` or `{error}`
 */
export async function readFile(path) {
	const target = davUrl(path)
	if (target.error) {
		return target
	}
	if (!target.clean) {
		return { error: 'a file path is required' }
	}

	const response = await ncFetch(target.url, { signal: AbortSignal.timeout(FILE_TIMEOUT_MS) })
	if (!response.ok) {
		return response.status === 404
			? { error: `no such file: ${target.clean}` }
			: { error: `could not read the file (HTTP ${response.status})` }
	}

	const bytes = await response.arrayBuffer()

	return {
		path: target.clean,
		mime: (response.headers.get('content-type') ?? 'application/octet-stream').split(';')[0].trim(),
		size: bytes.byteLength,
		bytes,
	}
}

/**
 * Reads a text file and truncates it.
 *
 * @param {string} path file relative to the home
 * @param {number} [maxChars] cap
 * @return {Promise<object>} `{path, text, chars, truncated}` or `{error}`
 */
export async function readText(path, maxChars = MAX_TEXT_CHARS) {
	const file = await readFile(path)
	if (file.error) {
		return file
	}

	// fatal: false — a stray byte in a log file should not lose the whole read
	const raw = new TextDecoder('utf-8', { fatal: false }).decode(file.bytes)
	const truncated = raw.length > maxChars

	return {
		path: file.path,
		mime: file.mime,
		text: truncated ? raw.slice(0, maxChars) : raw,
		chars: truncated ? maxChars : raw.length,
		truncated,
	}
}

/**
 * Base64 for an ArrayBuffer.
 *
 * Chunked because `String.fromCharCode(...bytes)` spreads every byte into an
 * argument, and a few hundred kB of those blow the call stack.
 *
 * @param {ArrayBuffer} buffer bytes
 * @return {string} base64, without a data-uri prefix
 */
export function arrayBufferToBase64(buffer) {
	const bytes = new Uint8Array(buffer)
	const chunk = 8192
	let binary = ''

	for (let i = 0; i < bytes.length; i += chunk) {
		binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
	}

	return btoa(binary)
}
