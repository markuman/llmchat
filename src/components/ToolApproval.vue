<template>
	<!--
		Shown before a tool call that leaves the browser runs. The point is not
		ceremony: a page the model fetched can contain instructions aimed at
		the model, and this is where you see the resulting request before it
		goes out.
	-->
	<NcDialog
		:name="t('llmchat', 'Allow this action?')"
		size="normal"
		:close-on-click-outside="false"
		@closing="deny">
		<div class="approval">
			<p class="approval__intro">
				{{ intro }}
			</p>

			<dl class="approval__args">
				<template v-for="(value, key) in pending.args" :key="key">
					<dt>{{ key }}</dt>
					<dd>{{ format(value) }}</dd>
				</template>
			</dl>

			<p v-if="Object.keys(pending.args).length === 0" class="approval__args-empty">
				{{ t('llmchat', 'No arguments.') }}
			</p>
		</div>

		<template #actions>
			<NcButton @click="deny">
				{{ t('llmchat', 'Deny') }}
			</NcButton>
			<NcButton variant="primary" @click="allow">
				{{ t('llmchat', 'Allow') }}
			</NcButton>
		</template>
	</NcDialog>
</template>

<script>
import NcButton from '@nextcloud/vue/components/NcButton'
import NcDialog from '@nextcloud/vue/components/NcDialog'

import { useChatStore } from '../store/chat.js'

const DESCRIPTIONS = {
	web_fetch: 'The model wants to fetch a web page. Its content will be sent to the model.',
	nc_search: 'The model wants to search your Nextcloud. Matching titles will be sent to the model.',
	nc_list_collectives: 'The model wants to list your collectives.',
	nc_list_pages: 'The model wants to list the pages of a collective.',
	nc_read_page: 'The model wants to read a collective page. Its content will be sent to the model.',
}

export default {
	name: 'ToolApproval',

	components: {
		NcButton,
		NcDialog,
	},

	setup() {
		return { chat: useChatStore() }
	},

	computed: {
		pending() {
			return this.chat.pendingApproval
		},

		intro() {
			const known = DESCRIPTIONS[this.pending.name]

			return known
				? this.t('llmchat', known)
				: this.t('llmchat', 'The model wants to run "{tool}".', { tool: this.pending.name })
		},
	},

	methods: {
		format(value) {
			const text = typeof value === 'string' ? value : JSON.stringify(value)

			return text.length > 300 ? `${text.slice(0, 300)}…` : text
		},

		allow() {
			this.chat.resolveApproval(true)
		},

		deny() {
			this.chat.resolveApproval(false)
		},
	},
}
</script>

<style scoped>
.approval {
	padding: 0 12px 8px;
}

.approval__intro {
	margin: 0 0 10px;
}

.approval__args {
	display: grid;
	grid-template-columns: auto 1fr;
	gap: 4px 12px;
	margin: 0;
	padding: 8px 10px;
	border-radius: var(--border-radius);
	background-color: var(--color-background-dark);
	font-size: 0.9em;
}

.approval__args dt {
	font-weight: 600;
	color: var(--color-text-maxcontrast);
}

.approval__args dd {
	margin: 0;
	overflow-wrap: anywhere;
	font-family: var(--font-face-monospace, monospace);
}

.approval__args-empty {
	margin: 0;
	color: var(--color-text-maxcontrast);
}
</style>
