/**
 * Chat state. Everything lives in IndexedDB; the server is never involved
 * except for archiving.
 */

import { showError, showSuccess } from '@nextcloud/dialogs'
import { t } from '@nextcloud/l10n'
import { defineStore } from 'pinia'
import { markRaw } from 'vue'
import * as db from '../services/db.js'
import { api } from '../services/api.js'
import {
	estimateTokens,
	generateTitle,
	splitThink,
	streamCompletion,
} from '../services/llm.js'
import { executeTool, toolDefinitionsFor } from '../services/tools.js'
import { useConfigStore } from './config.js'

const DAY = 24 * 60 * 60 * 1000

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
	}),

	getters: {
		activeChat: (state) => state.chats.find((c) => c.id === state.activeId) ?? null,

		activeProfile(state) {
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

		async openChat(id) {
			this.abort()
			this.activeId = id
			this.messages = await db.listMessages(id)
		},

		async newChat() {
			const config = useConfigStore()
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

			if (this.activeId === id) {
				this.activeId = null
				this.messages = []
				if (this.chats.length > 0) {
					await this.openChat(this.chats[0].id)
				}
			}
		},

		abort() {
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
		 */
		async regenerate() {
			if (this.generating) {
				return
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
			}
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
		 * Bounded at MAX_TOOL_ROUNDS: a model that keeps calling tools gets
		 * one final round without tools instead of looping forever.
		 *
		 * @return {Promise<{content: string, usage: object|null}>} final completion
		 */
		async runAgentLoop({ connection, profile, history, placeholder }) {
			const MAX_TOOL_ROUNDS = 3

			const onDelta = ({ content, reasoning }) => {
				const target = this.messages.find((m) => m.id === placeholder.id)
				if (!target) {
					return
				}
				target.content += content
				target.reasoning += reasoning
			}

			const enabledTools = Array.isArray(profile.enabled_tools) ? profile.enabled_tools : []
			const definitions = toolDefinitionsFor(enabledTools)

			// ephemeral working copy — never persisted
			const loopMessages = [...history]
			let result = null

			for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
				const lastRound = round === MAX_TOOL_ROUNDS
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

					const { content, summary } = await executeTool(call, enabledTools)

					if (target) {
						if (!target.tool_log) {
							target.tool_log = []
						}
						target.tool_log.push({
							name: call.function.name,
							summary,
						})
					}

					loopMessages.push({
						role: 'tool',
						tool_call_id: call.id,
						content,
					})
				}
			}

			return result
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
