/**
 * Agent tools.
 *
 * Split by where they run:
 *
 * - `datetime` — answered locally, that is the whole point (client clock).
 * - `web_search` — the browser queries the user's SearXNG instance directly.
 *   Possible because SearXNG can be told to send `Access-Control-Allow-Origin`;
 *   the Nextcloud server never sees the search terms.
 * - `web_fetch` — goes through this app's backend, because arbitrary third
 *   party sites send no CORS headers and the browser cannot read their
 *   responses. No way around the server for that one.
 */

// Strings in tool results are deliberately not translated: they are read by
// the model, not by the user. The UI-facing summaries are short and derived
// from them.
import axios from '@nextcloud/axios'
import { generateUrl } from '@nextcloud/router'

/**
 * Tool ids as stored per profile. Kept in sync with ProfileService::TOOL_IDS.
 *
 * They are separately selectable because they differ in what they cost:
 * `datetime` and `web_search` never touch the Nextcloud server, `web_fetch`
 * necessarily does.
 */
export const TOOL_IDS = ['datetime', 'web_search', 'web_fetch']

/** Trimmed to keep tool results small; the model can fetch a url for detail. */
const MAX_SEARCH_RESULTS = 8
const SEARCH_TIMEOUT_MS = 20000

/** Maps a tool id to the function name the model sees. */
const FUNCTION_NAMES = {
	datetime: 'get_current_datetime',
	web_search: 'web_search',
	web_fetch: 'web_fetch',
}

/** OpenAI-compatible tool definitions, keyed by tool id. */
const DEFINITIONS = {
	datetime: {
		type: 'function',
		function: {
			name: 'get_current_datetime',
			description: 'Get the current local date and time of the user, including timezone. '
				+ 'Use this whenever the answer depends on the current date or time.',
			parameters: { type: 'object', properties: {}, required: [] },
		},
	},
	web_search: {
		type: 'function',
		function: {
			name: 'web_search',
			description: 'Search the web. Returns a list of results with title, url and snippet. '
				+ 'Snippets are short — fetch a promising result url with web_fetch when you '
				+ 'need the actual content.',
			parameters: {
				type: 'object',
				properties: {
					query: {
						type: 'string',
						description: 'The search query, in the language most likely to yield results.',
					},
				},
				required: ['query'],
			},
		},
	},
	web_fetch: {
		type: 'function',
		function: {
			name: 'web_fetch',
			description: 'Fetch a web page and return its readable text content. '
				+ 'Only http/https URLs on standard ports. Content may be truncated. '
				+ 'Only use URLs the user gave you or that came from web_search results — '
				+ 'never invent or guess a URL.',
			parameters: {
				type: 'object',
				properties: {
					url: {
						type: 'string',
						description: 'The absolute URL to fetch. Must come from the user or from search results.',
					},
				},
				required: ['url'],
			},
		},
	},
}

/**
 * Definitions for the tools a profile allows, in a stable order.
 *
 * @param {string[]} enabled tool ids from the profile
 * @return {Array} OpenAI-compatible tool definitions
 */
export function toolDefinitionsFor(enabled) {
	if (!Array.isArray(enabled) || enabled.length === 0) {
		return []
	}

	return TOOL_IDS.filter((id) => enabled.includes(id)).map((id) => DEFINITIONS[id])
}

/**
 * Reverse lookup: the model answers with function names, the allowlist holds
 * tool ids. Only used to reject calls a profile does not allow.
 *
 * @param {string} functionName name from the tool call
 * @return {string|null} tool id
 */
function toolIdOf(functionName) {
	return Object.keys(FUNCTION_NAMES).find((id) => FUNCTION_NAMES[id] === functionName) ?? null
}

function toolUrl(path) {
	return generateUrl(`/apps/llmchat/api/v1/tools${path}`)
}

function getCurrentDatetime() {
	const now = new Date()

	return {
		iso: now.toISOString(),
		local: now.toString(),
		timezone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'unknown',
		locale_string: now.toLocaleString(),
		unix: Math.floor(now.getTime() / 1000),
	}
}

/**
 * Queries the user's SearXNG instance straight from the browser.
 *
 * @param {string} query search terms
 * @param {string} baseUrl configured instance url
 * @return {Promise<object>} shape the model receives
 */
async function searchWeb(query, baseUrl) {
	if (!baseUrl) {
		return {
			error: 'web search is not configured — no SearXNG instance URL is set in the app settings',
		}
	}

	const url = `${baseUrl.replace(/\/+$/, '')}/search?`
		+ new URLSearchParams({ q: query, format: 'json' }).toString()

	// no credentials: this is a foreign origin, and sending the Nextcloud
	// session cookie there would be both pointless and careless
	let response
	try {
		response = await fetch(url, {
			method: 'GET',
			headers: { Accept: 'application/json' },
			credentials: 'omit',
			signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
		})
	} catch (error) {
		if (error.name === 'TimeoutError') {
			return { error: `the search instance did not respond within ${SEARCH_TIMEOUT_MS / 1000} seconds` }
		}

		// A TypeError here is the browser refusing to read the response. From
		// JS the CSP and CORS cases are indistinguishable, so name both — the
		// reload is the one we cause ourselves.
		return {
			error: 'could not reach the search instance. Either the page must be reloaded '
				+ 'after changing the SearXNG URL, or the instance does not send '
				+ 'Access-Control-Allow-Origin for this origin.',
		}
	}

	if (!response.ok) {
		return response.status === 403
			? { error: 'the search instance rejected the request (HTTP 403) — is the json format enabled in its settings.yml?' }
			: { error: `the search instance answered with HTTP ${response.status}` }
	}

	let payload
	try {
		payload = await response.json()
	} catch {
		return { error: 'the search instance did not return valid JSON' }
	}

	const results = (payload.results ?? [])
		.filter((entry) => entry?.url)
		.slice(0, MAX_SEARCH_RESULTS)
		.map((entry) => ({
			title: String(entry.title ?? '').slice(0, 200),
			url: String(entry.url).slice(0, 1024),
			snippet: String(entry.content ?? '').slice(0, 500),
		}))

	if (results.length === 0) {
		return {
			query,
			results: [],
			// spell it out, otherwise the model reads an empty list as "this
			// does not exist" and starts guessing urls for web_fetch
			note: 'No results for this query. Try rephrasing it, or tell the user the search '
				+ 'returned nothing. Do not guess URLs.',
		}
	}

	return { query, results }
}

/**
 * Executes one tool call and returns the result as a string for the
 * `role: "tool"` message. Never throws: the model handles an error text
 * better than the loop handles an exception.
 *
 * @param {object} call accumulated tool call {id, function: {name, arguments}}
 * @param {string[]} enabled tool ids the profile allows
 * @param {object} options runtime settings ({searxngUrl})
 * @return {Promise<{content: string, summary: string}>} result + short UI label
 */
export async function executeTool(call, enabled = [], options = {}) {
	const name = call.function?.name ?? ''

	// models do invent tools they were never offered; refuse rather than
	// dispatch on a name that was not in this profile's allowlist
	const id = toolIdOf(name)
	if (id === null || !enabled.includes(id)) {
		return {
			content: JSON.stringify({ error: `tool "${name}" is not available` }),
			summary: `${name}: not available`,
		}
	}

	let args = {}
	try {
		args = JSON.parse(call.function?.arguments || '{}')
	} catch {
		return {
			content: JSON.stringify({ error: 'invalid JSON in tool arguments' }),
			summary: `${name}: invalid arguments`,
		}
	}

	try {
		switch (name) {
		case 'get_current_datetime': {
			const result = getCurrentDatetime()
			return {
				content: JSON.stringify(result),
				summary: result.locale_string,
			}
		}

		case 'web_search': {
			const query = String(args.query ?? '').trim()
			if (!query) {
				return { content: JSON.stringify({ error: 'query missing' }), summary: 'web_search: query missing' }
			}
			const data = await searchWeb(query, options.searxngUrl ?? '')
			return {
				content: JSON.stringify(data),
				summary: data.error
					? `"${query}" — ${data.error}`
					: `"${query}" — ${data.results.length === 0 ? 'no results' : `${data.results.length} results`}`,
			}
		}

		case 'web_fetch': {
			const url = String(args.url ?? '').trim()
			if (!url) {
				return { content: JSON.stringify({ error: 'url missing' }), summary: 'web_fetch: url missing' }
			}
			const { data } = await axios.post(toolUrl('/fetch'), { url })
			return {
				content: JSON.stringify(data),
				summary: data.title ? `${data.title} (${url})` : url,
			}
		}

		default:
			return {
				content: JSON.stringify({ error: `unknown tool: ${name}` }),
				summary: `unknown tool: ${name}`,
			}
		}
	} catch (error) {
		const message = error?.response?.data?.message ?? error.message ?? 'unknown error'

		return {
			content: JSON.stringify({ error: message }),
			summary: `${name} failed: ${message}`,
		}
	}
}
