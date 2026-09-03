<template>
	<NcAppNavigation>
		<template #default>
			<NcAppNavigationNew
				:text="t('llmchat', 'New chat')"
				:disabled="!config.hasProfiles"
				@click="chat.newChat()">
				<template #icon>
					<Plus :size="20" />
				</template>
			</NcAppNavigationNew>
		</template>

		<!-- issue #6: searches titles and message bodies in IndexedDB -->
		<template #search>
			<NcAppNavigationSearch
				:modelValue="query"
				:label="t('llmchat', 'Search chats')"
				:placeholder="t('llmchat', 'Search titles and messages')"
				@update:modelValue="onQuery" />
		</template>

		<template #list>
			<!-- search mode: hits instead of the grouped history -->
			<template v-if="chat.searchActive">
				<NcAppNavigationCaption :name="resultCaption" />

				<li v-for="group in chat.searchResults" :key="group.chat.id" class="hit-group">
					<button
						type="button"
						class="hit hit--chat"
						:class="{ 'hit--active': group.chat.id === chat.activeId }"
						@click="openChat(group.chat)">
						<span class="hit__title">
							<span
								v-for="(part, i) in segments(group.chat.title || t('llmchat', 'Untitled chat'))"
								:key="i"
								:class="{ hit__mark: part.hit }">{{ part.text }}</span>
						</span>
						<span v-if="group.hits.length > 0" class="hit__count">
							{{ n('llmchat', '%n message', '%n messages', group.hits.length) }}
						</span>
					</button>

					<button
						v-for="hit in group.hits"
						:key="hit.message_id"
						type="button"
						class="hit hit--message"
						@click="chat.openHit(hit)">
						<span class="hit__role">{{ roleLabel(hit.role) }}</span>
						<span class="hit__excerpt">
							<span
								v-for="(part, i) in segments(hit.excerpt)"
								:key="i"
								:class="{ hit__mark: part.hit }">{{ part.text }}</span>
						</span>
					</button>
				</li>
			</template>

			<template v-for="group in chat.groupedChats" v-else :key="group.id">
				<NcAppNavigationCaption :name="group.label" />
				<NcAppNavigationItem
					v-for="item in group.chats"
					:key="item.id"
					:name="item.title || t('llmchat', 'Untitled chat')"
					:active="item.id === chat.activeId"
					@click="chat.openChat(item.id)">
					<template #icon>
						<Archive v-if="item.archived_path" :size="18" />
						<MessageText v-else :size="18" />
					</template>
					<template #actions>
						<NcActionButton @click="remove(item)">
							<template #icon>
								<Delete :size="20" />
							</template>
							{{ t('llmchat', 'Delete') }}
						</NcActionButton>
					</template>
				</NcAppNavigationItem>
			</template>
		</template>

		<template #footer>
			<!--
				Issue #2: no settings in the sidebar any more, only the door to
				the modal that has them all.
			-->
			<div class="nav__footer">
				<NcButton wide @click="$emit('openManager', 'general')">
					<template #icon>
						<Cog :size="20" />
					</template>
					{{ t('llmchat', 'Settings') }}
				</NcButton>
			</div>
		</template>
	</NcAppNavigation>
</template>

<script>
import NcActionButton from '@nextcloud/vue/components/NcActionButton'
import NcAppNavigation from '@nextcloud/vue/components/NcAppNavigation'
import NcAppNavigationCaption from '@nextcloud/vue/components/NcAppNavigationCaption'
import NcAppNavigationItem from '@nextcloud/vue/components/NcAppNavigationItem'
import NcAppNavigationNew from '@nextcloud/vue/components/NcAppNavigationNew'
import NcAppNavigationSearch from '@nextcloud/vue/components/NcAppNavigationSearch'
import NcButton from '@nextcloud/vue/components/NcButton'
import Archive from 'vue-material-design-icons/Archive.vue'
import Cog from 'vue-material-design-icons/Cog.vue'
import Delete from 'vue-material-design-icons/Delete.vue'
import MessageText from 'vue-material-design-icons/MessageText.vue'
import Plus from 'vue-material-design-icons/Plus.vue'
import { useChatStore } from '../store/chat.js'
import { useConfigStore } from '../store/config.js'

/** Long enough to not scan on every keystroke, short enough to feel live. */
const DEBOUNCE_MS = 180

function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export default {
	name: 'ChatNavigation',

	components: {
		Archive,
		Cog,
		Delete,
		MessageText,
		NcActionButton,
		NcAppNavigation,
		NcAppNavigationCaption,
		NcAppNavigationItem,
		NcAppNavigationNew,
		NcAppNavigationSearch,
		NcButton,
		Plus,
	},

	emits: ['openManager'],

	setup() {
		return {
			chat: useChatStore(),
			config: useConfigStore(),
		}
	},

	data() {
		return {
			query: '',
			timer: null,
		}
	},

	computed: {
		resultCaption() {
			if (this.chat.search.running) {
				return this.t('llmchat', 'Searching…')
			}

			const count = this.chat.searchResults.length

			return count === 0
				? this.t('llmchat', 'No matches')
				: this.n('llmchat', '%n chat found', '%n chats found', count)
		},
	},

	watch: {
		/**
		 * The store also clears the search on its own — starting a new chat,
		 * for instance. Mirror that back into the field instead of leaving a
		 * query in it that no longer applies to anything.
		 */
		'chat.search.query': function(value) {
			if (value === '' && this.query !== '') {
				clearTimeout(this.timer)
				this.query = ''
			}
		},
	},

	beforeUnmount() {
		clearTimeout(this.timer)
	},

	methods: {
		onQuery(value) {
			this.query = value
			clearTimeout(this.timer)

			// clearing must be immediate — waiting 180 ms for the old results
			// to disappear looks like the field is broken
			if (value === '') {
				this.chat.clearSearch()
				return
			}

			this.timer = setTimeout(() => this.chat.runSearch(value), DEBOUNCE_MS)
		},

		openChat(item) {
			this.chat.openChat(item.id)
		},

		roleLabel(role) {
			return role === 'user' ? this.t('llmchat', 'You') : this.t('llmchat', 'Assistant')
		},

		/**
		 * Splits text into plain and matching parts so hits can be marked
		 * without v-html.
		 *
		 * @param {string} text excerpt or title
		 * @return {Array<{text: string, hit: boolean}>} parts in order
		 */
		segments(text) {
			const terms = this.chat.searchTerms
			if (terms.length === 0) {
				return [{ text, hit: false }]
			}

			const pattern = new RegExp(`(${terms.map(escapeRegExp).join('|')})`, 'gi')

			return text
				.split(pattern)
				.filter((part) => part !== '')
				.map((part) => ({ text: part, hit: terms.includes(part.toLowerCase()) }))
		},

		async remove(item) {
			const label = item.title || this.t('llmchat', 'Untitled chat')

			// archived chats exist as a file, so losing the local copy is cheap
			if (!item.archived_path
				&& !window.confirm(this.t('llmchat', 'Delete "{title}"? It is not archived and cannot be recovered.', { title: label }))) {
				return
			}

			await this.chat.deleteChat(item.id)
		},
	},
}
</script>

<style scoped>
.nav__footer {
	padding: 8px;
}

.hit-group {
	margin-bottom: 6px;
	list-style: none;
}

.hit {
	display: flex;
	width: 100%;
	border: none;
	border-radius: var(--border-radius-large);
	background: transparent;
	text-align: start;
	cursor: pointer;
}

.hit:hover,
.hit:focus-visible {
	background-color: var(--color-background-hover);
}

.hit--chat {
	align-items: baseline;
	gap: 6px;
	padding: 4px 10px;
	font-weight: 600;
}

.hit--active {
	background-color: var(--color-primary-element-light);
}

.hit__title {
	flex: 1 1 auto;
	min-width: 0;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.hit__count {
	flex: 0 0 auto;
	color: var(--color-text-maxcontrast);
	font-size: 0.8em;
	font-weight: normal;
}

.hit--message {
	flex-direction: column;
	gap: 1px;
	margin-inline-start: 10px;
	padding: 4px 8px;
	font-size: 0.85em;
}

.hit__role {
	color: var(--color-text-maxcontrast);
	font-size: 0.9em;
}

.hit__excerpt {
	display: -webkit-box;
	-webkit-box-orient: vertical;
	-webkit-line-clamp: 3;
	line-clamp: 3;
	overflow: hidden;
	line-height: 1.35;
}

.hit__mark {
	border-radius: 2px;
	background-color: var(--color-warning, #e9a13b);
	color: var(--color-main-text);
	font-weight: 600;
}
</style>
