<template>
	<div class="message" :class="`message--${message.role}`">
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
					v-if="!isUser && isLast"
					:aria-label="t('llmchat', 'Regenerate response')"
					:title="t('llmchat', 'Regenerate response')"
					:disabled="chat.generating"
					variant="tertiary"
					@click="chat.regenerate()">
					<template #icon>
						<Refresh :size="16" />
					</template>
				</NcButton>
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

import NcButton from '@nextcloud/vue/components/NcButton'

import { renderMarkdown, renderPlain } from '../services/markdown.js'
import { useChatStore } from '../store/chat.js'
import { useConfigStore } from '../store/config.js'

export default {
	name: 'ChatMessage',

	components: {
		ContentCopy,
		NcButton,
		Pencil,
		Refresh,
	},

	props: {
		message: {
			type: Object,
			required: true,
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

.message__reasoning {
	margin-bottom: 8px;
	padding: 6px 10px;
	border-radius: var(--border-radius);
	background-color: var(--color-background-dark);
	color: var(--color-text-maxcontrast);
	font-size: 0.88em;
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
