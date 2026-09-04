/**
 * Chat state. Everything lives in IndexedDB; the server is never involved
 * except for archiving.
 */

import { showError, showSuccess } from '@nextcloud/dialogs'
import { t } from '@nextcloud/l10n'
import { defineStore } from 'pinia'
import { markRaw } from 'vue'
import { api } from '../services/api.js'
import * as db from '../services/db.js'
import {
	estimateTokens,
	generateTitle,
	splitThink,
	streamCompletion,
} from '../services/llm.js'
import { executeTool, needsApproval, toolDefinitionsFor } from '../services/tools.js'
import { useConfigStore } from './config.js'

const DAY = 24 * 60 * 60 * 1000

/**
 * How often one answer may stop to ask (issue #15). Two, not one: the first
 * round of answers can legitimately reveal that something else was ambiguous
 * too. Beyond that it is an interrogation, not a clarification.
 */
const MAX_ASK_USER_CALLS = 2

export const useChatStore = defineStore('chat', {
	state: () => ({
		chats: [],
		messages: [],
		activeId: null,
		loading: true,
		generating: false,
		error: null,
		storageWarning: null,
		/** markRaw'ed on assignment: fetch rejects a reactive proxy of AbortSignal */
		controller: null,
		/**
		 * Set while the agent loop waits for the user to approve a tool call:
		 * `{name, args, resolve}`. The resolver is markRaw'ed — a reactive
		 * proxy of a function is still callable, but there is no reason to
		 * track it.
		 */
		pendingApproval: null,
		/**
		 * Set while the agent loop waits for the user to answer an `ask_user`
		 * call (issue #15): `{questions, resolve}`. Same shape and the same
		 * markRaw reasoning as `pendingApproval`, but a separate slot — a
		 * model can ask a question about a call that is itself awaiting
		 * approval, and one field would then lose one of the two.
		 */
		pendingQuestions: null,
		/**
		 * Chat search (issue #6). `token` guards against a slow scan for an
		 * older query overwriting the results of a newer one.
		 */
		search: {
			query: '',
			running: false,
			hits: [],
			token: 0,
		},
		/** Message the search jumped to; ChatView scrolls to it and flashes it. */
		highlightId: null,
	}),

	getters: {
		activeChat: (state) => state.chats.find((c) => c.id === state.activeId) ?? null,

		activeProfile() {
			const config = useConfigStore()
			const chat = this.activeChat

			return (chat && config.profileById(chat.profile_id)) ?? config.defaultProfile
		},

		activeConnection() {
			const config = useConfigStore()
			const profile = this.activeProfile

			return profile ? config.connectionById(profile.connection_id) : null
		},

		contextTokens: (state) => estimateTokens(state.messages),

		/** Grouped for the sidebar: today / this week / older (spec §5). */
		groupedChats: (state) => {
			const now = Date.now()
			const startOfToday = new Date().setHours(0, 0, 0, 0)
			const weekAgo = now - 7 * DAY

			const groups = [
				{ id: 'today', label: t('llmchat', 'Today'), chats: [] },
				{ id: 'week', label: t('llmchat', 'This week'), chats: [] },
				{ id: 'older', label: t('llmchat', 'Older'), chats: [] },
			]

			state.chats.forEach((chat) => {
				const ts = chat.updated_at ?? chat.created_at ?? 0
				if (ts >= startOfToday) {
					groups[0].chats.push(chat)
				} else if (ts >= weekAgo) {
					groups[1].chats.push(chat)
				} else {
					groups[2].chats.push(chat)
				}
			})

			return groups.filter((group) => group.chats.length > 0)
		},

		searchActive: (state) => state.search.query.trim() !== '',

		searchTerms: (state) => state.search.query.toLowerCase().split(/\s+/).filter(Boolean),

		/**
		 * Hits grouped per chat, newest chat first. A chat whose *title*
		 * matches shows up even when none of its messages do — that is how
		 * people look for a conversation they already named.
		 */
		searchResults(state) {
			const terms = this.searchTerms
			const groups = new Map()

			const groupFor = (chat) => {
				if (!groups.has(chat.id)) {
					groups.set(chat.id, { chat, hits: [], titleMatch: false })
				}

				return groups.get(chat.id)
			}

			state.chats.forEach((chat) => {
				const title = (chat.title ?? '').toLowerCase()
				if (terms.length > 0 && terms.every((term) => title.includes(term))) {
					groupFor(chat).titleMatch = true
				}
			})

			state.search.hits.forEach((hit) => {
				const chat = state.chats.find((c) => c.id === hit.chat_id)
				// messages of a deleted chat cannot happen, but a stale hit list
				// during a delete can
				if (chat) {
					groupFor(chat).hits.push(hit)
				}
			})

			return [...groups.values()]
				.map((group) => ({
					...group,
					hits: [...group.hits].sort((a, b) => a.ts - b.ts),
				}))
				.sort((a, b) => (b.chat.updated_at ?? 0) - (a.chat.updated_at ?? 0))
		},
	},

	actions: {
		async init() {
			this.loading = true
			try {
				this.chats = await db.listChats()
				if (this.chats.length > 0) {
					await this.openChat(this.chats[0].id)
				}
				await this.checkStorage()
			} catch (error) {
				this.error = error.message
			} finally {
				this.loading = false
			}
		},

		async checkStorage() {
			const estimate = await db.storageEstimate()
			if (estimate && estimate.ratio > 0.8) {
				this.storageWarning = t(
					'llmchat',
					'Local storage is {percent}% full. Archive or delete old chats.',
					{ percent: Math.round(estimate.ratio * 100) },
				)
			} else {
				this.storageWarning = null
			}
		},

		/**
		 * @param {string} id chat to open
		 * @param {object} options open options
		 * @param {string|null} options.highlight marks a message for the view
		 *   to scroll to; set it here rather than afterwards so the view does
		 *   not first jump to the bottom and then to the message
		 */
		async openChat(id, { highlight = null } = {}) {
			this.abort()
			this.highlightId = null
			this.activeId = id
			this.messages = await db.listMessages(id)

			// set last, and only now: the view scrolls to the highlighted
			// message on nextTick, which is only useful once the messages it
			// has to scroll through are actually in the DOM
			this.highlightId = highlight
		},

		/**
		 * Runs a search over the local history. Callers debounce.
		 *
		 * @param {string} query whitespace-separated terms
		 */
		async runSearch(query) {
			this.search.query = query

			if (query.trim() === '') {
				this.search.hits = []
				this.search.running = false

				return
			}

			const token = ++this.search.token
			this.search.running = true

			try {
				const hits = await db.searchMessages(query)
				// a later query already started — its results win
				if (token === this.search.token) {
					this.search.hits = hits
				}
			} catch (error) {
				if (token === this.search.token) {
					this.search.hits = []
					this.error = error.message
				}
			} finally {
				if (token === this.search.token) {
					this.search.running = false
				}
			}
		},

		clearSearch() {
			this.search.token++
			this.search.query = ''
			this.search.hits = []
			this.search.running = false
		},

		/**
		 * Opens the chat a hit belongs to and marks the message so the view can
		 * scroll to it.
		 *
		 * @param {object} hit entry from `searchResults`
		 */
		async openHit(hit) {
			const target = hit.message_id ?? null

			if (hit.chat_id !== this.activeId) {
				await this.openChat(hit.chat_id, { highlight: target })
				return
			}

			// clicking the same hit twice must flash again, and a watcher does
			// not fire when the value ends up unchanged — so drop it first and
			// let the current tick flush
			if (this.highlightId === target) {
				this.highlightId = null
				await new Promise((resolve) => setTimeout(resolve, 0))
			}

			this.highlightId = target
		},

		async newChat() {
			const config = useConfigStore()
			this.clearSearch()
			const chat = await db.createChat({ profileId: config.defaultProfile?.id ?? null })

			this.chats = [chat, ...this.chats]
			this.activeId = chat.id
			this.messages = []

			return chat
		},

		async ensureChat() {
			return this.activeChat ?? await this.newChat()
		},

		async touchChat(patch = {}) {
			const chat = this.activeChat
			if (!chat) {
				return null
			}

			const updated = { ...chat, ...patch, updated_at: Date.now() }
			await db.putChat(updated)

			const index = this.chats.findIndex((c) => c.id === chat.id)
			if (index !== -1) {
				this.chats.splice(index, 1)
			}
			this.chats = [updated, ...this.chats]

			return updated
		},

		async renameChat(title) {
			await this.touchChat({ title: title.trim().slice(0, 200) })
		},

		async setProfile(profileId) {
			await this.touchChat({ profile_id: profileId })
		},

		async deleteChat(id) {
			await db.deleteChat(id)
			this.chats = this.chats.filter((c) => c.id !== id)
			this.search.hits = this.search.hits.filter((hit) => hit.chat_id !== id)

			if (this.activeId === id) {
				this.activeId = null
				this.messages = []
				if (this.chats.length > 0) {
					await this.openChat(this.chats[0].id)
				}
			}
		},

		abort() {
			// release anything waiting on the user first, otherwise the loop
			// stays parked on a promise that nobody will ever resolve
			this.resolveApproval(false)
			this.resolveQuestions(null)
			this.controller?.abort()
			this.controller = null
			this.generating = false
		},

		/**
		 * Sends a user message and streams the answer.
		 *
		 * @param {string} text user input
		 */
		async send(text) {
			const content = text.trim()
			if (content === '' || this.generating) {
				return
			}

			await this.ensureChat()

			const message = {
				id: db.uid(),
				chat_id: this.activeId,
				role: 'user',
				content,
				ts: Date.now(),
			}

			await db.putMessage(message)
			this.messages.push(message)

			await this.complete()
		},

		/**
		 * Regenerates the last assistant answer (spec §5).
		 *
		 * With a profile id, the answer is produced by that profile — and the
		 * chat switches to it for good. Anything else would be a hidden mode:
		 * the composer would still show the old profile while the next message
		 * silently went somewhere else.
		 *
		 * @param {number|null} profileId profile to answer with, or null for the current one
		 */
		async regenerate(profileId = null) {
			if (this.generating) {
				return
			}

			if (profileId && profileId !== this.activeChat?.profile_id) {
				await this.setProfile(profileId)
			}

			const lastAssistant = [...this.messages].reverse().find((m) => m.role === 'assistant')
			if (lastAssistant) {
				await db.deleteMessages([lastAssistant.id])
				this.messages = this.messages.filter((m) => m.id !== lastAssistant.id)
			}

			await this.complete()
		},

		/**
		 * Edits a user message and drops everything after it, then regenerates
		 * ("edit & retry from here", spec §5).
		 *
		 * @param {string} messageId message to edit
		 * @param {string} newContent replacement text
		 */
		async editAndRetry(messageId, newContent) {
			if (this.generating) {
				return
			}

			const index = this.messages.findIndex((m) => m.id === messageId)
			if (index === -1) {
				return
			}

			const tail = this.messages.slice(index + 1)
			if (tail.length > 0) {
				await db.deleteMessages(tail.map((m) => m.id))
			}

			const edited = { ...this.messages[index], content: newContent.trim() }
			await db.putMessage(edited)

			this.messages = [...this.messages.slice(0, index), edited]

			await this.complete()
		},

		async complete() {
			const config = useConfigStore()
			const profile = this.activeProfile
			const connection = this.activeConnection

			if (!profile || !connection) {
				this.error = t('llmchat', 'No usable profile — set up a connection and a profile first.')
				return
			}

			if (config.reloadRequired) {
				this.error = t('llmchat', 'A connection was changed. Reload the page before using it.')
				return
			}

			this.error = null
			this.generating = true
			this.controller = markRaw(new AbortController())

			const placeholder = {
				id: db.uid(),
				chat_id: this.activeId,
				role: 'assistant',
				content: '',
				reasoning: '',
				model: profile.model,
				ts: Date.now(),
				pending: true,
			}
			this.messages.push(placeholder)

			const history = this.messages
				.filter((m) => !m.pending)
				.map((m) => ({ role: m.role, content: m.content }))

			try {
				const result = await this.runAgentLoop({
					connection,
					profile,
					history,
					placeholder,
				})

				// backends that use inline <think> instead of a separate field
				const split = splitThink(result.content)
				const target = this.messages.find((m) => m.id === placeholder.id)
				const final = {
					...placeholder,
					content: split.content || result.content,
					reasoning: [target?.reasoning ?? '', split.reasoning].filter(Boolean).join('\n').trim(),
					tool_log: target?.tool_log?.length ? target.tool_log : undefined,
					usage: result.usage ?? null,
					pending: false,
				}

				await db.putMessage(final)
				const index = this.messages.findIndex((m) => m.id === placeholder.id)
				if (index !== -1) {
					this.messages.splice(index, 1, final)
				}

				await this.touchChat()
				await this.maybeGenerateTitle()
				await this.checkStorage()
			} catch (error) {
				const aborted = error.name === 'AbortError'
				const target = this.messages.find((m) => m.id === placeholder.id)

				const index = this.messages.findIndex((m) => m.id === placeholder.id)

				if (aborted && target?.content && index !== -1) {
					// keep what already arrived, it is still useful
					const kept = { ...target, pending: false, aborted: true }
					await db.putMessage(kept)
					this.messages.splice(index, 1, kept)
				} else {
					this.messages = this.messages.filter((m) => m.id !== placeholder.id)
					if (!aborted) {
						this.error = error.message
					}
				}
			} finally {
				this.generating = false
				this.controller = null
				this.pendingApproval = null
				this.pendingQuestions = null
			}
		},

		/**
		 * Resolves the pending approval dialog.
		 *
		 * @param {boolean} approved what the user clicked
		 */
		resolveApproval(approved) {
			const pending = this.pendingApproval
			this.pendingApproval = null
			pending?.resolve(approved)
		},

		/**
		 * Blocks until the user approves a tool call, or resolves immediately
		 * when approval is off for this profile.
		 *
		 * @param {object} call the tool call
		 * @param {object} args parsed arguments
		 * @param {boolean} required whether the profile asks for approval
		 * @return {Promise<boolean>} true when the call may run
		 */
		requestApproval(call, args, required) {
			if (!required) {
				return Promise.resolve(true)
			}

			return new Promise((resolve) => {
				this.pendingApproval = markRaw({
					name: call.function.name,
					args,
					resolve,
				})
			})
		},

		/**
		 * Resolves the pending question dialog.
		 *
		 * @param {object|null} answers `{questionId: string}`, or null when
		 *   the dialog was dismissed
		 */
		resolveQuestions(answers) {
			const pending = this.pendingQuestions
			this.pendingQuestions = null
			pending?.resolve(answers)
		},

		/**
		 * Blocks until the user answers what the model asked (issue #15).
		 *
		 * Handed to the tool executor as a callback rather than called from
		 * it: `executeTool` knows nothing about the store, and this is the
		 * only tool whose result comes from the UI.
		 *
		 * @param {Array} questions normalised questions
		 * @return {Promise<object|null>} answers by question id, null on dismiss
		 */
		askUser(questions) {
			// nothing would ever resolve this: the dialog is already gone
			if (this.controller?.signal.aborted) {
				return Promise.resolve(null)
			}

			return new Promise((resolve) => {
				this.pendingQuestions = markRaw({ questions, resolve })
			})
		},

		/**
		 * Mini agent loop.
		 *
		 * Tool rounds run on an *ephemeral* copy of the history: the
		 * assistant's tool_calls messages and the tool results never enter
		 * the persisted chat. Only the final answer does — the user's context
		 * stays clean, and the next completion does not re-send kilobytes of
		 * fetched page text. What happened is kept in `tool_log` for display.
		 *
		 * Bounded at the configured tool budget (3–7, the profile's own value
		 * if it has one, otherwise the general setting): a model that keeps
		 * calling tools gets one final round without tools instead of looping
		 * forever.
		 *
		 * @return {Promise<{content: string, usage: object|null}>} final completion
		 */
		async runAgentLoop({ connection, profile, history, placeholder }) {
			const maxRounds = useConfigStore().toolRoundsFor(profile)

			const onDelta = ({ content, reasoning }) => {
				const target = this.messages.find((m) => m.id === placeholder.id)
				if (!target) {
					return
				}
				target.content += content
				target.reasoning += reasoning
			}

			const enabledTools = Array.isArray(profile.enabled_tools) ? profile.enabled_tools : []
			// without the vision flag the image tools are not even offered —
			// a text-only model would just fill its context with base64
			const vision = profile.vision === true
			const definitions = toolDefinitionsFor(enabledTools, { vision })
			// web_search runs in the browser and needs the instance url
			const toolOptions = {
				searxngUrl: useConfigStore().settings.searxng_url ?? '',
				vision,
				// ask_user is answered by the UI, so the executor gets a way
				// back into the store instead of a service call
				askUser: (questions) => this.askUser(questions),
			}
			const approvalRequired = profile.tool_approval !== false
			let imagesSent = 0
			// The 5-question cap lives in the tool definition, so it is five
			// questions *per call*. A model with a seven-round budget could
			// ask in every one of them, and a chat that interrogates you once
			// per round has stopped being useful — so the budget is counted
			// across the whole answer.
			let askUserCalls = 0

			// ephemeral working copy — never persisted
			const loopMessages = [...history]
			let result = null

			for (let round = 0; round <= maxRounds; round++) {
				const lastRound = round === maxRounds
				const tools = !lastRound && definitions.length > 0 ? definitions : undefined

				result = await streamCompletion({
					connection,
					profile,
					messages: loopMessages,
					tools,
					signal: this.controller.signal,
					onDelta,
				})

				if (!result.toolCalls?.length) {
					break
				}

				// text produced alongside tool calls is intermediate thinking
				// aloud — drop it from the UI so only the final answer remains
				const target = this.messages.find((m) => m.id === placeholder.id)
				if (target) {
					target.content = ''
				}

				// some backends (Ollama) omit call ids; the tool message's
				// tool_call_id must match the assistant turn, so fill them in
				// *before* both sides reference them
				result.toolCalls.forEach((call, i) => {
					if (!call.id) {
						call.id = `call_${round}_${i}`
					}
				})

				loopMessages.push({
					role: 'assistant',
					content: result.content || null,
					tool_calls: result.toolCalls,
				})

				for (const call of result.toolCalls) {
					if (this.controller?.signal.aborted) {
						throw new DOMException('aborted', 'AbortError')
					}

					let outcome
					if (call.function.name === 'ask_user' && ++askUserCalls > MAX_ASK_USER_CALLS) {
						outcome = {
							content: JSON.stringify({
								error: 'you have already asked the user twice in this answer. '
									+ 'Answer with what you have and name the assumption you made.',
							}),
							summary: 'skipped — too many questions in one answer',
						}
					} else if (await this.approveCall(call, approvalRequired)) {
						outcome = await executeTool(call, enabledTools, toolOptions)
					} else {
						// the model gets a plain refusal and can carry on;
						// aborting the whole turn would lose the answer
						outcome = {
							content: JSON.stringify({ error: 'the user declined this tool call' }),
							summary: 'declined by you',
						}
					}

					// one image per answer, hard: two photos in one turn is
					// rarely what the user meant and always what the token
					// bill notices
					if (outcome.image && ++imagesSent > 1) {
						outcome = {
							content: JSON.stringify({
								error: 'one image per answer is the hard limit — you already '
									+ 'loaded one. Answer with what you have, or ask the user '
									+ 'which file matters.',
							}),
							summary: 'skipped — one image per answer',
						}
					}

					if (target) {
						if (!target.tool_log) {
							target.tool_log = []
						}
						target.tool_log.push({
							name: call.function.name,
							summary: outcome.summary,
						})
					}

					loopMessages.push({
						role: 'tool',
						tool_call_id: call.id,
						content: outcome.content,
					})

					// A tool result is a plain string in every OpenAI-compatible
					// API — image blocks are only valid on a user message. So
					// the tool answers with metadata and the picture arrives
					// right after it, which is also how the model is told to
					// expect it in the tool description.
					if (outcome.image) {
						loopMessages.push({
							role: 'user',
							content: [
								{ type: 'text', text: `Attached: ${outcome.image.label}` },
								{
									type: 'image_url',
									image_url: { url: `data:${outcome.image.mime};base64,${outcome.image.b64}` },
								},
							],
						})
					}
				}
			}

			return result
		},

		/**
		 * Asks the user about one call, unless the tool is harmless enough to
		 * run unattended or the profile switched approval off.
		 *
		 * @param {object} call the tool call
		 * @param {boolean} approvalRequired profile setting
		 * @return {Promise<boolean>} whether to run it
		 */
		async approveCall(call, approvalRequired) {
			if (!approvalRequired || !needsApproval(call.function.name)) {
				return true
			}

			let args
			try {
				args = JSON.parse(call.function.arguments || '{}')
			} catch {
				// show the raw string rather than hiding a malformed call
				args = { arguments: call.function.arguments }
			}

			return this.requestApproval(call, args, true)
		},

		/**
		 * Spec §5.1: generated once after the first exchange, cached, never
		 * regenerated. Falls back to the first 40 characters on failure.
		 */
		async maybeGenerateTitle() {
			const chat = this.activeChat
			if (!chat || chat.title) {
				return
			}

			const question = this.messages.find((m) => m.role === 'user')
			const answer = this.messages.find((m) => m.role === 'assistant')
			if (!question || !answer) {
				return
			}

			const fallback = question.content.slice(0, 40).trim()

			try {
				const title = await generateTitle({
					connection: this.activeConnection,
					profile: this.activeProfile,
					question: question.content,
					answer: answer.content,
				})
				await this.touchChat({ title: title || fallback })
			} catch {
				await this.touchChat({ title: fallback })
			}
		},

		/**
		 * Spec §6.2: the server writes the file, the browser only supplies the
		 * markdown. The chat stays in the browser and gets marked archived.
		 */
		async archive() {
			const chat = this.activeChat
			if (!chat || this.messages.length === 0) {
				return
			}

			const config = useConfigStore()
			const profile = config.profileById(chat.profile_id) ?? config.defaultProfile
			const connection = profile ? config.connectionById(profile.connection_id) : null

			const markdown = this.messages
				.filter((m) => !m.pending)
				.map((m) => `## ${m.role}\n\n${m.content}\n`)
				.join('\n')

			try {
				const result = await api.archive({
					title: chat.title || t('llmchat', 'Untitled chat'),
					markdown,
					created_at: new Date(chat.created_at ?? Date.now()).toISOString(),
					profile: profile ? `${connection?.name ?? '?'} / ${profile.model}` : null,
					model: profile?.model ?? null,
					system_prompt: profile?.system_prompt ?? null,
				})

				await this.touchChat({ archived_path: result.path })
				showSuccess(t('llmchat', 'Archived to {path}', { path: result.path }))

				return result
			} catch (error) {
				showError(t('llmchat', 'Could not archive: {message}', { message: error.message }))
				throw error
			}
		},
	},
})
