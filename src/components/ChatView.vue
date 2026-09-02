<template>
	<div class="chat">
		<ChatHeader v-if="chat.activeChat" />

		<NcNoteCard v-if="config.reloadRequired" type="warning" class="chat__note">
			{{ t('llmchat', 'A connection was added or its URL changed. The page must be reloaded before it can be used.') }}
			<NcButton variant="primary" @click="reload">
				{{ t('llmchat', 'Reload now') }}
			</NcButton>
		</NcNoteCard>

		<NcNoteCard v-if="chat.storageWarning" type="warning" class="chat__note">
			{{ chat.storageWarning }}
		</NcNoteCard>

		<NcNoteCard v-if="chat.error" type="error" class="chat__note">
			{{ chat.error }}
		</NcNoteCard>

		<div ref="scroller" class="chat__messages" @scroll="onScroll">
			<NcEmptyContent
				v-if="chat.messages.length === 0"
				:name="t('llmchat', 'Ask something')"
				:description="emptyDescription">
				<template #icon>
					<Robot :size="20" />
				</template>
			</NcEmptyContent>

			<ChatMessage
				v-for="message in chat.messages"
				:key="message.id"
				:message="message"
				:highlighted="message.id === chat.highlightId"
				@edit="onEdit" />
		</div>

		<ChatComposer ref="composer" @send="onSend" />
	</div>
</template>

<script>
import Robot from 'vue-material-design-icons/Robot.vue'

import NcButton from '@nextcloud/vue/components/NcButton'
import NcEmptyContent from '@nextcloud/vue/components/NcEmptyContent'
import NcNoteCard from '@nextcloud/vue/components/NcNoteCard'

import ChatComposer from './ChatComposer.vue'
import ChatHeader from './ChatHeader.vue'
import ChatMessage from './ChatMessage.vue'
import { useChatStore } from '../store/chat.js'
import { useConfigStore } from '../store/config.js'

export default {
	name: 'ChatView',

	components: {
		ChatComposer,
		ChatHeader,
		ChatMessage,
		NcButton,
		NcEmptyContent,
		NcNoteCard,
		Robot,
	},

	setup() {
		return {
			chat: useChatStore(),
			config: useConfigStore(),
		}
	},

	data() {
		return {
			/** stop yanking the view down while the user is reading scrollback */
			stickToBottom: true,
			highlightTimer: null,
		}
	},

	computed: {
		emptyDescription() {
			const profile = this.chat.activeProfile

			return profile
				? this.t('llmchat', 'Using {model}. Your browser talks to the model directly.', { model: profile.model })
				: this.t('llmchat', 'Set up a profile first.')
		},

		lastContent() {
			const last = this.chat.messages[this.chat.messages.length - 1]

			return last ? `${this.chat.messages.length}:${last.content.length}` : '0'
		},
	},

	watch: {
		lastContent() {
			this.$nextTick(this.scrollToBottom)
		},

		'chat.activeId'() {
			this.stickToBottom = true
			this.$nextTick(this.scrollToBottom)
		},

		/** a search hit was opened: go there instead of to the bottom */
		'chat.highlightId'(id) {
			clearTimeout(this.highlightTimer)
			if (!id) {
				return
			}

			this.stickToBottom = false
			this.$nextTick(() => this.scrollToMessage(id))
			// the flash has done its job after a few seconds
			this.highlightTimer = setTimeout(() => {
				this.chat.highlightId = null
			}, 4000)
		},
	},

	mounted() {
		document.addEventListener('keydown', this.onKeydown)
		document.addEventListener('click', this.onCopyClick)
	},

	beforeUnmount() {
		clearTimeout(this.highlightTimer)
		document.removeEventListener('keydown', this.onKeydown)
		document.removeEventListener('click', this.onCopyClick)
	},

	methods: {
		onScroll() {
			const el = this.$refs.scroller
			if (!el) {
				return
			}

			this.stickToBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
		},

		scrollToMessage(id) {
			// the messages are rendered by v-for, so no ref list — one query
			// against the scroller is cheaper than maintaining refs
			const el = this.$refs.scroller?.querySelector(`[data-message-id="${id}"]`)
			el?.scrollIntoView({ block: 'center', behavior: 'smooth' })
		},

		scrollToBottom() {
			const el = this.$refs.scroller
			if (el && this.stickToBottom) {
				el.scrollTop = el.scrollHeight
			}
		},

		onSend(text) {
			this.stickToBottom = true
			this.chat.send(text)
		},

		onEdit({ id, content }) {
			this.chat.editAndRetry(id, content)
		},

		/** Esc aborts generation (spec §5). */
		onKeydown(event) {
			if (event.key === 'Escape' && this.chat.generating) {
				event.preventDefault()
				this.chat.abort()
			}
		},

		/**
		 * Copy buttons live inside v-html output, so they cannot have Vue
		 * listeners — one delegated handler instead.
		 */
		async onCopyClick(event) {
			const button = event.target.closest?.('.llm-code__copy')
			if (!button) {
				return
			}

			try {
				await navigator.clipboard.writeText(decodeURIComponent(button.dataset.code ?? ''))
				const original = button.textContent
				button.textContent = this.t('llmchat', 'Copied')
				setTimeout(() => {
					button.textContent = original
				}, 1500)
			} catch {
				// clipboard blocked, nothing sensible to do
			}
		},

		reload() {
			window.location.reload()
		},
	},
}
</script>

<style scoped>
.chat {
	display: flex;
	flex-direction: column;
	height: 100%;
	min-height: 0;
}

.chat__note {
	margin: 8px 16px 0;
}

.chat__messages {
	flex: 1 1 auto;
	min-height: 0;
	overflow-y: auto;
	padding: 12px max(16px, calc((100% - 900px) / 2));
}
</style>
