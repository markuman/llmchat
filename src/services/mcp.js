/**
 * MCP client (issue #11) — just enough of the protocol for tools.
 *
 * Every message goes through this app's proxy (`/api/v1/mcp/{id}/rpc`):
 * MCP servers send no CORS headers, and the tokens never leave the server.
 * The proxy speaks Streamable HTTP to the server; what reaches this file is
 * always one JSON-RPC answer.
 *
 * Three methods and one notification, nothing else: `initialize`,
 * `notifications/initialized`, `tools/list` and `tools/call`. No resources,
 * prompts, sampling or elicitation — and no SDK, since that much JSON-RPC is
 * shorter than the import.
 *
 * The session (Mcp-Session-Id) and the tool list are kept per page load:
 * every chat turn needs the definitions, and a round trip through the proxy
 * per server per message would be the kind of latency nobody asked for.
 */

import axios from '@nextcloud/axios'
import { generateUrl } from '@nextcloud/router'

export const PROTOCOL_VERSION = '2025-06-18'

/** Where the OAuth popup reports back, see src/oauthcallback.js. */
export const MCP_OAUTH_CHANNEL = 'llmchat-mcp-oauth'

/** Every function the model sees from an MCP server starts with this. */
export const MCP_PREFIX = 'mcp_'

/** How long listing one server's tools may take before the chat goes on without it. */
const LIST_TIMEOUT_MS = 15000
/** A tool call is allowed longer — route planning, a build, a search. */
const CALL_TIMEOUT_MS = 130000
/** tools/list pages to follow; a server with more is not one to hand a model whole. */
const MAX_LIST_PAGES = 5
/** Per server. Beyond this, most models stop picking tools reliably at all. */
const MAX_TOOLS_PER_SERVER = 40
const MAX_DESCRIPTION_CHARS = 1024
const MAX_INSTRUCTIONS_CHARS = 2000
/** What a single result may put into the context, roughly 8k tokens. */
const MAX_RESULT_CHARS = 32000
/** OpenAI's limit on function names. */
const MAX_FUNCTION_NAME = 64

/**
 * Thrown when a server wants a sign-in the proxy does not have. Its own
 * class so the chat can say "go to the settings" instead of letting the
 * model retry the same call.
 */
export class McpAuthRequired extends Error {
	constructor(server, message) {
		super(message || `${server.name} needs you to sign in`)
		this.name = 'McpAuthRequired'
		this.server = server
	}
}

/** serverId → Promise<{sessionId, instructions}> */
const sessions = new Map()
/** serverId → {key, promise}, where key changes whenever the server was edited */
const catalogues = new Map()
/** function name → {server, tool}, rebuilt with every definitionsFor() */
const registry = new Map()

let nextId = 1

function rpcUrl(serverId) {
	return generateUrl(`/apps/llmchat/api/v1/mcp/${serverId}/rpc`)
}

/**
 * One message through the proxy. The payload travels as a string, so that
 * `{}` in the arguments is still `{}` when it arrives at the server.
 *
 * @param {object} server server from the config store
 * @param {object} message JSON-RPC message
 * @param {string|null} sessionId Mcp-Session-Id, once there is one
 * @param {object} options options
 * @param {AbortSignal} [options.signal] abort signal
 * @param {number} options.timeout milliseconds
 * @return {Promise<object>} the proxy's envelope
 */
async function post(server, message, sessionId, { signal, timeout }) {
	try {
		const { data } = await axios.post(
			rpcUrl(server.id),
			{ payload: JSON.stringify(message), session_id: sessionId ?? null },
			{ signal, timeout },
		)

		return data
	} catch (error) {
		if (axios.isCancel?.(error) || error?.name === 'CanceledError') {
			throw new DOMException('aborted', 'AbortError')
		}
		if (error?.code === 'ECONNABORTED') {
			throw new Error(`${server.name} did not answer within ${Math.round(timeout / 1000)} seconds`, { cause: error })
		}

		throw new Error(error?.response?.data?.message ?? error?.message ?? 'MCP request failed', { cause: error })
	}
}

function unwrap(server, envelope) {
	if (envelope?.ok) {
		return envelope
	}
	if (envelope?.reason === 'auth_required') {
		throw new McpAuthRequired(server, envelope.message)
	}

	throw new Error(envelope?.message || `${server.name}: MCP request failed`)
}

async function initialize(server, { signal }) {
	const envelope = unwrap(server, await post(server, {
		jsonrpc: '2.0',
		id: nextId++,
		method: 'initialize',
		params: {
			protocolVersion: PROTOCOL_VERSION,
			// tools only: no roots, no sampling, no elicitation
			capabilities: {},
			clientInfo: { name: 'llmchat', title: 'LLM Chat for Nextcloud', version: '1' },
		},
	}, null, { signal, timeout: LIST_TIMEOUT_MS }))

	const answer = envelope.message
	if (answer?.error) {
		throw new Error(`${server.name}: ${answer.error.message ?? 'initialize failed'}`)
	}

	const sessionId = envelope.session_id ?? null

	// Some servers refuse every request until they have seen this. The
	// answer is a bare 202, and a server that does not care about it
	// failing is no reason to give up on the session.
	try {
		await post(server, { jsonrpc: '2.0', method: 'notifications/initialized' }, sessionId, {
			signal,
			timeout: LIST_TIMEOUT_MS,
		})
	} catch (error) {
		if (error.name === 'AbortError') {
			throw error
		}
	}

	return {
		sessionId,
		instructions: String(answer?.result?.instructions ?? '').trim().slice(0, MAX_INSTRUCTIONS_CHARS),
	}
}

function session(server, options) {
	if (!sessions.has(server.id)) {
		const pending = initialize(server, options)
		// a failed handshake must not stay cached as the answer forever
		pending.catch(() => sessions.delete(server.id))
		sessions.set(server.id, pending)
	}

	return sessions.get(server.id)
}

/**
 * A request inside the session, re-initialising once if the server says the
 * session is gone (HTTP 404 with a session id — the spec's way of saying so).
 *
 * @param {object} server server
 * @param {string} method JSON-RPC method
 * @param {object} params params
 * @param {object} options {signal, timeout}
 * @return {Promise<object>} the JSON-RPC result
 */
async function request(server, method, params, options) {
	for (let attempt = 0; attempt < 2; attempt++) {
		const { sessionId } = await session(server, options)
		const envelope = await post(server, { jsonrpc: '2.0', id: nextId++, method, params }, sessionId, options)

		if (envelope?.reason === 'session_expired') {
			sessions.delete(server.id)
			continue
		}
		if (envelope?.reason === 'auth_required') {
			sessions.delete(server.id)
		}

		const answer = unwrap(server, envelope).message
		if (answer?.error) {
			throw new Error(`${server.name}: ${answer.error.message ?? `error ${answer.error.code}`}`)
		}

		return answer?.result ?? {}
	}

	throw new Error(`${server.name} keeps dropping the session`)
}

/**
 * FNV-1a, base36. Only has to tell two tool names apart that sanitise to
 * the same function name.
 *
 * @param {string} text input
 * @return {string} six characters
 */
function shortHash(text) {
	let hash = 0x811c9dc5
	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i)
		hash = Math.imul(hash, 0x01000193) >>> 0
	}

	return hash.toString(36).padStart(6, '0').slice(-6)
}

/**
 * `mcp_{slug}_{tool}`: the prefix keeps MCP tools from ever colliding with
 * the built-in ones, and the slug tells the user in the approval dialog
 * which server a call goes to.
 *
 * @param {object} server server with slug
 * @param {string} toolName name as the server reported it
 * @param {Set<string>} taken names already handed out
 * @return {string} a valid, unique function name
 */
export function functionNameFor(server, toolName, taken = new Set()) {
	const slug = String(server.slug || `s${server.id}`).replace(/[^a-z0-9]/gi, '').toLowerCase() || `s${server.id}`
	const clean = String(toolName).replace(/[^a-zA-Z0-9_-]/g, '_')
	let name = `${MCP_PREFIX}${slug}_${clean}`

	if (name.length > MAX_FUNCTION_NAME || taken.has(name)) {
		name = `${name.slice(0, MAX_FUNCTION_NAME - 7)}_${shortHash(`${server.id}:${toolName}`)}`
	}

	return name
}

/**
 * MCP's inputSchema is JSON Schema already, which is what the function
 * definition wants too — only tidied: always an object schema, and without
 * the `$schema` key some backends choke on.
 *
 * @param {object} schema inputSchema
 * @return {object} parameters
 */
function toParameters(schema) {
	const copy = schema && typeof schema === 'object' && !Array.isArray(schema)
		? JSON.parse(JSON.stringify(schema))
		: {}
	delete copy.$schema

	copy.type = 'object'
	if (!copy.properties || typeof copy.properties !== 'object' || Array.isArray(copy.properties)) {
		copy.properties = {}
	}

	return copy
}

/**
 * @param {object} server server
 * @param {object} tool MCP tool
 * @param {string} name function name
 * @return {object} OpenAI-compatible tool definition
 */
export function toDefinition(server, tool, name) {
	const description = String(tool.description ?? tool.title ?? '').trim()

	return {
		type: 'function',
		function: {
			name,
			// the server name up front: two servers may both have a "search"
			description: `[${server.name}] ${description}`.slice(0, MAX_DESCRIPTION_CHARS),
			parameters: toParameters(tool.inputSchema),
		},
	}
}

async function fetchCatalogue(server, options) {
	const { instructions } = await session(server, options)

	const tools = []
	let cursor
	for (let page = 0; page < MAX_LIST_PAGES && tools.length < MAX_TOOLS_PER_SERVER; page++) {
		const result = await request(server, 'tools/list', cursor ? { cursor } : {}, options)
		tools.push(...(Array.isArray(result.tools) ? result.tools : []))

		cursor = result.nextCursor
		if (!cursor) {
			break
		}
	}

	return {
		instructions,
		tools: tools
			.filter((tool) => tool && typeof tool.name === 'string' && tool.name !== '')
			.slice(0, MAX_TOOLS_PER_SERVER),
	}
}

/**
 * One server's tools, cached for the page load. The cache key includes
 * `updated_at`, so editing a server in the settings is enough to make the
 * next chat turn ask again.
 *
 * @param {object} server server
 * @param {object} [options] options
 * @param {AbortSignal} [options.signal] abort signal
 * @param {boolean} [options.fresh] skip the cache
 * @return {Promise<{tools: Array, instructions: string}>} the catalogue
 */
export function listTools(server, { signal, fresh = false } = {}) {
	const key = `${server.url}|${server.auth_type}|${server.updated_at}`
	const cached = catalogues.get(server.id)
	if (!fresh && cached?.key === key) {
		return cached.promise
	}

	if (fresh) {
		sessions.delete(server.id)
	}

	const promise = fetchCatalogue(server, { signal, timeout: LIST_TIMEOUT_MS })
	promise.catch(() => {
		if (catalogues.get(server.id)?.promise === promise) {
			catalogues.delete(server.id)
		}
	})
	catalogues.set(server.id, { key, promise })

	return promise
}

function withTimeout(promise, ms, message) {
	let timer
	const timeout = new Promise((resolve, reject) => {
		timer = setTimeout(() => reject(new Error(message)), ms)
	})

	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

/**
 * Definitions for every given server, fault tolerant: a server that is down,
 * slow or wants a sign-in drops out of this turn with a reason, and the chat
 * goes on with everything else. One broken MCP server must not be able to
 * take the whole chat with it.
 *
 * @param {Array} servers enabled servers
 * @param {object} [options] options
 * @param {AbortSignal} [options.signal] abort signal
 * @return {Promise<{definitions: Array, instructions: Array, failures: Array}>}
 *   failures as `{server, message, authRequired}`
 */
export async function definitionsFor(servers, { signal } = {}) {
	registry.clear()

	const settled = await Promise.allSettled(servers.map((server) => withTimeout(
		listTools(server, { signal }),
		LIST_TIMEOUT_MS + 2000,
		`${server.name} did not answer in time`,
	)))

	if (signal?.aborted) {
		throw new DOMException('aborted', 'AbortError')
	}

	const definitions = []
	const instructions = []
	const failures = []
	const taken = new Set()

	settled.forEach((outcome, index) => {
		const server = servers[index]

		if (outcome.status === 'rejected') {
			failures.push({
				server,
				message: outcome.reason?.message ?? 'unreachable',
				authRequired: outcome.reason instanceof McpAuthRequired,
			})
			return
		}

		for (const tool of outcome.value.tools) {
			const name = functionNameFor(server, tool.name, taken)
			taken.add(name)
			registry.set(name, { server, tool })
			definitions.push(toDefinition(server, tool, name))
		}

		if (outcome.value.instructions) {
			instructions.push({ server, text: outcome.value.instructions })
		}
	})

	return { definitions, instructions, failures }
}

/**
 * @param {string} functionName name from a tool call
 * @return {boolean} whether it is one of ours
 */
export function isMcpFunction(functionName) {
	return typeof functionName === 'string' && registry.has(functionName)
}

/**
 * @param {string} functionName name from a tool call
 * @return {{server: object, tool: object}|null} what it maps to
 */
export function describeFunction(functionName) {
	return registry.get(functionName) ?? null
}

/**
 * Text out of a tool result. Only text is supported (issue #11): images and
 * audio are named but left out, embedded text resources are inlined, links
 * are listed. `structuredContent` is used when there is nothing else — the
 * spec wants servers to send a text copy too, but not all of them do.
 *
 * @param {object} result tools/call result
 * @return {{text: string, isError: boolean, truncated: boolean}} for the model
 */
export function resultToText(result) {
	const parts = []

	for (const item of Array.isArray(result?.content) ? result.content : []) {
		if (item?.type === 'text') {
			parts.push(String(item.text ?? ''))
		} else if (item?.type === 'resource' && typeof item.resource?.text === 'string') {
			parts.push(item.resource.text)
		} else if (item?.type === 'resource_link') {
			parts.push(`[link: ${item.name ?? item.title ?? ''} ${item.uri ?? ''}]`.trim())
		} else if (item?.type) {
			parts.push(`[${item.type} content omitted — this client only reads text]`)
		}
	}

	if (parts.length === 0 && result?.structuredContent !== undefined) {
		parts.push(JSON.stringify(result.structuredContent))
	}

	const text = parts.join('\n\n')
	const truncated = text.length > MAX_RESULT_CHARS

	return {
		text: truncated ? text.slice(0, MAX_RESULT_CHARS) : text,
		isError: result?.isError === true,
		truncated,
	}
}

/**
 * @param {string} functionName name from the tool call
 * @param {object} args parsed arguments
 * @param {object} [options] options
 * @param {AbortSignal} [options.signal] abort signal
 * @return {Promise<{server: object, tool: object, text: string, isError: boolean, truncated: boolean}>}
 */
export async function callTool(functionName, args, { signal } = {}) {
	const entry = registry.get(functionName)
	if (!entry) {
		throw new Error(`unknown MCP tool: ${functionName}`)
	}

	const result = await request(entry.server, 'tools/call', {
		name: entry.tool.name,
		arguments: args && typeof args === 'object' && !Array.isArray(args) ? args : {},
	}, { signal, timeout: CALL_TIMEOUT_MS })

	return { server: entry.server, tool: entry.tool, ...resultToText(result) }
}

/**
 * Forgets sessions and tool lists — all of them, or one server's.
 *
 * @param {number|null} [serverId] server, or everything
 */
export function invalidate(serverId = null) {
	if (serverId === null) {
		sessions.clear()
		catalogues.clear()
		return
	}

	sessions.delete(serverId)
	catalogues.delete(serverId)
}
