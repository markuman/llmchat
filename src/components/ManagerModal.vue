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
		</div>
	</NcModal>
</template>

<script>
import NcButton from '@nextcloud/vue/components/NcButton'
import NcModal from '@nextcloud/vue/components/NcModal'
import NcNoteCard from '@nextcloud/vue/components/NcNoteCard'
import ConnectionsTab from './ConnectionsTab.vue'
import GeneralTab from './GeneralTab.vue'
import ProfilesTab from './ProfilesTab.vue'
import { useConfigStore } from '../store/config.js'

export default {
	name: 'ManagerModal',

	components: {
		ConnectionsTab,
		GeneralTab,
		NcButton,
		NcModal,
		NcNoteCard,
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
</style>
