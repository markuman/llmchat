<template>
	<!-- Spec §4.2, extended by issue #2: one modal, three tabs. -->
	<NcModal
		size="large"
		:name="t('llmchat', 'Settings')"
		@close="$emit('close')">
		<div class="manager">
			<h2 class="manager__title">
				{{ t('llmchat', 'Settings') }}
			</h2>

			<div class="manager__tabs">
				<NcButton
					v-for="entry in tabs"
					:key="entry.id"
					:variant="tab === entry.id ? 'primary' : 'tertiary'"
					@click="tab = entry.id">
					{{ entry.label }}
				</NcButton>
			</div>

			<NcNoteCard v-if="config.reloadRequired" type="warning">
				{{ t('llmchat', 'A connection URL changed. Reload the page to activate it.') }}
				<NcButton variant="primary" @click="reload">
					{{ t('llmchat', 'Reload now') }}
				</NcButton>
			</NcNoteCard>

			<GeneralTab v-if="tab === 'general'" />
			<ConnectionsTab v-else-if="tab === 'connections'" />
			<ProfilesTab v-else />

			<!--
				Issue #19. Below the tab content rather than inside the general
				tab: the version identifies the app, not the chat settings, and
				a bug report written while looking at the connections tab needs
				it just as much. It scrolls away with the content on purpose —
				this container is the scroll port, so anything pinned to its
				bottom edge would cover the last row of whichever tab is open.
			-->
			<footer class="manager__footer">
				<span v-if="config.version">
					{{ t('llmchat', 'Version {version}', { version: config.version }) }}
				</span>
				<a
					:href="repoUrl"
					class="manager__link"
					target="_blank"
					rel="noopener noreferrer">
					{{ t('llmchat', 'Source code and issue tracker') }}
					<OpenInNew :size="14" />
				</a>
			</footer>
		</div>
	</NcModal>
</template>

<script>
import NcButton from '@nextcloud/vue/components/NcButton'
import NcModal from '@nextcloud/vue/components/NcModal'
import NcNoteCard from '@nextcloud/vue/components/NcNoteCard'
import OpenInNew from 'vue-material-design-icons/OpenInNew.vue'
import ConnectionsTab from './ConnectionsTab.vue'
import GeneralTab from './GeneralTab.vue'
import ProfilesTab from './ProfilesTab.vue'
import { APP_REPO_URL, useConfigStore } from '../store/config.js'

export default {
	name: 'ManagerModal',

	components: {
		ConnectionsTab,
		GeneralTab,
		NcButton,
		NcModal,
		NcNoteCard,
		OpenInNew,
		ProfilesTab,
	},

	props: {
		/** Which tab to land on — 'general', 'connections' or 'profiles'. */
		initialTab: {
			type: String,
			default: null,
		},
	},

	emits: ['close'],

	setup() {
		return { config: useConfigStore() }
	},

	data() {
		return {
			tab: 'general',
			repoUrl: APP_REPO_URL,
		}
	},

	computed: {
		tabs() {
			return [
				{ id: 'general', label: this.t('llmchat', 'General') },
				{ id: 'connections', label: this.t('llmchat', 'Connections') },
				{ id: 'profiles', label: this.t('llmchat', 'Profiles') },
			]
		},
	},

	created() {
		// an unconfigured app has nothing to set up on the general tab yet
		this.tab = this.initialTab
			?? (this.config.hasConnections ? 'general' : 'connections')
	},

	methods: {
		reload() {
			window.location.reload()
		},
	},
}
</script>

<style scoped>
.manager {
	display: flex;
	flex-direction: column;
	gap: 12px;
	padding: 20px 24px 28px;
	max-height: 80vh;
	overflow-y: auto;
}

.manager__title {
	margin: 0;
}

.manager__tabs {
	display: flex;
	gap: 6px;
	border-bottom: 1px solid var(--color-border);
	padding-bottom: 8px;
}

.manager__footer {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 4px 12px;
	border-top: 1px solid var(--color-border);
	padding-top: 10px;
	font-size: 0.85em;
	color: var(--color-text-maxcontrast);
}

.manager__link {
	display: inline-flex;
	align-items: center;
	gap: 4px;
	text-decoration: underline;
}
</style>
