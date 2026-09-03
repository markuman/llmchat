<template>
	<NcEmptyContent
		:name="t('llmchat', 'Nothing set up yet')"
		:description="description">
		<template #icon>
			<Robot :size="20" />
		</template>
		<template #action>
			<NcButton variant="primary" @click="$emit('openManager')">
				{{ t('llmchat', 'Set up connection & profile') }}
			</NcButton>
		</template>
	</NcEmptyContent>
</template>

<script>
import NcButton from '@nextcloud/vue/components/NcButton'
import NcEmptyContent from '@nextcloud/vue/components/NcEmptyContent'
import Robot from 'vue-material-design-icons/Robot.vue'
import { useConfigStore } from '../store/config.js'

export default {
	name: 'SetupHint',

	components: {
		NcButton,
		NcEmptyContent,
		Robot,
	},

	emits: ['openManager'],

	setup() {
		return { config: useConfigStore() }
	},

	computed: {
		description() {
			return this.config.hasConnections
				? this.t('llmchat', 'You have a connection but no profile yet. A profile picks the model and the system prompt.')
				: this.t('llmchat', 'Add a connection to your Ollama instance or an OpenAI-compatible API. Your browser talks to it directly — this server never sees your prompts.')
		},
	},
}
</script>
