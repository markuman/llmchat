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
		<ToolQuestions v-if="chat.pendingQuestions" />
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
import ToolQuestions from './components/ToolQuestions.vue'
import { quotePath, relativeToHome } from './services/paths.js'
import { useChatStore } from './store/chat.js'
import { useConfigStore } from './store/config.js'

/** No prompt in a link may be longer than this. Nothing needs it to be. */
const MAX_PROMPT_CHARS = 4000

/**
 * Reads what the page was opened with (issue #20).
 *
 * `?path=` comes from the Files action and is a file path, so it arrives
 * quoted — the same treatment the file picker gives a path, for the same
 * reason. `?prompt=` is free text for anyone linking into the app.
 *
 * The parameter is dropped from the address bar afterwards: it has been
 * consumed, and leaving it there means reloading the page silently starts a
 * second chat about the same file.
 *
 * @return {string} text for the composer, or an empty string
 */
function initialPrompt() {
	let params
	try {
		params = new URLSearchParams(window.location.search)
	} catch {
		return ''
	}

	// Truncated before quoting, not after: cutting the result would drop the
	// closing quote and leave the model with a path that runs into whatever
	// the user types next. Nothing legitimate comes near the limit — but a
	// path is the one input here whose delimiters carry meaning.
	const path = relativeToHome(params.get('path') ?? '').trim().slice(0, MAX_PROMPT_CHARS)
	const raw = path === ''
		? (params.get('prompt') ?? '').trim().slice(0, MAX_PROMPT_CHARS)
		: `${quotePath(path)} `

	if (raw === '') {
		return ''
	}

	try {
		params.delete('path')
		params.delete('prompt')
		const query = params.toString()
		window.history.replaceState(
			window.history.state,
			'',
			window.location.pathname + (query === '' ? '' : `?${query}`) + window.location.hash,
		)
	} catch {
		// a browser that refuses replaceState still gets the prompt
	}

	return raw
}

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
		ToolQuestions,
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
		this.chat.init({ prompt: initialPrompt() })
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
