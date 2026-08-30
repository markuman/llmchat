/**
 * Direct browser → LLM backend client (spec §2, §8).
 *
 * No SDK, no server proxy. Plain fetch against OpenAI-compatible endpoints,
 * SSE frames parsed by hand, AbortController for the stop button.
 */

import { t } from '@nextcloud/l10n'

export const ERR_CSP = 'csp'
export const ERR_CORS = 'cors'
export const ERR_AUTH = 'auth'
export const ERR_EMPTY_MODELS = 'empty_models'
export const ERR_HTTP = 'http'
export const ERR_UNKNOWN = 'unknown'

export class LlmError extends Error {

	constructor(kind, message, { status = null, cause = null } = {}) {
		super(message)
		this.name = 'LlmError'
		this.kind = kind
		this.status = status
		this.cause = cause
	}

}

function stripTrailingSlash(url) {
	return String(url ?? '').replace(/\/+$/, '')
}

/**
 * Ollama's native API lives at the root, its OpenAI-compatible shim at /v1.
 * Users type either, so both have to be tolerated.
 */
function rootOf(baseUrl) {
	return stripTrailingSlash(baseUrl).replace(/\/v1$/, '')
}

function chatUrl(connection) {
	const base = stripTrailingSlash(connection.base_url)

	return base.endsWith('/v1') || base.endsWith('/api/v1')
		? `${base}/chat/completions`
		: `${base}/v1/chat/completions`
}

function modelsUrl(connection) {
	const base = stripTrailingSlash(connection.base_url)

	if (connection.provider_hint === 'ollama') {
		return `${rootOf(base)}/api/tags`
	}

	return base.endsWith('/v1') || base.endsWith('/api/v1')
		? `${base}/models`
		: `${base}/v1/models`
}

function headers(connection) {
	const result = { 'Content-Type': 'application/json' }

	if (connection.api_key) {
		result.Authorization = `Bearer ${connection.api_key}`
	}

	// spec §7.2: optional, gets the app onto OpenRouter's leaderboard
	if (connection.provider_hint === 'openrouter') {
		result['HTTP-Referer'] = window.location.origin
		result['X-Title'] = 'Nextcloud LLM Chat'
	}

	return result
}

/**
 * Turns the three failure classes apart and says what to do about it
 * (spec §7.3). A network-level failure from the browser is indistinguishable
 * at the JS level between CSP and CORS — the console tells them apart, we
 * cannot, so the message covers both with the CSP fix first because that is
 * the one we caused.
 */
function classifyNetworkError(error, connection) {
	if (error.name === 'AbortError') {
		return error
	}

	if (error instanceof TypeError) {
		const host = (() => {
			try {
				return new URL(connection.base_url).host
			} catch {
				return connection.base_url
			}
		})()

		const isLocal = /^(localhost|127\.|0\.0\.0\.0|\[::1\]|192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)

		return new LlmError(
			ERR_CSP,
			isLocal
				? t('llmchat', 'Could not reach {host}. Either the domain is not allowed yet — reload the page after adding a connection — or the backend rejects requests from this origin. For Ollama, set OLLAMA_ORIGINS={origin}.', { host, origin: window.location.origin })
				: t('llmchat', 'Could not reach {host}. Either the domain is not allowed yet — reload the page after adding a connection — or the backend does not send CORS headers for this origin.', { host }),
			{ cause: error },
		)
	}

	return new LlmError(ERR_UNKNOWN, error.message, { cause: error })
}

async function errorFromResponse(response) {
	let detail = ''
	try {
		const text = await response.text()
		try {
			const json = JSON.parse(text)
			detail = json?.error?.message ?? json?.error ?? json?.message ?? text
		} catch {
			detail = text
		}
	} catch {
		detail = ''
	}

	detail = String(detail ?? '').slice(0, 400)

	if (response.status === 401 || response.status === 403) {
		return new LlmError(
			ERR_AUTH,
			t('llmchat', 'The API key was rejected ({status}).', { status: response.status })
				+ (detail ? ` ${detail}` : ''),
			{ status: response.status },
		)
	}

	return new LlmError(
		ERR_HTTP,
		t('llmchat', 'The backend answered with HTTP {status}.', { status: response.status })
			+ (detail ? ` ${detail}` : ''),
		{ status: response.status },
	)
}

/**
 * Spec §7.4: never let people type model names. Pull the list once and fill
 * the dropdown.
 *
 * @param {object} connection connection record
 * @param {AbortSignal} [signal] abort signal
 * @return {Promise<string[]>} sorted model ids
 */
export async function fetchModels(connection, signal = undefined) {
	let response
	try {
		response = await fetch(modelsUrl(connection), {
			method: 'GET',
			headers: headers(connection),
			signal,
		})
	} catch (error) {
		throw classifyNetworkError(error, connection)
	}

	if (!response.ok) {
		throw await errorFromResponse(response)
	}

	const payload = await response.json()
	const models = connection.provider_hint === 'ollama' && Array.isArray(payload?.models)
		? payload.models.map((m) => m.model ?? m.name).filter(Boolean)
		: (payload?.data ?? payload?.models ?? []).map((m) => m?.id ?? m?.name ?? m).filter((m) => typeof m === 'string')

	const unique = [...new Set(models)].sort((a, b) => a.localeCompare(b))

	if (unique.length === 0) {
		throw new LlmError(
			ERR_EMPTY_MODELS,
			t('llmchat', 'Connection works, but no models were found.'),
		)
	}

	return unique
}

/**
 * Verifies a connection and returns a verdict the UI can show verbatim.
 *
 * @param {object} connection connection record
 * @return {Promise<{ok: boolean, kind: string|null, message: string, models: string[]}>} result
 */
export async function testConnection(connection) {
	try {
		const models = await fetchModels(connection)

		return {
			ok: true,
			kind: null,
			message: t('llmchat', 'Connection OK — {count} models found.', { count: models.length }),
			models,
		}
	} catch (error) {
		if (error instanceof LlmError) {
			return { ok: false, kind: error.kind, message: error.message, models: [] }
		}

		return { ok: false, kind: ERR_UNKNOWN, message: error.message, models: [] }
	}
}

function buildPayload({ profile, messages, stream }) {
	const payload = {
		model: profile.model,
		messages,
		stream,
	}

	if (profile.system_prompt) {
		payload.messages = [{ role: 'system', content: profile.system_prompt }, ...messages]
	}
	if (profile.temperature !== null && profile.temperature !== undefined) {
		payload.temperature = profile.temperature
	}
	if (profile.max_tokens) {
		payload.max_tokens = profile.max_tokens
	}

	// Only sent when explicitly switching thinking off. Leaving both fields out
	// means "backend default", which for Ollama is thinking ON for capable
	// models — it is opt-out, not opt-in.
	if (profile.reasoning === false) {
		// Ollama's /v1 shim maps this to `think: false`; llama.cpp and OpenAI
		// take it natively. Note that Ollama's native `think` parameter does
		// NOT exist on /v1 and would be dropped without any error.
		payload.reasoning_effort = 'none'

		// OpenRouter ignores reasoning_effort and wants its own object.
		// Backends that know neither field ignore the extra key.
		payload.reasoning = { enabled: false }
	}

	return payload
}

/**
 * Parses one SSE data frame. Returns null for keep-alives and [DONE].
 *
 * @param {string} raw one `data:` payload
 * @return {object|null} parsed chunk
 */
function parseFrame(raw) {
	const data = raw.trim()
	if (data === '' || data === '[DONE]') {
		return null
	}

	try {
		return JSON.parse(data)
	} catch {
		return null
	}
}

function deltaOf(chunk) {
	const choice = chunk?.choices?.[0]
	if (!choice) {
		return { content: '', reasoning: '' }
	}

	const delta = choice.delta ?? choice.message ?? {}

	return {
		content: delta.content ?? '',
		// several backends expose thinking separately instead of inline <think>
		reasoning: delta.reasoning_content ?? delta.reasoning ?? '',
	}
}

/**
 * Streams a completion. Calls onDelta for every token and resolves with the
 * full result.
 *
 * @param {object} options options
 * @param {object} options.connection connection record
 * @param {object} options.profile profile record
 * @param {Array} options.messages chat messages, oldest first
 * @param {Function} options.onDelta called with ({content, reasoning})
 * @param {AbortSignal} options.signal abort signal for the stop button
 * @return {Promise<{content: string, reasoning: string, usage: object|null}>} completion
 */
export async function streamCompletion({ connection, profile, messages, onDelta, signal }) {
	const stream = profile.streaming !== false
	let response

	try {
		response = await fetch(chatUrl(connection), {
			method: 'POST',
			headers: headers(connection),
			body: JSON.stringify(buildPayload({ profile, messages, stream })),
			signal,
		})
	} catch (error) {
		throw classifyNetworkError(error, connection)
	}

	if (!response.ok) {
		throw await errorFromResponse(response)
	}

	if (!stream || !response.body) {
		const payload = await response.json()
		const message = payload?.choices?.[0]?.message ?? {}
		const content = message.content ?? ''
		const reasoning = message.reasoning_content ?? message.reasoning ?? ''

		if (content) {
			onDelta?.({ content, reasoning })
		}

		return { content, reasoning, usage: payload?.usage ?? null }
	}

	const reader = response.body.getReader()
	const decoder = new TextDecoder()

	let buffer = ''
	let content = ''
	let reasoning = ''
	let usage = null

	try {
		for (;;) {
			const { done, value } = await reader.read()
			if (done) {
				break
			}

			buffer += decoder.decode(value, { stream: true })

			// SSE events are separated by a blank line; \r\n shows up in the wild
			const events = buffer.split(/\r?\n\r?\n/)
			buffer = events.pop() ?? ''

			for (const event of events) {
				for (const line of event.split(/\r?\n/)) {
					if (!line.startsWith('data:')) {
						continue
					}

					const chunk = parseFrame(line.slice(5))
					if (!chunk) {
						continue
					}

					if (chunk.error) {
						throw new LlmError(ERR_HTTP, chunk.error?.message ?? String(chunk.error))
					}
					if (chunk.usage) {
						usage = chunk.usage
					}

					const delta = deltaOf(chunk)
					if (delta.content || delta.reasoning) {
						content += delta.content
						reasoning += delta.reasoning
						onDelta?.(delta)
					}
				}
			}
		}
	} finally {
		reader.releaseLock?.()
	}

	return { content, reasoning, usage }
}

/**
 * Spec §5.1: one non-streaming call against the same profile, fixed prompt,
 * cached locally and never regenerated.
 *
 * @param {object} options options
 * @param {object} options.connection connection record
 * @param {object} options.profile profile record
 * @param {string} options.question first user message
 * @param {string} options.answer first assistant message
 * @return {Promise<string>} generated title
 */
export async function generateTitle({ connection, profile, question, answer }) {
	const { content } = await streamCompletion({
		connection,
		// reasoning is always off here regardless of the profile: a five-word
		// summary does not need a thinking budget, and with max_tokens: 32 a
		// thinking model would spend the entire budget before writing a word
		profile: {
			...profile,
			system_prompt: null,
			streaming: false,
			max_tokens: 32,
			reasoning: false,
		},
		messages: [{
			role: 'user',
			content: 'Summarise the following exchange in at most 5 words. '
				+ 'Answer with the title only, no quotes, no punctuation at the end.\n\n'
				+ `USER: ${question.slice(0, 2000)}\n\nASSISTANT: ${answer.slice(0, 2000)}`,
		}],
		onDelta: null,
		signal: undefined,
	})

	return stripThink(content).trim().replace(/^["'`]|["'`]$/g, '').slice(0, 80)
}

/**
 * Splits `<think>` blocks out of a response so reasoning can be collapsed
 * instead of polluting the answer (spec §11).
 *
 * @param {string} text raw assistant text
 * @return {{reasoning: string, content: string}} split result
 */
export function splitThink(text) {
	const source = String(text ?? '')
	const reasoning = []

	const content = source
		.replace(/<think>([\s\S]*?)<\/think>/gi, (_, inner) => {
			reasoning.push(inner)
			return ''
		})
		// an unterminated block means the stream is still inside it
		.replace(/<think>([\s\S]*)$/i, (_, inner) => {
			reasoning.push(inner)
			return ''
		})

	return { reasoning: reasoning.join('\n').trim(), content: content.trim() }
}

export function stripThink(text) {
	return splitThink(text).content
}

/**
 * Rough token estimate for the status bar. ~4 characters per token is close
 * enough for a hint and costs nothing; a real tokenizer is not worth 300 kB.
 *
 * @param {Array} messages chat messages
 * @return {number} estimated tokens
 */
export function estimateTokens(messages) {
	const chars = messages.reduce((sum, m) => sum + String(m.content ?? '').length, 0)

	return Math.ceil(chars / 4) + messages.length * 4
}
