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

/** OpenAI-compatible tool definitions sent with the request. */
export const TOOL_DEFINITIONS = [
	{
		type: 'function',
		function: {
			name: 'get_current_datetime',
			description: 'Get the current local date and time of the user, including timezone. '
				+ 'Use this whenever the answer depends on the current date or time.',
			parameters: { type: 'object', properties: {}, required: [] },
		},
	},
	{
		type: 'function',
		function: {
			name: 'web_search',
			description: 'Search the web. Returns a list of results with title, url and snippet. '
				+ 'Results may be partial; fetch a result url with web_fetch for details.',
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
	{
		type: 'function',
		function: {
			name: 'web_fetch',
			description: 'Fetch a web page and return its readable text content. '
				+ 'Only http/https URLs on standard ports. Content may be truncated.',
			parameters: {
				type: 'object',
				properties: {
					url: {
						type: 'string',
						description: 'The absolute URL to fetch.',
					},
				},
				required: ['url'],
			},
		},
	},
]

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
 * @return {Promise<{content: string, summary: string}>} result + short UI label
 */
export async function executeTool(call) {
	const name = call.function?.name ?? ''

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
			return {
				content: JSON.stringify(data),
				summary: `"${query}" — ${data.results?.length ?? 0} results (${data.provider})`,
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
