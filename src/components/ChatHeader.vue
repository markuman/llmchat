<template>
	<div class="header">
		<!--
			The profile switcher lives in the composer, not here: it is an action
			per message, and the collapsed navigation's toggle button is absolutely
			positioned right where this header starts.
		-->
		<input
			v-model="title"
			class="header__title"
			type="text"
			:placeholder="t('llmchat', 'Untitled chat')"
			@blur="saveTitle"
			@keydown.enter.prevent="$event.target.blur()">

		<!--
			3.0.0: does this chat read and write a memory? Visible at a glance,
			because it changes what the model knows and what gets written to
			a file afterwards.
		-->
		<span
			class="header__memory"
			:title="memoryTitle"
			:aria-label="memoryTitle">
			<Brain v-if="memoryProfile" :size="18" />
			<Incognito v-else :size="18" />
			<span v-if="memoryTruncated" class="header__badge">{{ t('llmchat', 'memory truncated') }}</span>
		</span>

		<a
			v-if="chat.activeChat?.archived_path"
			:href="archiveUrl"
			class="header__link"
			target="_blank"
			rel="noopener noreferrer">
			{{ chat.activeChat.archived_path }}
		</a>

		<NcButton
			:aria-label="t('llmchat', 'Archive chat')"
			:title="t('llmchat', 'Archive chat')"
			:disabled="chat.messages.length === 0 || archiving"
			variant="tertiary"
			@click="archive">
			<template #icon>
				<Archive :size="20" />
			</template>
		</NcButton>

		<NcActions :aria-label="t('llmchat', 'Chat actions')">
			<NcActionButton @click="exportMarkdown">
				<template #icon>
					<Download :size="20" />
				</template>
				{{ t('llmchat', 'Download as Markdown') }}
			</NcActionButton>
			<NcActionButton @click="remove">
				<template #icon>
					<Delete :size="20" />
				</template>
				{{ t('llmchat', 'Delete chat') }}
			</NcActionButton>
		</NcActions>
	</div>
</template>

<script>
import { generateUrl } from '@nextcloud/router'
import NcActionButton from '@nextcloud/vue/components/NcActionButton'
import NcActions from '@nextcloud/vue/components/NcActions'
import NcButton from '@nextcloud/vue/components/NcButton'
import Archive from 'vue-material-design-icons/Archive.vue'
import Brain from 'vue-material-design-icons/Brain.vue'
import Delete from 'vue-material-design-icons/Delete.vue'
import Download from 'vue-material-design-icons/Download.vue'
import Incognito from 'vue-material-design-icons/Incognito.vue'
import { useChatStore } from '../store/chat.js'
import { useConfigStore } from '../store/config.js'
import { kilo, useMemoryStore } from '../store/memory.js'

export default {
	name: 'ChatHeader',

	components: {
		Archive,
		Brain,
		Delete,
		Download,
		Incognito,
		NcActionButton,
		NcActions,
		NcButton,
	},

	setup() {
		return {
			chat: useChatStore(),
			config: useConfigStore(),
			memory: useMemoryStore(),
		}
	},

	data() {
		return {
			title: '',
			archiving: false,
		}
	},

	computed: {
		memoryProfile() {
			return this.config.memoryProfileFor(this.chat.activeProfile)
		},

		memoryTitle() {
			const memoryProfile = this.memoryProfile
			if (!memoryProfile) {
				return this.t('llmchat', 'Incognito — this profile has no memory')
			}

			const size = this.memory.sizes[memoryProfile.id]
			const limit = kilo(memoryProfile.max_chars)

			return size === undefined
				? `${memoryProfile.name} · ${this.t('llmchat', 'up to {limit} characters', { limit })}`
				: `${memoryProfile.name} · ${kilo(size)} / ${limit}`
		},

		memoryTruncated() {
			const snapshot = this.memory.snapshots[this.chat.activeId]

			return Boolean(snapshot?.truncated) && snapshot.memoryProfileId === this.memoryProfile?.id
		},

		archiveUrl() {
			const path = this.chat.activeChat?.archived_path
			if (!path) {
				return null
			}

			const dir = path.split('/').slice(0, -1).join('/') || '/'

			return generateUrl('/apps/files/?dir={dir}', { dir })
		},
	},

	watch: {
		'chat.activeChat.title': {
			immediate: true,
			handler(value) {
				this.title = value ?? ''
			},
		},
	},

	methods: {
		saveTitle() {
			if (this.title !== (this.chat.activeChat?.title ?? '')) {
				this.chat.renameChat(this.title)
			}
		},

		async archive() {
			this.archiving = true
			try {
				await this.chat.archive()
			} catch {
				// already reported by the store
			} finally {
				this.archiving = false
			}
		},

		exportMarkdown() {
			const chat = this.chat.activeChat
			const body = this.chat.messages
				.filter((m) => !m.pending)
				.map((m) => `## ${m.role}\n\n${m.content}\n`)
				.join('\n')

			const blob = new Blob([body], { type: 'text/markdown' })
			const url = URL.createObjectURL(blob)
			const link = document.createElement('a')
			link.href = url
			link.download = `${(chat?.title || 'chat').replace(/[^\w-]+/g, '-')}.md`
			link.click()
			URL.revokeObjectURL(url)
		},

		async remove() {
			const chat = this.chat.activeChat
			if (!chat) {
				return
			}

			if (!chat.archived_path
				&& !window.confirm(this.t('llmchat', 'Delete this chat? It is not archived and cannot be recovered.'))) {
				return
			}

			await this.chat.deleteChat(chat.id)
		},
	},
}
</script>

<style scoped>
.header {
	display: flex;
	align-items: center;
	gap: 8px;
	/*
	 * NcAppNavigation renders its collapse toggle as `position: absolute` at the
	 * navigation's trailing edge, which reaches one clickable-area into this
	 * header. Without the inline-start padding it sits on top of the title
	 * whenever the navigation is collapsed.
	 */
	padding: 6px 16px 6px calc(16px + var(--default-clickable-area, 44px));
	border-bottom: 1px solid var(--color-border);
}

.header__title {
	flex: 1 1 auto;
	min-width: 60px;
	border: 2px solid transparent;
	background: transparent;
	font-size: 1.05em;
	font-weight: 600;
}

.header__title:hover,
.header__title:focus {
	border-color: var(--color-border-dark);
}

.header__memory {
	display: inline-flex;
	align-items: center;
	gap: 4px;
	color: var(--color-text-maxcontrast);
}

.header__badge {
	padding: 0 6px;
	border-radius: var(--border-radius-pill);
	background-color: var(--color-warning);
	color: var(--color-primary-text);
	font-size: 0.75em;
	white-space: nowrap;
}

.header__link {
	color: var(--color-text-maxcontrast);
	font-size: 0.85em;
	max-width: 200px;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}
</style>
