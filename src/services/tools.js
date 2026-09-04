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
import { pdfPageToImage, pdfToText } from './pdf.js'

/**
 * Tool ids as stored per profile. Kept in sync with ProfileService::TOOL_IDS.
 *
 * They are separately selectable because they differ in what they cost:
 * `datetime` and `web_search` never touch the Nextcloud server, `web_fetch`
 * necessarily does, and `nc_read` reads your own Nextcloud content.
 *
 * One id can expose several functions — `nc_read` is a single checkbox in the
 * profile but nine functions for the model, because "search", "list" and
 * "read" are much easier for a model to aim at than one call with a mode
 * parameter.
 */
export const TOOL_IDS = ['datetime', 'web_search', 'web_fetch', 'nc_read']

/**
 * Tools whose effects warrant asking the user first (spec: approval mode).
 * `web_search` is deliberately absent — confirming every research query would
 * make the feature unusable, and a search leaks far less than a fetch.
 *
 * The file tools need no entry of their own: they live under `nc_read`, so
 * they inherit its approval automatically.
 */
export const APPROVAL_TOOLS = ['web_fetch', 'nc_read']

/**
 * Functions that hand actual image data to the model. Only offered when the
 * profile says the model can see — everything else gets a wall of base64 it
 * cannot read, at full token price.
 */
export const VISION_TOOLS = ['nc_read_image', 'nc_read_pdf_page']

/** Trimmed to keep tool results small; the model can fetch a url for detail. */
const MAX_SEARCH_RESULTS = 8
const SEARCH_TIMEOUT_MS = 20000

/**
 * Hard ceiling for `max_chars`. The default is much lower; this only stops a
 * model from asking for a whole novel in one go.
 */
const MAX_TEXT_CHARS_CAP = 120000

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

	// One checkbox, nine functions. Read-only throughout: nothing here can
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
	}, {
		type: 'function',
		function: {
			name: 'nc_list_files',
			description: "List files and directories in the user's Nextcloud, by path relative "
				+ 'to their home (e.g. "Documents" or "Documents/2025"). Returns name, size '
				+ 'and whether an entry is a directory. Use this to find out what exists, then '
				+ 'read it with nc_read_text (text, markdown, csv, log), nc_read_pdf / '
				+ 'nc_read_pdf_page (PDFs) or nc_read_image (photos).',
			parameters: {
				type: 'object',
				properties: {
					path: {
						type: 'string',
						description: 'Directory path relative to the home. Omit or pass "" for the root.',
					},
				},
				required: [],
			},
		},
	}, {
		type: 'function',
		function: {
			name: 'nc_read_text',
			description: 'Read a text file (markdown, plain text, csv, html, log) from '
				+ 'Nextcloud. Content may be truncated. Not for PDFs — use nc_read_pdf.',
			parameters: {
				type: 'object',
				properties: {
					path: {
						type: 'string',
						description: 'File path relative to the home, e.g. "Documents/notes.md".',
					},
					max_chars: {
						type: 'integer',
						description: 'Optional cap on the returned text. Defaults to 24000.',
					},
				},
				required: ['path'],
			},
		},
	}, {
		type: 'function',
		function: {
			name: 'nc_read_pdf',
			// the vision variant is substituted in toolDefinitionsFor(); this
			// one must not name nc_read_pdf_page, which does not exist without
			// it
			description: 'Extract the text of a PDF stored in Nextcloud. Good for text-heavy '
				+ 'documents; layout, tables and diagrams are lost — the words survive, where '
				+ 'they sat does not. Returns nothing for a scanned document. May be truncated.',
			parameters: {
				type: 'object',
				properties: {
					path: {
						type: 'string',
						description: 'File path relative to the home, e.g. "Documents/report.pdf".',
					},
					max_chars: {
						type: 'integer',
						description: 'Optional cap across all pages. Defaults to 24000.',
					},
				},
				required: ['path'],
			},
		},
	}, {
		type: 'function',
		function: {
			name: 'nc_read_image',
			description: 'Load an image (jpg, png, webp, gif) from Nextcloud and look at it. '
				+ 'The image arrives in the next message. Only one image per answer, and at '
				+ 'most 10 MB — pick the one that matters.',
			parameters: {
				type: 'object',
				properties: {
					path: {
						type: 'string',
						description: 'File path relative to the home, e.g. "Photos/holiday.jpg".',
					},
				},
				required: ['path'],
			},
		},
	}, {
		type: 'function',
		function: {
			name: 'nc_read_pdf_page',
			description: 'Render one page of a PDF from Nextcloud as an image and look at it. '
				+ 'Use this when layout, tables, diagrams or a scan matter, or when nc_read_pdf '
				+ 'returned no text. Counts against the one-image-per-answer limit.',
			parameters: {
				type: 'object',
				properties: {
					path: {
						type: 'string',
						description: 'File path relative to the home.',
					},
					page: {
						type: 'integer',
						description: 'Page number, 1-based.',
					},
				},
				required: ['path', 'page'],
			},
		},
	}],
}

/**
 * Which tool id owns a given function name. Derived from the definitions so
 * the two can never drift apart.
 */
const TOOL_ID_BY_FUNCTION = Object.fromEntries(Object.entries(DEFINITIONS).flatMap(([id, defs]) => defs.map((d) => [d.function.name, id])))

/**
 * Descriptions that only make sense when the image tools are on offer.
 *
 * A timetable extracts to a few hundred words in reading order, which looks
 * like a successful call and reads like nonsense — so with vision available,
 * say up front which documents to render instead of extract, rather than
 * leaving the model to discover it from the result.
 */
const VISION_DESCRIPTIONS = {
	nc_read_pdf: 'Extract the text of a PDF stored in Nextcloud. Only for text-heavy '
		+ 'documents — letters, contracts, articles. For a timetable, form, table or anything '
		+ 'where position on the page carries meaning, use nc_read_pdf_page instead: '
		+ 'extraction keeps the words but loses rows and columns, and the result reads '
		+ 'plausibly while saying nothing. Returns nothing at all for a scan. May be truncated.',
}

/**
 * Definitions for the tools a profile allows, in a stable order.
 *
 * @param {string[]} enabled tool ids from the profile
 * @param {object} [options] options
 * @param {boolean} [options.vision] the model can see images
 * @return {Array} OpenAI-compatible tool definitions
 */
export function toolDefinitionsFor(enabled, { vision = false } = {}) {
	if (!Array.isArray(enabled) || enabled.length === 0) {
		return []
	}

	return TOOL_IDS
		.filter((id) => enabled.includes(id))
		.flatMap((id) => DEFINITIONS[id])
		.filter((definition) => vision || !VISION_TOOLS.includes(definition.function.name))
		.map((definition) => {
			const swap = vision ? VISION_DESCRIPTIONS[definition.function.name] : null

			// copied, not mutated: DEFINITIONS is module state shared by every
			// profile, and one vision profile must not rewrite what the next
			// text-only one is offered
			return swap
				? { ...definition, function: { ...definition.function, description: swap } }
				: definition
		})
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

/** Shorthand for the error shape the model gets back. */
function fail(name, message) {
	return { content: JSON.stringify({ error: message }), summary: `${name}: ${message}` }
}

function clampChars(value) {
	const requested = Number(value ?? nc.MAX_TEXT_CHARS)

	return Number.isFinite(requested)
		? Math.min(Math.max(1, Math.floor(requested)), MAX_TEXT_CHARS_CAP)
		: nc.MAX_TEXT_CHARS
}

/**
 * Executes one tool call and returns the result as a string for the
 * `role: "tool"` message. Never throws: the model handles an error text
 * better than the loop handles an exception.
 *
 * Image results carry their data in a separate `image` field, never inside
 * `content` — the caller turns it into a proper multimodal message, and a
 * megabyte of base64 has no business in a `role: "tool"` string.
 *
 * @param {object} call accumulated tool call {id, function: {name, arguments}}
 * @param {string[]} enabled tool ids the profile allows
 * @param {object} options runtime settings ({searxngUrl, vision})
 * @return {Promise<{content: string, summary: string, image?: object}>} result + short UI label
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

	// second line of defence: these are already filtered out of the
	// definitions, but a model that guessed the name still must not get a
	// picture it cannot read
	if (VISION_TOOLS.includes(name) && options.vision !== true) {
		return fail(name, 'this model is not set up to see images')
	}

	let args
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

			case 'nc_list_files': {
				const path = String(args.path ?? '').trim()
				const data = await nc.listFiles(path)
				if (data.error) {
					return fail(name, data.error)
				}
				return {
					content: JSON.stringify(data),
					summary: `${data.files.length} entries in ${data.path || '/'}`,
				}
			}

			case 'nc_read_text': {
				const path = String(args.path ?? '').trim()
				if (!path) {
					return fail(name, 'path missing')
				}
				const data = await nc.readText(path, clampChars(args.max_chars))
				if (data.error) {
					return fail(name, data.error)
				}
				return {
					content: JSON.stringify(data),
					summary: `${data.path} — ${data.chars} chars${data.truncated ? ' (truncated)' : ''}`,
				}
			}

			case 'nc_read_pdf': {
				const path = String(args.path ?? '').trim()
				if (!path) {
					return fail(name, 'path missing')
				}
				const file = await nc.readFile(path)
				if (file.error) {
					return fail(name, file.error)
				}
				// vision decides how a text-less PDF gets explained: pointing
				// at nc_read_pdf_page only helps when that tool is on offer
				const parsed = await pdfToText(file.bytes, {
					maxChars: clampChars(args.max_chars),
					vision: options.vision === true,
				})
				return {
					content: JSON.stringify({ path: file.path, ...parsed }),
					summary: `${file.path} — ${parsed.num_pages} pages, `
						+ `${parsed.total_chars} chars${parsed.truncated ? ' (truncated)' : ''}`,
				}
			}

			case 'nc_read_image': {
				const path = String(args.path ?? '').trim()
				if (!path) {
					return fail(name, 'path missing')
				}
				// the transfer stops at the image limit rather than the general
				// one, so an oversized photo costs a few chunks, not 10 MB
				const file = await nc.readFile(path, { maxBytes: nc.MAX_IMAGE_BYTES })
				if (file.error) {
					return fail(name, file.error)
				}
				if (!file.mime.startsWith('image/')) {
					return fail(name, `${file.path} is ${file.mime}, not an image`)
				}
				return {
					// the bytes travel in `image`, not in the tool result
					content: JSON.stringify({
						path: file.path,
						mime: file.mime,
						size: file.size,
						note: 'the image follows in the next message',
					}),
					summary: `${file.path} (${Math.round(file.size / 1024)} KB, ${file.mime})`,
					image: {
						b64: nc.arrayBufferToBase64(file.bytes),
						mime: file.mime,
						label: `${file.path} (${Math.round(file.size / 1024)} KB)`,
					},
				}
			}

			case 'nc_read_pdf_page': {
				const path = String(args.path ?? '').trim()
				const page = Math.floor(Number(args.page ?? 0))
				if (!path || !Number.isFinite(page) || page < 1) {
					return fail(name, 'path and a 1-based page number are required')
				}
				const file = await nc.readFile(path)
				if (file.error) {
					return fail(name, file.error)
				}
				const rendered = await pdfPageToImage(file.bytes, page)
				if (rendered.error) {
					return fail(name, rendered.error)
				}
				if (rendered.size > nc.MAX_IMAGE_BYTES) {
					return fail(name, 'the rendered page came out larger than 10 MB — use nc_read_pdf instead')
				}
				return {
					content: JSON.stringify({
						path: file.path,
						page: rendered.page,
						mime: rendered.mime,
						width: rendered.width,
						height: rendered.height,
						note: 'the rendered page follows in the next message',
					}),
					summary: `${file.path} page ${rendered.page} (${rendered.width}×${rendered.height})`,
					image: {
						b64: rendered.b64,
						mime: rendered.mime,
						label: `${file.path}, page ${rendered.page}`,
					},
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
