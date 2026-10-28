/**
 * Memory (3.0.0): snapshots, the recap/compact queue and undo.
 *
 * The file lives in the user's Nextcloud and is read and written from here,
 * over WebDAV, always with its ETag. Nothing in here is persisted: a reload
 * starts with fresh snapshots, an empty queue and no undo — the long-term
 * undo is Nextcloud's file versioning.
 *
 * Every write goes through one promise chain per memory profile, and every
 * job reads the file fresh at its start. So two recaps of the same tab never
 * race each other; a race with another tab or the Text editor ends in a 412,
 * which recap answers by re-applying its ops to the new content once.
 */

import { showError, showSuccess, showWarning } from '@nextcloud/dialogs'
import { t } from '@nextcloud/l10n'
import { defineStore } from 'pinia'
import { compactText } from '../services/compact.js'
import { sideCall } from '../services/llm.js'
import {
	applyOps,
	explicitInstruction,
	MAX_FORGET_OPS,
	MAX_OPS,
	MEMORY_COMPACT_INSTRUCTION,
	memoryHeader,
	memorySection,
	parseOps,
	recapMaxTokens,
	recapPrompt,
} from '../services/memory.js'
import { readTextWithEtag, writeText } from '../services/nextcloud.js'
import { useConfigStore } from './config.js'

/**
 * Promise chains per memory profile id. Outside the store state on purpose:
 * a promise has no business being made reactive.
 */
const queues = new Map()

/**
 * @param {number} chars character count
 * @return {string} "4.2k" style
 */
export function kilo(chars) {
	return chars >= 1000 ? `${(chars / 1000).toFixed(1)}k` : String(chars)
}

export const useMemoryStore = defineStore('memory', {
	state: () => ({
		/** chatId → {memoryProfileId, section, truncated} */
		snapshots: {},
		/** memoryProfileId → current size in characters, for the header */
		sizes: {},
		/**
		 * memoryProfileId → {path, previousText, etag, messageId} of the last
		 * write in this session, which is what undo restores
		 */
		lastWrite: {},
		/** memoryProfileId → true while "almost full" should be shown */
		full: {},
		/** memoryProfileId → true while a manual compact runs */
		compacting: {},
	}),

	actions: {
		/**
		 * Runs `job` after everything already queued for this memory profile.
		 * A failed job must not block the chain, hence `then(job, job)`.
		 *
		 * @param {number} id memory profile id
		 * @param {() => Promise<object>} job the work
		 * @return {Promise<object>} the job's result
		 */
		enqueue(id, job) {
			const previous = queues.get(id) ?? Promise.resolve()
			const next = previous.then(job, job)
			queues.set(id, next)

			return next
		},

		/**
		 * The profile and connection that do recap and compact for a memory
		 * profile: its own recap model if set and still there, otherwise the
		 * chat profile that is asking.
		 *
		 * The default profile only stands in when nobody is asking — the
		 * compact button in the settings. A chat profile whose connection is
		 * gone gets an error, not a silent detour to another model, possibly
		 * at another provider.
		 *
		 * @param {object} memoryProfile memory profile
		 * @param {object|null} chatProfile fallback, null outside a chat
		 * @return {{profile: object, connection: object}|null} worker
		 */
		workerFor(memoryProfile, chatProfile) {
			const config = useConfigStore()
			const candidates = [
				config.profileById(memoryProfile.recap_profile_id),
				chatProfile ?? config.defaultProfile,
			]

			for (const profile of candidates) {
				const connection = profile ? config.connectionById(profile.connection_id) : null
				if (connection) {
					return { profile, connection }
				}
			}

			return null
		},

		/**
		 * Reads the file fresh. A missing file is empty memory, not an
		 * error: the next write recreates it.
		 *
		 * @param {object} memoryProfile memory profile
		 * @return {Promise<{text: string, etag: string|null, missing: boolean}|{error: string}>} content
		 */
		async read(memoryProfile) {
			let result
			try {
				result = await readTextWithEtag(memoryProfile.path, memoryProfile.max_chars)
			} catch (error) {
				// a stream that breaks halfway through, a timeout — the
				// callers all handle {error}, none of them expects a throw
				result = { error: error.message }
			}
			if (result.error) {
				return result
			}
			if (result.missing) {
				this.sizes[memoryProfile.id] = 0

				return { text: memoryHeader(memoryProfile.name), etag: null, missing: true }
			}

			this.sizes[memoryProfile.id] = result.text.length

			return { text: result.text, etag: result.etag, missing: false }
		},

		/**
		 * The memory section for a chat's system prompt.
		 *
		 * Read once per chat and memory profile, not per turn: the system
		 * prompt stays stable over the conversation, which keeps prompt
		 * caching intact, and whatever recap adds during the chat the model
		 * has already seen in the chat itself. A different memory profile —
		 * the user switched profiles in the composer — reads again.
		 *
		 * @param {string} chatId chat
		 * @param {object} memoryProfile memory profile
		 * @param {object|null} chatProfile for a compact the snapshot triggers
		 * @return {Promise<{section: string, truncated: boolean}>} prompt section
		 */
		async snapshotFor(chatId, memoryProfile, chatProfile) {
			const existing = this.snapshots[chatId]
			if (existing && existing.memoryProfileId === memoryProfile.id) {
				return existing
			}

			const file = await this.read(memoryProfile)
			if (file.error) {
				// a chat without memory is still a chat
				showWarning(t('llmchat', 'Could not read the memory "{name}": {message}', {
					name: memoryProfile.name,
					message: file.error,
				}))

				return { section: '', truncated: false }
			}

			const snapshot = {
				memoryProfileId: memoryProfile.id,
				...memorySection(file.text, memoryProfile.max_chars),
			}
			this.snapshots[chatId] = snapshot

			this.checkFull(memoryProfile, file.text.length, chatProfile)

			return snapshot
		},

		/**
		 * Over the threshold: compact right away when the profile says so,
		 * otherwise raise the banner.
		 *
		 * @param {object} memoryProfile memory profile
		 * @param {number} chars current size
		 * @param {object|null} chatProfile fallback worker
		 * @param {object} [options] options
		 * @param {string|null} [options.messageId] the recap this compact follows, see remember()
		 * @param {((entry: object, usage: object|null) => void)|null} [options.onCompacted] gets the log entry and token usage of an automatic compact
		 */
		checkFull(memoryProfile, chars, chatProfile, { messageId = null, onCompacted = null } = {}) {
			const limit = memoryProfile.max_chars * (memoryProfile.compact_threshold ?? 80) / 100
			if (chars <= limit) {
				this.full[memoryProfile.id] = false
				return
			}

			if (!memoryProfile.auto_compact) {
				this.full[memoryProfile.id] = true
				return
			}

			// not awaited: called from inside a queued job, and waiting for a
			// job queued behind yourself is a deadlock
			this.enqueue(memoryProfile.id, () => this.compactJob(memoryProfile, chatProfile, messageId))
				.then((result) => {
					if (result.error) {
						this.full[memoryProfile.id] = true
					} else if (result.entry) {
						onCompacted?.(result.entry, result.usage)
					}
				})
		},

		/**
		 * Recap after an answer, or for /remember and /forget. Queued; the
		 * returned promise resolves when it has run.
		 *
		 * @param {object} options options
		 * @param {object} options.memoryProfile memory profile
		 * @param {object} options.chatProfile the profile that answered
		 * @param {string} options.question user message, plain text
		 * @param {string} options.answer final answer, plain text
		 * @param {object|null} [options.command] parsed /remember or /forget
		 * @param {string|null} [options.messageId] the message the log belongs to, for undo
		 * @param {(entry: object, usage: object|null) => void} [options.onCompacted] see checkFull()
		 * @return {Promise<{status: string, log: Array, error?: string, usage?: object|null}>} outcome
		 */
		recap(options) {
			return this.enqueue(options.memoryProfile.id, () => this.recapJob({
				command: null,
				messageId: null,
				onCompacted: null,
				...options,
			}))
		},

		async recapJob({ memoryProfile, chatProfile, question, answer, command, messageId, onCompacted }) {
			const worker = this.workerFor(memoryProfile, chatProfile)
			if (!worker) {
				return { status: 'error', log: [], error: 'no usable profile for the recap' }
			}

			const file = await this.read(memoryProfile)
			if (file.error) {
				return { status: 'error', log: [], error: file.error }
			}

			const maxOps = command?.kind === 'forget' ? MAX_FORGET_OPS : MAX_OPS
			let result
			try {
				result = await sideCall({
					connection: worker.connection,
					profile: worker.profile,
					prompt: recapPrompt({
						file: file.text,
						question,
						answer,
						explicit: explicitInstruction(command),
					}),
					maxTokens: recapMaxTokens(maxOps),
				})
			} catch (error) {
				return { status: 'error', log: [], error: error.message }
			}

			// the call has been paid for from here on, whatever comes of it
			const usage = result.usage ?? null
			const ops = parseOps(result.text, { finishReason: result.finishReason, max: maxOps })
			if (ops.length === 0) {
				return { status: 'noop', log: [], usage }
			}

			// two attempts: the second one re-applies the *same* ops to
			// whatever the file says now, without asking the model again
			let base = file
			for (let attempt = 0; attempt < 2; attempt++) {
				const applied = applyOps(base.text, ops)
				if (applied.applied.length === 0) {
					return { status: 'noop', log: [], usage }
				}

				const written = await writeText(memoryProfile.path, applied.text, base.etag)
				if (written.error) {
					return { status: 'error', log: [], error: written.error, usage }
				}

				if (!written.conflict) {
					this.remember(memoryProfile, base.text, written.etag, messageId)
					this.sizes[memoryProfile.id] = applied.text.length
					this.checkFull(memoryProfile, applied.text.length, chatProfile, { messageId, onCompacted })

					return { status: 'done', log: applied.applied, usage }
				}

				base = await this.read(memoryProfile)
				if (base.error) {
					return { status: 'error', log: [], error: base.error, usage }
				}
			}

			return { status: 'error', log: [], error: 'the file kept changing underneath — skipped', usage }
		},

		/**
		 * @param {object} memoryProfile memory profile
		 * @param {object|null} chatProfile fallback worker
		 * @param {string|null} [messageId] the recap this follows, null for the button
		 * @return {Promise<{entry?: object, error?: string}>} log entry or why not
		 */
		async compactJob(memoryProfile, chatProfile, messageId = null) {
			const worker = this.workerFor(memoryProfile, chatProfile)
			if (!worker) {
				return { error: 'no usable profile for compacting' }
			}

			const file = await this.read(memoryProfile)
			if (file.error) {
				return { error: file.error }
			}
			if (file.missing) {
				return { error: 'the memory file does not exist' }
			}

			const compacted = await compactText({
				connection: worker.connection,
				profile: worker.profile,
				text: file.text,
				instruction: MEMORY_COMPACT_INSTRUCTION,
				targetChars: Math.floor(memoryProfile.max_chars * 0.6),
			})
			if (compacted.error) {
				return { error: compacted.error, usage: compacted.usage ?? null }
			}

			// no re-apply on 412: a rewrite of the old text would throw away
			// whatever changed, so this one just gives up
			const written = await writeText(memoryProfile.path, compacted.text, file.etag)
			if (written.conflict) {
				return { error: 'the file changed while compacting — try again' }
			}
			if (written.error) {
				return { error: written.error }
			}

			this.remember(memoryProfile, file.text, written.etag, messageId)
			this.sizes[memoryProfile.id] = compacted.text.length
			this.full[memoryProfile.id] = false

			return {
				entry: { op: 'COMPACT', text: `${kilo(file.text.length)} → ${kilo(compacted.text.length)}` },
				usage: compacted.usage ?? null,
				etag: written.etag,
			}
		},

		/**
		 * The compact button, in the memory tab and in the banner.
		 *
		 * @param {object} memoryProfile memory profile
		 * @param {object|null} chatProfile fallback worker
		 */
		async compactNow(memoryProfile, chatProfile = null) {
			this.compacting[memoryProfile.id] = true
			try {
				const result = await this.enqueue(memoryProfile.id, () => this.compactJob(memoryProfile, chatProfile))
				if (result.error) {
					showError(t('llmchat', 'Memory not compacted: {message}', { message: result.error }))
				} else {
					showSuccess(t('llmchat', 'Memory compacted: {change}', { change: result.entry.text }))
				}
			} finally {
				this.compacting[memoryProfile.id] = false
			}
		},

		/**
		 * Records the last write for undo.
		 *
		 * Several writes for the same message — a recap and the automatic
		 * compact it triggered — are one change as far as the user can see:
		 * one log, one undo button. So the text from *before the first* of
		 * them is kept, and only the etag moves on. Undo then takes back
		 * both, which is what the log next to the button promises.
		 *
		 * @param {object} memoryProfile memory profile
		 * @param {string} previousText content before this write
		 * @param {string|null} etag etag after this write
		 * @param {string|null} messageId message the change shows up in, null for the compact button
		 */
		remember(memoryProfile, previousText, etag, messageId) {
			const before = this.lastWrite[memoryProfile.id]
			const sameChange = messageId !== null && before?.messageId === messageId

			this.lastWrite[memoryProfile.id] = {
				path: memoryProfile.path,
				previousText: sameChange ? before.previousText : previousText,
				etag,
				messageId,
			}
		},

		/**
		 * @param {number} memoryProfileId memory profile
		 * @param {string|null} [messageId] only undo if the last write came from this message
		 * @return {boolean} whether undo is possible
		 */
		canUndo(memoryProfileId, messageId = null) {
			const last = this.lastWrite[memoryProfileId]

			return Boolean(last?.etag) && (messageId === null || last.messageId === messageId)
		},

		/**
		 * Puts back what the file said before the last write of this
		 * session — but only if nothing else wrote to it since. Anything
		 * further back is what the Nextcloud versions are for.
		 *
		 * @param {object} memoryProfile memory profile
		 * @return {Promise<boolean>} whether it worked
		 */
		undo(memoryProfile) {
			return this.enqueue(memoryProfile.id, async () => {
				const last = this.lastWrite[memoryProfile.id]
				if (!last?.etag) {
					return false
				}

				const written = await writeText(last.path, last.previousText, last.etag)
				if (written.conflict) {
					showWarning(t('llmchat', 'The memory changed since — use the file versions in Files to go further back.'))
					return false
				}
				if (written.error) {
					showError(written.error)
					return false
				}

				delete this.lastWrite[memoryProfile.id]
				this.sizes[memoryProfile.id] = last.previousText.length
				showSuccess(t('llmchat', 'Memory change undone'))

				return true
			})
		},
	},
})
