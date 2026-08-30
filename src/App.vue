<template>
	<NcContent app-name="llmchat" :class="{ 'llm-compact': config.settings.compact_mode }">
		<ChatNavigation @open-manager="managerOpen = true" />

		<NcAppContent>
			<SetupHint v-if="!config.hasProfiles" @open-manager="managerOpen = true" />
			<ChatView v-else />
		</NcAppContent>

		<ManagerModal v-if="managerOpen" @close="managerOpen = false" />
	</NcContent>
</template>

<script>
import NcAppContent from '@nextcloud/vue/components/NcAppContent'
import NcContent from '@nextcloud/vue/components/NcContent'
import ChatNavigation from './components/ChatNavigation.vue'
import ChatView from './components/ChatView.vue'
import ManagerModal from './components/ManagerModal.vue'
import SetupHint from './components/SetupHint.vue'
import { useChatStore } from './store/chat.js'
import { useConfigStore } from './store/config.js'

export default {
	name: 'App',

	components: {
		ChatNavigation,
		ChatView,
		ManagerModal,
		NcAppContent,
		NcContent,
		SetupHint,
	},

	setup() {
		return {
			chat: useChatStore(),
			config: useConfigStore(),
		}
	},

	data() {
		return {
			managerOpen: false,
		}
	},

	mounted() {
		this.chat.init()
	},
}
</script>
