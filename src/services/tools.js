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
import * as nc from './nextcloud.js'

/**
 * Tool ids as stored per profile. Kept in sync with ProfileService::TOOL_IDS.
 *
 * They are separately selectable because they differ in what they cost:
 * `datetime` and `web_search` never touch the Nextcloud server, `web_fetch`
 * necessarily does, and `nc_read` reads your own Nextcloud content.
 *
 * One id can expose several functions — `nc_read` is a single checkbox in the
 * profile but four functions for the model, because "search", "list" and
 * "read" are much easier for a model to aim at than one call with a mode
 * parameter.
 */
export const TOOL_IDS = ['datetime', 'web_search', 'web_fetch', 'nc_read']

/**
 * Tools whose effects warrant asking the user first (spec: approval mode).
 * `web_search` is deliberately absent — confirming every research query would
 * make the feature unusable, and a search leaks far less than a fetch.
 */
export const APPROVAL_TOOLS = ['web_fetch', 'nc_read']

/** Trimmed to keep tool results small; the model can fetch a url for detail. */
const MAX_SEARCH_RESULTS = 8
const SEARCH_TIMEOUT_MS = 20000

/** OpenAI-compatible tool definitions, keyed by tool id. */
const DEFINITIONS = {
	datetime: [{
		type: 'function',
		function: {
			name: 'get_current_datetime',
			description: 'Get the current local date and time of the user, including timezone. '
				+ 'Use this whenever the answer depends on the current date or time.',
			parameters: { type: 'object', properties: {}, required: [] },
		},
	}],
	web_search: [{
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
	}],
	web_fetch: [{
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
	}],

	// One checkbox, four functions. Read-only throughout: nothing here can
	// change anything in Nextcloud.
	nc_read: [{
		type: 'function',
		function: {
			name: 'nc_search',
			description: "Search the user's own Nextcloud — files, calendar events, contacts, "
				+ 'notes, collectives, Deck cards, Talk messages. Returns titles and links, '
				+ 'not full content. Use this to find out what exists, then read it with a '
				+ 'more specific tool.',
			parameters: {
				type: 'object',
				properties: {
					query: { type: 'string', description: 'What to look for.' },
					provider: {
						type: 'string',
						description: 'Optional provider id to restrict the search, e.g. "files" '
							+ 'or "calendar". Omit to search everything.',
					},
				},
				required: ['query'],
			},
		},
	}, {
		type: 'function',
		function: {
			name: 'nc_list_collectives',
			description: "List the user's collectives (shared wikis). Returns their ids and names.",
			parameters: { type: 'object', properties: {}, required: [] },
		},
	}, {
		type: 'function',
		function: {
			name: 'nc_list_pages',
			description: 'List the pages of one collective. Returns page ids and titles, not '
				+ 'their text. Use nc_read_page for the content.',
			parameters: {
				type: 'object',
				properties: {
					collective_id: { type: 'integer', description: 'From nc_list_collectives.' },
					query: {
						type: 'string',
						description: 'Optional full text filter. Omit to list all pages.',
					},
				},
				required: ['collective_id'],
			},
		},
	}, {
		type: 'function',
		function: {
			name: 'nc_read_page',
			description: 'Read the markdown content of one collective page. Content may be '
				+ 'truncated.',
			parameters: {
				type: 'object',
				properties: {
					collective_id: { type: 'integer', description: 'From nc_list_collectives.' },
					page_id: { type: 'integer', description: 'From nc_list_pages.' },
				},
				required: ['collective_id', 'page_id'],
			},
		},
	}],
}

/**
 * Which tool id owns a given function name. Derived from the definitions so
 * the two can never drift apart.
 */
const TOOL_ID_BY_FUNCTION = Object.fromEntries(
	Object.entries(DEFINITIONS).flatMap(
		([id, defs]) => defs.map((d) => [d.function.name, id]),
	),
)

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

	return TOOL_IDS.filter((id) => enabled.includes(id)).flatMap((id) => DEFINITIONS[id])
}

/**
 * Reverse lookup: the model answers with function names, the allowlist holds
 * tool ids. Used to reject calls a profile does not allow, and to decide
 * whether a call needs approval.
 *
 * @param {string} functionName name from the tool call
 * @return {string|null} tool id
 */
export function toolIdOf(functionName) {
	return TOOL_ID_BY_FUNCTION[functionName] ?? null
}

/**
 * Whether a call should be shown to the user before it runs.
 *
 * @param {string} functionName name from the tool call
 * @return {boolean} true when approval applies
 */
export function needsApproval(functionName) {
	return APPROVAL_TOOLS.includes(toolIdOf(functionName))
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

		case 'nc_search': {
			const query = String(args.query ?? '').trim()
			const data = await nc.search(query, { provider: args.provider || null })
			const count = (data.results ?? []).reduce((sum, r) => sum + r.entries.length, 0)
			return {
				content: JSON.stringify(data),
				summary: data.error
					? `nc_search: ${data.error}`
					: `"${query}" — ${count === 0 ? 'nothing found' : `${count} hits`}`,
			}
		}

		case 'nc_list_collectives': {
			const data = await nc.listCollectives()
			return {
				content: JSON.stringify(data),
				summary: `${data.collectives.length} collectives`,
			}
		}

		case 'nc_list_pages': {
			const collectiveId = Number(args.collective_id)
			if (!collectiveId) {
				return {
					content: JSON.stringify({ error: 'collective_id missing' }),
					summary: 'nc_list_pages: collective_id missing',
				}
			}
			const query = String(args.query ?? '').trim()
			const data = query
				? await nc.searchCollective(collectiveId, query)
				: await nc.listPages(collectiveId)
			return {
				content: JSON.stringify(data),
				summary: data.error
					? `nc_list_pages: ${data.error}`
					: `${data.pages.length} pages${query ? ` matching "${query}"` : ''}`,
			}
		}

		case 'nc_read_page': {
			const collectiveId = Number(args.collective_id)
			const pageId = Number(args.page_id)
			if (!collectiveId || !pageId) {
				return {
					content: JSON.stringify({ error: 'collective_id and page_id are required' }),
					summary: 'nc_read_page: missing ids',
				}
			}
			const data = await nc.readPage(collectiveId, pageId)
			return {
				content: JSON.stringify(data),
				summary: data.error
					? `nc_read_page: ${data.error}`
					: `${data.title}${data.truncated ? ' (truncated)' : ''}`,
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
