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
/** page content handed to the model; roughly 6k tokens */
const MAX_PAGE_CHARS = 24000

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

	const settled = await Promise.allSettled(
		providers.map(async (p) => {
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
		}),
	)

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
	const data = await ocs(
		generateOcsUrl('apps/collectives/api/v1.0/collectives/{id}/pages', { id: collectiveId }),
	)

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
	const data = await ocs(
		generateOcsUrl('apps/collectives/api/v1.0/collectives/{cid}/pages/{pid}', {
			cid: collectiveId,
			pid: pageId,
		}),
	)

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
	const truncated = raw.length > MAX_PAGE_CHARS

	return {
		title: page.title,
		collective_id: collectiveId,
		page_id: pageId,
		content: truncated ? raw.slice(0, MAX_PAGE_CHARS) : raw,
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


