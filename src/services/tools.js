/**
 * Agent tools.
 *
 * Split by where they run: `datetime` is answered locally in the browser
 * (client local time, exactly the point of the tool), `web_search` and
 * `web_fetch` call the app's own backend, which performs the network access —
 * the browser cannot fetch foreign origins (CORS), the server can.
 */

import axios from '@nextcloud/axios'
import { generateUrl } from '@nextcloud/router'

/**
 * Tool ids as stored per profile. Kept in sync with ProfileService::TOOL_IDS.
 *
 * They are separately selectable because they differ in what they cost:
 * `datetime` never leaves the browser, the two web tools route through the
 * Nextcloud server.
 */
export const TOOL_IDS = ['datetime', 'web_search', 'web_fetch']

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
 * Executes one tool call and returns the result as a string for the
 * `role: "tool"` message. Never throws: the model handles an error text
 * better than the loop handles an exception.
 *
 * @param {object} call accumulated tool call {id, function: {name, arguments}}
 * @param {string[]} enabled tool ids the profile allows
 * @return {Promise<{content: string, summary: string}>} result + short UI label
 */
export async function executeTool(call, enabled = []) {
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
			const { data } = await axios.post(toolUrl('/search'), { query })
			const count = data.results?.length ?? 0
			return {
				content: JSON.stringify(data),
				summary: `"${query}" — ${count === 0 ? 'no results' : `${count} results`}`,
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
