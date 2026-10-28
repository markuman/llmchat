/**
 * Memory (3.0.0): the pure part. Prompts, the op parser and the op applier.
 *
 * No imports and no I/O on purpose — this is what `node --test` checks
 * (memory.test.js next to it), without a bundler or a browser. Reading and
 * writing the file is store/memory.js, over services/nextcloud.js.
 *
 * File format: lines that start with `- ` are facts. Recap only ever touches
 * those; headings, blank lines and free text stay exactly where the user put
 * them. Only compact may rewrite the whole file.
 */

/** how much of each side of the exchange the recap model sees */
export const RECAP_INPUT_CHARS = 4000
/** a fact is one short line; anything longer is the model rambling */
export const MAX_FACT_CHARS = 300
export const MAX_OPS = 5
/** /forget may have to delete several lines saying the same thing */
export const MAX_FORGET_OPS = 10

/**
 * Output budget for a recap, derived from what parseOps() accepts: the
 * longest op is an UPD with two lines of MAX_FACT_CHARS each plus its
 * markers, at a pessimistic three characters per token. A budget below that
 * would cut off exactly the long, legitimate recaps — and a cut-off answer
 * is thrown away whole. It is a ceiling, not a cost: a NOOP still costs one
 * line.
 *
 * @param {number} maxOps op limit for this recap
 * @return {number} max_tokens
 */
export function recapMaxTokens(maxOps) {
	return maxOps * Math.ceil((2 * MAX_FACT_CHARS + 16) / 3)
}

export const MEMORY_COMPACT_INSTRUCTION = 'This is a memory file of facts about a user. Merge duplicates and overlapping\n'
	+ 'lines, drop facts that newer lines supersede, keep everything else. Do not\n'
	+ 'invent, generalise or add anything. Keep the markdown structure: section\n'
	+ 'headings, and one fact per line starting with "- ".'

/**
 * Removes the *closing* delimiter tags of the prompts from text going inside
 * them. A `</memory>` typed into the file by hand would otherwise end the
 * block early and turn the rest of the file into instructions; a
 * `</exchange>` in an answer — which may echo a fetched page — would do the
 * same to the recap prompt. Opening tags cannot end anything and stay, so a
 * question about HTML keeps its `<text>`. Stripped rather than escaped:
 * there is no escape syntax a model reliably honours.
 *
 * @param {string} text text to embed
 * @return {string} text without delimiter tags
 */
export function stripDelimiters(text) {
	return String(text ?? '').replace(/<\s*\/\s*(memory|exchange|text)\s*>/gi, '')
}

/**
 * What a freshly created memory file contains. Mirrors
 * MemoryProfileService::ensureFile(), for the case where the browser has to
 * recreate a file someone deleted.
 *
 * @param {string} name memory profile name
 * @return {string} file content
 */
export function memoryHeader(name) {
	return `# memory: ${name}\n\n`
}

/**
 * True when the file has nothing worth injecting: blank, or headings only.
 *
 * @param {string} text file content
 * @return {boolean} empty
 */
export function isEmptyMemory(text) {
	return String(text ?? '')
		.split('\n')
		.map((line) => line.trim())
		.every((line) => line === '' || line.startsWith('#'))
}

/**
 * The section that goes at the end of the system prompt.
 *
 * Cut at the last full line within `maxChars` — half a fact is worse than
 * none, it reads as a different fact.
 *
 * @param {string} text file content
 * @param {number} maxChars the memory profile's limit
 * @return {{section: string, truncated: boolean}} prompt section, empty when there is nothing to say
 */
export function memorySection(text, maxChars) {
	if (isEmptyMemory(text)) {
		return { section: '', truncated: false }
	}

	let body = stripDelimiters(text).trim()
	const truncated = body.length > maxChars
	if (truncated) {
		body = body.slice(0, maxChars)
		const lastBreak = body.lastIndexOf('\n')
		if (lastBreak > 0) {
			body = body.slice(0, lastBreak)
		}
	}

	return {
		section: '## Memory\n'
			+ 'Things you know about the user from earlier conversations, maintained automatically.\n'
			+ 'Use them when they are relevant to the current request. Do not recite them unprompted.\n'
			+ 'They can be outdated – what the user says now always wins.\n'
			+ `<memory>\n${body}\n</memory>`,
		truncated,
	}
}

/**
 * The text of a chat message, capped. Image blocks are dropped: the recap
 * model is told about the words, not the pictures.
 *
 * @param {string|Array} content message content
 * @param {number} [cap] maximum characters
 * @return {string} plain text
 */
export function messageText(content, cap = RECAP_INPUT_CHARS) {
	const text = Array.isArray(content)
		? content.filter((block) => block?.type === 'text').map((block) => String(block.text ?? '')).join('\n')
		: String(content ?? '')

	return text.trim().slice(0, cap)
}

/**
 * `/remember …` and `/forget …` at the very start of a message.
 *
 * @param {string} text what the user typed
 * @return {{kind: 'remember'|'forget', text: string}|null} the command, or null for a normal message
 */
export function parseMemoryCommand(text) {
	const match = /^\/(remember|forget)(?:\s+([\s\S]*))?$/i.exec(String(text ?? '').trim())
	if (!match) {
		return null
	}

	return { kind: match[1].toLowerCase(), text: (match[2] ?? '').trim() }
}

/**
 * The extra instruction for /remember and /forget.
 *
 * @param {{kind: string, text: string}|null} command parsed command
 * @return {string} instruction, empty for a normal recap
 */
export function explicitInstruction(command) {
	if (!command) {
		return ''
	}

	return command.kind === 'remember'
		? `The user explicitly asked to remember: "${command.text}". Store it (ADD or UPD).`
		: `The user explicitly asked to forget: "${command.text}". DEL or UPD every matching line.`
}

/**
 * The recap prompt.
 *
 * Only the user's message and the final answer go in — no tool results, no
 * reasoning. That is the actual injection guard: whatever web_fetch, nc_read
 * or an MCP server brought in never reaches the model that writes the
 * memory. The rule that only the *user's* statements count is the second
 * line of defence, for an answer that repeats something a page said.
 *
 * @param {object} options prompt parts
 * @param {string} options.file current memory file
 * @param {string} options.question last user message, plain text
 * @param {string} options.answer final assistant answer, plain text
 * @param {string} [options.explicit] see explicitInstruction()
 * @return {string} prompt
 */
export function recapPrompt({ file, question, answer, explicit = '' }) {
	return 'You maintain a memory file about the user of a chat assistant.\n'
		+ 'Below are the current memory file and the latest exchange.\n'
		+ '\n'
		+ 'Decide whether the exchange contains durable facts worth remembering for future,\n'
		+ 'unrelated conversations: who the user is, their preferences, ongoing projects,\n'
		+ 'decisions they made, people in their life.\n'
		+ '\n'
		+ 'Only store what the USER said or clearly confirmed. The assistant\'s answer is\n'
		+ 'context only – never store a fact that appears only in the assistant\'s answer.\n'
		+ '\n'
		+ 'Do NOT store: one-off questions, suggestions the user did not adopt, search\n'
		+ 'results, temporary state, credentials, passwords, API keys, tokens.\n'
		+ '\n'
		+ 'Output ONLY operations, one per line, nothing else:\n'
		+ 'NOOP\n'
		+ 'ADD: <new fact>\n'
		+ 'UPD: <exact existing line> => <replacement line>\n'
		+ 'DEL: <exact existing line>\n'
		+ '\n'
		+ 'Rules:\n'
		+ '- If a fact about the same subject already exists, use UPD, never ADD.\n'
		+ '- Never ADD something the file already says, in any wording.\n'
		+ '- If the user corrects or contradicts a stored fact, UPD or DEL it.\n'
		+ '- At most 5 operations. If nothing is worth storing: NOOP.\n'
		+ '- Facts are short, one line each, written in the language of the existing file\n'
		+ '  (if the file is empty: the user\'s language).\n'
		+ '\n'
		+ `<memory>\n${stripDelimiters(file)}\n</memory>\n`
		+ '\n'
		+ `<exchange>\nUSER: ${stripDelimiters(question)}\nASSISTANT: ${stripDelimiters(answer)}\n</exchange>\n`
		+ explicit
}

/**
 * A fact without its list marker, for writing.
 *
 * @param {string} text raw fact from the model
 * @return {string} cleaned fact
 */
function cleanFact(text) {
	return String(text ?? '').replace(/^\s*[-*]\s+/, '').trim()
}

/**
 * Comparison form of a line: no list marker, collapsed whitespace, no
 * trailing full stop, lower case. Only ever used to compare — what gets
 * written keeps its case.
 *
 * @param {string} line fact line
 * @return {string} normalised
 */
export function normalizeFact(line) {
	return cleanFact(line).replace(/\s+/g, ' ').replace(/[.\s]+$/, '').toLowerCase()
}

/**
 * Parses the recap model's answer into operations.
 *
 * Strict on purpose: anything that is not a well-formed op line is dropped,
 * because models like to wrap their output in explanations. A cut-off answer
 * is dropped as a whole — its last op could be half a sentence.
 *
 * @param {string} text model output
 * @param {object} [options] options
 * @param {string|null} [options.finishReason] from the completion
 * @param {number} [options.max] op limit
 * @return {Array<{op: string, text?: string, from?: string, to?: string}>} operations
 */
export function parseOps(text, { finishReason = null, max = MAX_OPS } = {}) {
	if (finishReason === 'length') {
		return []
	}

	const ops = []

	for (const raw of String(text ?? '').split('\n')) {
		// a bullet in front of the op is a harmless habit, not a reason to drop it
		const line = raw.trim().replace(/^[-*]\s+/, '')
		if (line === '' || line.startsWith('```')) {
			continue
		}

		// the colon is required: without it "Add the following…" would be a fact
		const match = /^(ADD|UPD|DEL)\s*:\s*(.*)$/i.exec(line)
		if (!match) {
			// NOOP included — it is the absence of ops, nothing to collect
			continue
		}

		const op = match[1].toUpperCase()
		const rest = match[2].trim()
		if (rest === '') {
			continue
		}

		if (op === 'UPD') {
			const at = rest.indexOf(' => ')
			if (at === -1) {
				continue
			}
			const from = cleanFact(rest.slice(0, at))
			const to = cleanFact(rest.slice(at + 4))
			if (from === '' || to === '' || to.length > MAX_FACT_CHARS) {
				continue
			}
			ops.push({ op, from, to })
		} else {
			const fact = cleanFact(rest)
			if (fact === '' || fact.length > MAX_FACT_CHARS) {
				continue
			}
			ops.push({ op, text: fact })
		}

		if (ops.length >= max) {
			break
		}
	}

	return ops
}

/**
 * Applies operations to the file, by text match rather than line number —
 * which is what makes a retry after a 412 safe: the same ops land on the
 * new content just as well, or are rejected if their line is gone.
 *
 * UPD and DEL need exactly one match. None or several means the model
 * referred to something that is not (uniquely) there, and guessing which
 * line it meant would be worse than doing nothing.
 *
 * @param {string} fileText current content
 * @param {Array} ops from parseOps()
 * @return {{text: string, applied: Array<{op: string, text: string}>, rejected: Array<{op: string, text: string, reason: string}>}} result
 */
export function applyOps(fileText, ops) {
	const lines = String(fileText ?? '').replace(/\r\n/g, '\n').split('\n')
	// trailing blank lines are re-added once at the end
	while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
		lines.pop()
	}

	const applied = []
	const rejected = []

	const isFact = (line) => line.trimStart().startsWith('- ')
	const find = (target) => {
		const wanted = normalizeFact(target)
		const hits = []
		lines.forEach((line, index) => {
			if (isFact(line) && normalizeFact(line) === wanted) {
				hits.push(index)
			}
		})

		return hits
	}
	const indentOf = (line) => line.slice(0, line.length - line.trimStart().length)

	for (const op of ops) {
		if (op.op === 'ADD') {
			if (find(op.text).length > 0) {
				rejected.push({ op: 'ADD', text: op.text, reason: 'already there' })
				continue
			}
			// straight under the last fact, or after a blank line below a
			// heading or free text — so a list stays one list
			if (lines.length > 0 && !isFact(lines[lines.length - 1])) {
				lines.push('')
			}
			lines.push(`- ${op.text}`)
			applied.push({ op: 'ADD', text: op.text })
		} else if (op.op === 'UPD') {
			const hits = find(op.from)
			if (hits.length !== 1) {
				rejected.push({ op: 'UPD', text: `${op.from} → ${op.to}`, reason: hits.length === 0 ? 'not found' : 'ambiguous' })
				continue
			}
			const index = hits[0]
			lines[index] = `${indentOf(lines[index])}- ${op.to}`
			applied.push({ op: 'UPD', text: `${op.from} → ${op.to}` })
		} else if (op.op === 'DEL') {
			const hits = find(op.text)
			if (hits.length !== 1) {
				rejected.push({ op: 'DEL', text: op.text, reason: hits.length === 0 ? 'not found' : 'ambiguous' })
				continue
			}
			lines.splice(hits[0], 1)
			applied.push({ op: 'DEL', text: op.text })
		}
	}

	return {
		text: lines.length > 0 ? `${lines.join('\n')}\n` : '',
		applied,
		rejected,
	}
}

/**
 * "+2 ~1 −0" for the collapsed log line.
 *
 * @param {Array<{op: string}>} log applied ops
 * @return {{added: number, updated: number, deleted: number}} counts
 */
export function countOps(log) {
	return {
		added: log.filter((entry) => entry.op === 'ADD').length,
		updated: log.filter((entry) => entry.op === 'UPD').length,
		deleted: log.filter((entry) => entry.op === 'DEL').length,
	}
}
