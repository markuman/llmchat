<template>
	<div
		class="message"
		:class="[`message--${message.role}`, { 'message--highlight': highlighted }]"
		:data-message-id="message.id">
		<div class="message__meta">
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
					force-menu>
					<template #icon>
						<Sync :size="16" />
					</template>
					<NcActionButton
						v-for="profile in otherProfiles"
						:key="profile.id"
						:close-after-click="true"
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
			<textarea ref="editor" v-model="draft" class="message__editor" rows="4" />
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
		</template>
	</div>
</template>

<script>
import ContentCopy from 'vue-material-design-icons/ContentCopy.vue'
import Pencil from 'vue-material-design-icons/Pencil.vue'
import Refresh from 'vue-material-design-icons/Refresh.vue'
import Robot from 'vue-material-design-icons/Robot.vue'
import Sync from 'vue-material-design-icons/Sync.vue'

import NcActionButton from '@nextcloud/vue/components/NcActionButton'
import NcActions from '@nextcloud/vue/components/NcActions'
import NcButton from '@nextcloud/vue/components/NcButton'

import { renderMarkdown, renderPlain } from '../services/markdown.js'
import { useChatStore } from '../store/chat.js'
import { useConfigStore } from '../store/config.js'

export default {
	name: 'ChatMessage',

	components: {
		ContentCopy,
		NcActionButton,
		NcActions,
		NcButton,
		Pencil,
		Refresh,
		Robot,
		Sync,
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

		roleLabel() {
			return this.isUser ? this.t('llmchat', 'You') : this.t('llmchat', 'Assistant')
		},

		canRegenerate() {
			return !this.isUser && this.isLast && !this.message.pending
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
			return this.config.settings.markdown_rendering && !this.isUser
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
