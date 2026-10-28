<template>
	<div
		class="message"
		:class="[`message--${message.role}`, { 'message--highlight': highlighted }]"
		:data-message-id="message.id">
		<div class="message__meta">
			<Brain v-if="isNote" :size="16" />
			<span class="message__role">{{ roleLabel }}</span>
			<span v-if="message.model" class="message__model">{{ message.model }}</span>
			<span v-if="message.aborted" class="message__flag">{{ t('llmchat', 'stopped') }}</span>

			<div class="message__actions">
				<NcButton
					:aria-label="t('llmchat', 'Copy message')"
					:title="t('llmchat', 'Copy message')"
					variant="tertiary"
					@click="copy">
					<template #icon>
						<ContentCopy :size="16" />
					</template>
				</NcButton>
				<NcButton
					v-if="isUser"
					:aria-label="t('llmchat', 'Edit and retry from here')"
					:title="t('llmchat', 'Edit and retry from here')"
					:disabled="chat.generating"
					variant="tertiary"
					@click="startEdit">
					<template #icon>
						<Pencil :size="16" />
					</template>
				</NcButton>
				<NcButton
					v-if="canRegenerate"
					:aria-label="t('llmchat', 'Regenerate response')"
					:title="t('llmchat', 'Regenerate response')"
					:disabled="chat.generating"
					variant="tertiary"
					@click="chat.regenerate()">
					<template #icon>
						<Refresh :size="16" />
					</template>
				</NcButton>
				<!--
					Issue #10: regenerating with another profile is the point of
					keeping several. Picking one switches the chat over, so the
					composer and the next message follow along.
				-->
				<NcActions
					v-if="canRegenerate && otherProfiles.length > 0"
					:aria-label="t('llmchat', 'Regenerate with another profile')"
					:disabled="chat.generating"
					forceMenu>
					<template #icon>
						<Sync :size="16" />
					</template>
					<NcActionButton
						v-for="profile in otherProfiles"
						:key="profile.id"
						:closeAfterClick="true"
						@click="chat.regenerate(profile.id)">
						<template #icon>
							<Robot :size="20" />
						</template>
						{{ profile.name }} — {{ profile.model }}
					</NcActionButton>
				</NcActions>
			</div>
		</div>

		<!-- edit mode -->
		<div v-if="editing" class="message__edit">
			<textarea
				ref="editor"
				v-model="draft"
				class="message__editor"
				rows="4" />
			<div class="message__edit-actions">
				<NcButton variant="primary" @click="submitEdit">
					{{ t('llmchat', 'Send from here') }}
				</NcButton>
				<NcButton @click="editing = false">
					{{ t('llmchat', 'Cancel') }}
				</NcButton>
			</div>
		</div>

		<template v-else>
			<!-- what the agent loop did, without polluting the chat context -->
			<details v-if="message.tool_log?.length" class="message__tools">
				<summary>
					{{ n('llmchat', '%n tool call', '%n tool calls', message.tool_log.length) }}
				</summary>
				<ul>
					<li v-for="(entry, i) in message.tool_log" :key="i">
						<code>{{ entry.name }}</code> — {{ entry.summary }}
					</li>
				</ul>
			</details>

			<!-- reasoning, collapsed by default (spec §11) -->
			<details v-if="showReasoning" class="message__reasoning">
				<summary>{{ t('llmchat', 'Reasoning') }}</summary>
				<pre>{{ message.reasoning }}</pre>
			</details>

			<div v-if="message.pending && !message.content" class="message__typing">
				<span /><span /><span />
			</div>

			<!-- eslint-disable-next-line vue/no-v-html -- sanitised in services/markdown.js -->
			<div v-else class="llm-markdown" v-html="html" />

			<!-- 3.0.0: what the recap did with this exchange -->
			<div v-if="memoryStatus === 'dreaming'" class="message__memory message__memory--dreaming">
				<Brain :size="16" />
				{{ t('llmchat', 'Remembering…') }}
			</div>
			<details v-else-if="memoryStatus === 'done'" class="message__memory">
				<summary>
					<Brain :size="16" />
					{{ memorySummary }}
				</summary>
				<ul>
					<li v-for="(entry, i) in message.memory_log" :key="i">
						<code>{{ entry.op }}</code> {{ entry.text }}
					</li>
				</ul>
				<p v-if="memoryUsage" class="message__memory-usage">
					{{ memoryUsage }}
				</p>
				<div class="message__memory-actions">
					<NcButton
						v-if="canUndoMemory"
						variant="tertiary"
						@click="chat.undoMemory(message)">
						<template #icon>
							<Undo :size="16" />
						</template>
						{{ t('llmchat', 'Undo') }}
					</NcButton>
					<span v-if="message.memory_undone">{{ t('llmchat', 'undone') }}</span>
					<a
						v-if="memoryFileUrl"
						:href="memoryFileUrl"
						target="_blank"
						rel="noopener noreferrer">
						{{ t('llmchat', 'Open file') }}
					</a>
				</div>
			</details>
			<div
				v-else-if="memoryStatus === 'error'"
				class="message__memory"
				:title="message.memory_error">
				<AlertCircleOutline :size="16" />
				{{ t('llmchat', 'Memory not updated') }}
			</div>
			<div v-else-if="isNote && memoryStatus === 'noop'" class="message__memory">
				<Brain :size="16" />
				{{ noteNoop }}
			</div>
		</template>
	</div>
</template>

<script>
import NcActionButton from '@nextcloud/vue/components/NcActionButton'
import NcActions from '@nextcloud/vue/components/NcActions'
import NcButton from '@nextcloud/vue/components/NcButton'
import AlertCircleOutline from 'vue-material-design-icons/AlertCircleOutline.vue'
import Brain from 'vue-material-design-icons/Brain.vue'
import ContentCopy from 'vue-material-design-icons/ContentCopy.vue'
import Pencil from 'vue-material-design-icons/Pencil.vue'
import Refresh from 'vue-material-design-icons/Refresh.vue'
import Robot from 'vue-material-design-icons/Robot.vue'
import Sync from 'vue-material-design-icons/Sync.vue'
import Undo from 'vue-material-design-icons/Undo.vue'
import { renderMarkdown, renderPlain } from '../services/markdown.js'
import { countOps, parseMemoryCommand } from '../services/memory.js'
import { filesAppUrl } from '../services/nextcloud.js'
import { useChatStore } from '../store/chat.js'
import { useConfigStore } from '../store/config.js'
import { useMemoryStore } from '../store/memory.js'

export default {
	name: 'ChatMessage',

	components: {
		AlertCircleOutline,
		Brain,
		ContentCopy,
		NcActionButton,
		NcActions,
		NcButton,
		Pencil,
		Refresh,
		Robot,
		Sync,
		Undo,
	},

	props: {
		message: {
			type: Object,
			required: true,
		},

		/** jumped to from the search — flash it so the eye finds it */
		highlighted: {
			type: Boolean,
			default: false,
		},
	},

	emits: ['edit'],

	setup() {
		return {
			chat: useChatStore(),
			config: useConfigStore(),
			memory: useMemoryStore(),
		}
	},

	data() {
		return {
			editing: false,
			draft: '',
		}
	},

	computed: {
		isUser() {
			return this.message.role === 'user'
		},

		isLast() {
			const messages = this.chat.messages

			return messages[messages.length - 1]?.id === this.message.id
		},

		/** /remember and /forget — talk to the memory, not to the model */
		isNote() {
			return this.message.role === 'note'
		},

		roleLabel() {
			if (this.isNote) {
				return this.t('llmchat', 'Memory')
			}

			return this.isUser ? this.t('llmchat', 'You') : this.t('llmchat', 'Assistant')
		},

		canRegenerate() {
			return this.message.role === 'assistant' && this.isLast && !this.message.pending
		},

		/**
		 * A "dreaming" that no recap of this page load is working on was cut
		 * off by a reload — showing it as still running would be a lie.
		 */
		memoryStatus() {
			const status = this.message.memory_status
			if (status === 'dreaming' && !this.chat.liveRecaps.includes(this.message.id)) {
				return 'error'
			}

			return status ?? null
		},

		memorySummary() {
			const log = this.message.memory_log ?? []
			const counts = countOps(log)
			const summary = this.t('llmchat', 'Remembered: +{added} ~{updated} −{deleted}', counts)

			return log.some((entry) => entry.op === 'COMPACT')
				? `${summary} · ${this.t('llmchat', 'compacted')}`
				: summary
		},

		/**
		 * Tokens the side calls cost — not part of the chat's context, so
		 * the composer's estimate cannot know about them.
		 */
		memoryUsage() {
			const calls = (this.message.memory_usage ?? []).filter((u) => u.prompt_tokens || u.completion_tokens)
			if (calls.length === 0) {
				return ''
			}

			return calls
				.map((u) => this.t('llmchat', '{call}: {input} in, {output} out', {
					call: u.call,
					input: u.prompt_tokens ?? '?',
					output: u.completion_tokens ?? '?',
				}))
				.join(' · ') + ` ${this.t('llmchat', 'tokens')}`
		},

		noteNoop() {
			return parseMemoryCommand(this.message.content)?.kind === 'forget'
				? this.t('llmchat', 'Nothing found to forget.')
				: this.t('llmchat', 'Nothing new to remember.')
		},

		canUndoMemory() {
			return !this.message.memory_undone
				&& this.memory.canUndo(this.message.memory_profile_id, this.message.id)
		},

		memoryFileUrl() {
			const path = this.config.memoryProfileById(this.message.memory_profile_id)?.path

			return path ? filesAppUrl(path) : null
		},

		/** Profiles other than the chat's current one, for a second opinion. */
		otherProfiles() {
			const current = this.chat.activeProfile?.id

			return this.config.usableProfiles.filter((p) => p.id !== current)
		},

		showReasoning() {
			return this.config.settings.show_reasoning
				&& !this.isUser
				&& Boolean(this.message.reasoning?.trim())
		},

		html() {
			return this.config.settings.markdown_rendering && !this.isUser && !this.isNote
				? renderMarkdown(this.message.content)
				: renderPlain(this.message.content)
		},
	},

	methods: {
		async copy() {
			try {
				await navigator.clipboard.writeText(this.message.content)
			} catch {
				// clipboard blocked
			}
		},

		startEdit() {
			this.draft = this.message.content
			this.editing = true
			this.$nextTick(() => this.$refs.editor?.focus())
		},

		submitEdit() {
			const content = this.draft.trim()
			this.editing = false

			if (content && content !== this.message.content) {
				this.$emit('edit', { id: this.message.id, content })
			}
		},
	},
}
</script>

<style scoped>
.message {
	margin-bottom: 14px;
	padding: 10px 14px;
	border-radius: var(--border-radius-large);
}

.message--user {
	background-color: var(--color-background-hover);
}

.message--highlight {
	animation: flash 1.4s ease-out 2;
	outline: 2px solid var(--color-primary-element);
}

@keyframes flash {
	0% { background-color: var(--color-primary-element-light); }
	100% { background-color: transparent; }
}

.message__meta {
	display: flex;
	align-items: center;
	gap: 8px;
	margin-bottom: 4px;
	color: var(--color-text-maxcontrast);
	font-size: 0.8em;
}

.message__role {
	font-weight: 600;
}

.message__flag {
	padding: 0 6px;
	border-radius: var(--border-radius);
	background-color: var(--color-warning);
	color: var(--color-primary-text);
}

.message__actions {
	display: flex;
	gap: 2px;
	margin-inline-start: auto;
	opacity: 0;
	transition: opacity 0.1s ease-in-out;
}

.message:hover .message__actions,
.message__actions:focus-within {
	opacity: 1;
}

.message__reasoning,
.message__tools {
	margin-bottom: 8px;
	padding: 6px 10px;
	border-radius: var(--border-radius);
	background-color: var(--color-background-dark);
	color: var(--color-text-maxcontrast);
	font-size: 0.88em;
}

.message__tools summary {
	cursor: pointer;
}

.message__tools ul {
	margin: 6px 0 0;
	padding-inline-start: 1.2em;
	list-style: disc;
}

.message__tools li {
	overflow-wrap: anywhere;
}

.message__reasoning summary {
	cursor: pointer;
}

.message--note {
	padding-block: 6px;
	border: 1px dashed var(--color-border-dark);
}

.message__memory {
	display: flex;
	align-items: center;
	gap: 4px;
	margin-top: 6px;
	color: var(--color-text-maxcontrast);
	font-size: 0.85em;
}

details.message__memory {
	display: block;
}

.message__memory summary {
	display: inline-flex;
	align-items: center;
	gap: 4px;
	cursor: pointer;
}

.message__memory ul {
	margin: 6px 0 0;
	padding-inline-start: 1.2em;
	list-style: disc;
}

.message__memory li {
	overflow-wrap: anywhere;
}

.message__memory-usage {
	margin: 4px 0 0;
	font-size: 0.9em;
}

.message__memory-actions {
	display: flex;
	align-items: center;
	gap: 8px;
}

.message__memory-actions a {
	text-decoration: underline;
}

/* css only, no timer: a recap can take a while and must not cost a re-render per tick */
.message__memory--dreaming {
	animation: dream 1.6s ease-in-out infinite;
}

@keyframes dream {
	0%, 100% { opacity: 0.35; }
	50% { opacity: 1; }
}

.message__reasoning pre {
	margin: 6px 0 0;
	white-space: pre-wrap;
}

.message__editor {
	width: 100%;
	font-family: var(--font-face-monospace, monospace);
	resize: vertical;
}

.message__edit-actions {
	display: flex;
	gap: 6px;
	margin-top: 6px;
}

.message__typing {
	display: flex;
	gap: 4px;
	padding: 6px 0;
}

.message__typing span {
	width: 6px;
	height: 6px;
	border-radius: 50%;
	background-color: var(--color-text-maxcontrast);
	animation: blink 1.2s infinite ease-in-out;
}

.message__typing span:nth-child(2) { animation-delay: 0.2s; }
.message__typing span:nth-child(3) { animation-delay: 0.4s; }

@keyframes blink {
	0%, 80%, 100% { opacity: 0.2; }
	40% { opacity: 1; }
}
</style>
