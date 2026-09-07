/**
 * Skills (issue #17) — the browser half.
 *
 * The server owns the files and the parsing (SkillService). What lives here is
 * the part that has to run in the browser: fetching whatever host a skill
 * declared, directly, with no Nextcloud in the middle.
 *
 * That is the same reason `web_search` goes straight to SearXNG. If a skill's
 * requests went through the server, every weather question would leave a line
 * in someone's access log saying which town the user asked about — for an API
 * the browser can reach perfectly well on its own.
 */

/** Mirrors SkillService::FOLDER_NAME. */
export const SKILLS_FOLDER_NAME = 'Skills'

/** A skill answers a question, it does not download a dataset. */
const MAX_RESPONSE_CHARS = 60000
const FETCH_TIMEOUT_MS = 20000

/**
 * Whether a url may be fetched for a skill.
 *
 * Two independent gates, and both have to hold:
 *
 * 1. https only — a skill is a text file in the user's Files, and a plain http
 *    request sends its arguments across the network in the clear;
 * 2. the host must be declared by some skill, which is also what put it in the
 *    page's CSP. Checking it here as well is not redundant: it turns a
 *    silently blocked request into a message the model can act on, and it
 *    stops one skill's declaration from becoming a general-purpose fetch for
 *    a model that noticed the tool exists.
 *
 * Subdomains do not inherit: `wttr.in` does not permit `evil.wttr.in`. The
 * CSP would allow it — a `connect-src` host entry covers exactly that host,
 * but nothing stops a skill from declaring the subdomain if it needs it.
 *
 * @param {string} raw url as the model wrote it
 * @param {string[]} allowed hostnames from the skills
 * @return {{url: string}|{error: string}} the parsed url, or why not
 */
export function checkSkillUrl(raw, allowed) {
	let parsed
	try {
		parsed = new URL(String(raw ?? '').trim())
	} catch {
		return { error: 'not a valid absolute URL' }
	}

	if (parsed.protocol !== 'https:') {
		return { error: 'only https URLs can be fetched from a skill' }
	}

	const host = parsed.hostname.toLowerCase()
	if (!allowed.includes(host)) {
		const nothingAllowed = 'no skill declares any allowed domain, so nothing can be fetched. '
			+ 'A skill needs "allowed-domains: [example.com]" in its front matter.'

		return {
			error: allowed.length === 0
				? nothingAllowed
				: `${host} is not in any skill's allowed-domains. Allowed: ${allowed.join(', ')}`,
		}
	}

	return { url: parsed.toString() }
}

/**
 * Fetches a url on behalf of a skill.
 *
 * No credentials: this is a foreign origin, and sending the Nextcloud session
 * cookie there would be both pointless and careless. Same reasoning as the
 * SearXNG call in tools.js.
 *
 * The response is returned as text regardless of content type. Skills are
 * written against JSON APIs, and a model that asked for JSON parses it far
 * better than any shape this could invent for it.
 *
 * @param {string} url already checked by checkSkillUrl
 * @return {Promise<{content: string, truncated: boolean, status: number}|{error: string}>} result
 */
export async function fetchForSkill(url) {
	let response
	try {
		response = await fetch(url, {
			method: 'GET',
			headers: { Accept: 'application/json, text/plain;q=0.9, */*;q=0.5' },
			credentials: 'omit',
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		})
	} catch (error) {
		if (error.name === 'TimeoutError') {
			return { error: `no response within ${FETCH_TIMEOUT_MS / 1000} seconds` }
		}

		// From JS, a CSP block and a missing Access-Control-Allow-Origin are
		// the same TypeError. The reload case is the one we cause ourselves,
		// so it goes first.
		return {
			error: 'could not reach the host. Either the page must be reloaded after the '
				+ 'skill was added or changed, or the host does not send '
				+ 'Access-Control-Allow-Origin for this origin.',
		}
	}

	if (!response.ok) {
		return { error: `the host answered with HTTP ${response.status}` }
	}

	let text
	try {
		text = await response.text()
	} catch {
		return { error: 'the response could not be read' }
	}

	const truncated = text.length > MAX_RESPONSE_CHARS

	return {
		status: response.status,
		content: truncated ? text.slice(0, MAX_RESPONSE_CHARS) : text,
		truncated,
	}
}
