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

		<template #list>
			<template v-for="group in chat.groupedChats" :key="group.id">
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
			<SettingsDrawer @open-manager="$emit('open-manager')" />
		</template>
	</NcAppNavigation>
</template>

<script>
import Archive from 'vue-material-design-icons/Archive.vue'
import Delete from 'vue-material-design-icons/Delete.vue'
import MessageText from 'vue-material-design-icons/MessageText.vue'
import Plus from 'vue-material-design-icons/Plus.vue'

import NcActionButton from '@nextcloud/vue/components/NcActionButton'
import NcAppNavigation from '@nextcloud/vue/components/NcAppNavigation'
import NcAppNavigationCaption from '@nextcloud/vue/components/NcAppNavigationCaption'
import NcAppNavigationItem from '@nextcloud/vue/components/NcAppNavigationItem'
import NcAppNavigationNew from '@nextcloud/vue/components/NcAppNavigationNew'

import SettingsDrawer from './SettingsDrawer.vue'
import { useChatStore } from '../store/chat.js'
import { useConfigStore } from '../store/config.js'

export default {
	name: 'ChatNavigation',

	components: {
		Archive,
		Delete,
		MessageText,
		NcActionButton,
		NcAppNavigation,
		NcAppNavigationCaption,
		NcAppNavigationItem,
		NcAppNavigationNew,
		Plus,
		SettingsDrawer,
	},

	emits: ['open-manager'],

	setup() {
		return {
			chat: useChatStore(),
			config: useConfigStore(),
		}
	},

	methods: {
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
