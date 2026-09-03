<template>
	<NcContent appName="llmchat" :class="{ 'llm-compact': config.settings.compact_mode }">
		<ChatNavigation @openManager="openManager" />

		<NcAppContent>
			<SetupHint v-if="!config.hasProfiles" @openManager="openManager(null)" />
			<ChatView v-else />
		</NcAppContent>

		<ManagerModal
			v-if="managerOpen"
			:initialTab="managerTab"
			@close="managerOpen = false" />

		<!-- at app level: the agent loop keeps running when the chat view scrolls -->
		<ToolApproval v-if="chat.pendingApproval" />
	</NcContent>
</template>

<script>
import NcAppContent from '@nextcloud/vue/components/NcAppContent'
import NcContent from '@nextcloud/vue/components/NcContent'
import ChatNavigation from './components/ChatNavigation.vue'
import ChatView from './components/ChatView.vue'
import ManagerModal from './components/ManagerModal.vue'
import SetupHint from './components/SetupHint.vue'
import ToolApproval from './components/ToolApproval.vue'
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
		ToolApproval,
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
			managerTab: null,
		}
	},

	mounted() {
		this.chat.init()
	},

	methods: {
		/**
		 * @param {string|null} tab tab to land on, null lets the modal decide
		 */
		openManager(tab = null) {
			this.managerTab = typeof tab === 'string' ? tab : null
			this.managerOpen = true
		},
	},
}
</script>
