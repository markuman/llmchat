/**
 * Compact (3.0.0): "rewrite this text shorter", generic.
 *
 * Used for the memory file today. Named compact.js / compactText() and not
 * plain `compact`, because `settings.compact_mode` already means the UI
 * density.
 *
 * One call, no loop: a result that is still over the target is taken anyway
 * (it is shorter, that is the point), but it is not fed back for a second
 * round — two rounds of lossy rewriting are how facts quietly disappear.
 */

import { sideCall } from './llm.js'
import { stripDelimiters } from './memory.js'

/**
 * Removes one pair of code fences around a whole answer — models put them
 * there even when told not to.
 *
 * @param {string} text model output
 * @return {string} text without the outer fence
 */
export function stripFences(text) {
	const trimmed = String(text ?? '').trim()
	const match = /^```[\w-]*\n([\s\S]*?)\n?```$/.exec(trimmed)

	return match ? match[1].trim() : trimmed
}

/**
 * Sanity checks for a compacted text. Each failure leaves the original
 * untouched — a compact that ate the file is the one outcome worse than a
 * file that is too long.
 *
 * @param {string} original text before
 * @param {string} result text after, fences already stripped
 * @param {string|null} finishReason from the completion
 * @return {string|null} why it was rejected, or null when it is fine
 */
export function compactProblem(original, result, finishReason) {
	if (finishReason === 'length') {
		return 'the model ran out of tokens'
	}
	if (result.trim() === '') {
		return 'the model returned nothing'
	}
	if (result.length >= original.length) {
		return 'the result was not shorter'
	}
	if (result.length < original.length * 0.2) {
		return 'the result lost more than 80 % — refusing to write it'
	}

	return null
}

/**
 * @param {object} options options
 * @param {object} options.connection connection record
 * @param {object} options.profile profile whose model does the work
 * @param {string} options.text what to shorten
 * @param {string} options.instruction what kind of text it is and what to keep
 * @param {number} options.targetChars size to aim for
 * @return {Promise<{text: string, usage: object|null}|{error: string, usage?: object|null}>} the shorter text, or why not
 */
export async function compactText({ connection, profile, text, instruction, targetChars }) {
	const prompt = `${instruction}\n\n`
		+ `Rewrite the text below to at most ${targetChars} characters. `
		+ 'Output only the rewritten text, no preamble, no code fences.\n\n'
		+ `<text>\n${stripDelimiters(text)}\n</text>`

	let result
	try {
		result = await sideCall({
			connection,
			profile,
			prompt,
			// ~3 characters per token for the output, so the target fits
			maxTokens: Math.ceil(targetChars / 3),
		})
	} catch (error) {
		return { error: error.message }
	}

	const cleaned = stripFences(result.text)
	const problem = compactProblem(text, cleaned, result.finishReason)
	if (problem) {
		return { error: problem, usage: result.usage }
	}

	return { text: `${cleaned.trimEnd()}\n`, usage: result.usage }
}
