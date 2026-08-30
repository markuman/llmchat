<template>
	<!-- Spec §4.2: one modal, two tabs. -->
	<NcModal
		size="large"
		:name="t('llmchat', 'Connections & profiles')"
		@close="$emit('close')">
		<div class="manager">
			<h2 class="manager__title">{{ t('llmchat', 'Connections & profiles') }}</h2>

			<div class="manager__tabs">
				<NcButton
					:variant="tab === 'connections' ? 'primary' : 'tertiary'"
					@click="tab = 'connections'">
					{{ t('llmchat', 'Connections') }}
				</NcButton>
				<NcButton
					:variant="tab === 'profiles' ? 'primary' : 'tertiary'"
					@click="tab = 'profiles'">
					{{ t('llmchat', 'Profiles') }}
				</NcButton>
			</div>

			<NcNoteCard v-if="config.reloadRequired" type="warning">
				{{ t('llmchat', 'A connection URL changed. Reload the page to activate it.') }}
				<NcButton variant="primary" @click="reload">
					{{ t('llmchat', 'Reload now') }}
				</NcButton>
			</NcNoteCard>

			<ConnectionsTab v-if="tab === 'connections'" />
			<ProfilesTab v-else />
		</div>
	</NcModal>
</template>

<script>
import NcButton from '@nextcloud/vue/components/NcButton'
import NcModal from '@nextcloud/vue/components/NcModal'
import NcNoteCard from '@nextcloud/vue/components/NcNoteCard'

import ConnectionsTab from './ConnectionsTab.vue'
import ProfilesTab from './ProfilesTab.vue'
import { useConfigStore } from '../store/config.js'

export default {
	name: 'ManagerModal',

	components: {
		ConnectionsTab,
		NcButton,
		NcModal,
		NcNoteCard,
		ProfilesTab,
	},

	emits: ['close'],

	setup() {
		return { config: useConfigStore() }
	},

	data() {
		return {
			tab: this.config?.hasConnections ? 'profiles' : 'connections',
		}
	},

	created() {
		this.tab = this.config.hasConnections ? 'profiles' : 'connections'
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
