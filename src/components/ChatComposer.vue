<template>
	<div class="composer">
		<div class="composer__input">
			<textarea
				ref="input"
				v-model="text"
				class="composer__textarea"
				:placeholder="placeholder"
				:disabled="!chat.activeProfile"
				rows="1"
				@input="autogrow"
				@keydown="onKeydown" />

			<NcButton
				v-if="chat.generating"
				variant="error"
				:aria-label="t('llmchat', 'Stop generating')"
				:title="t('llmchat', 'Stop generating (Esc)')"
				@click="chat.abort()">
				<template #icon>
					<StopIcon :size="20" />
				</template>
			</NcButton>
			<NcButton
				v-else
				variant="primary"
				:aria-label="t('llmchat', 'Send')"
				:disabled="!canSend"
				@click="submit">
				<template #icon>
					<Send :size="20" />
				</template>
			</NcButton>
		</div>

		<!-- status bar (spec §5) with the profile switcher (spec §4.3) -->
		<div class="composer__status">
			<!--
				No visible label on purpose: this is a metadata row, and the
				selected profile name is its own label. `ariaLabelCombobox`
				keeps it announced without taking vertical space.
			-->
			<NcSelect
				v-model="selectedProfile"
				class="composer__profile"
				:options="profileOptions"
				:clearable="false"
				:disabled="chat.generating"
				:aria-label-combobox="t('llmchat', 'Profile')"
				label="label" />

			<span v-if="chat.activeProfile" class="composer__model">
				{{ chat.activeProfile.model }}
			</span>
			<span>{{ n('llmchat', '~%n token in context', '~%n tokens in context', tokens) }}</span>
			<span v-if="costHint">{{ costHint }}</span>
			<span class="composer__hint">{{ t('llmchat', 'Enter sends, Shift+Enter adds a line break') }}</span>
		</div>
	</div>
</template>

<script>
import NcButton from '@nextcloud/vue/components/NcButton'
import NcSelect from '@nextcloud/vue/components/NcSelect'
import Send from 'vue-material-design-icons/Send.vue'
// aliased: <Stop> collides with the reserved SVG element name
import StopIcon from 'vue-material-design-icons/Stop.vue'
import { useChatStore } from '../store/chat.js'
import { useConfigStore } from '../store/config.js'

/**
 * Very rough per-token price used only as an order-of-magnitude hint for
 * OpenRouter. Anything more precise would mean shipping a price table that
 * goes stale within a week.
 */
const ROUGH_USD_PER_1K = 0.002

export default {
	name: 'ChatComposer',

	components: {
		NcButton,
		NcSelect,
		Send,
		StopIcon,
	},

	emits: ['send'],

	setup() {
		return {
			chat: useChatStore(),
			config: useConfigStore(),
		}
	},

	data() {
		return {
			text: '',
		}
	},

	computed: {
		canSend() {
			return this.text.trim() !== '' && !this.chat.generating && Boolean(this.chat.activeProfile)
		},

		profileOptions() {
			return this.config.usableProfiles.map((p) => ({ id: p.id, label: p.name }))
		},

		selectedProfile: {
			get() {
				const profile = this.chat.activeProfile
				return profile ? { id: profile.id, label: profile.name } : null
			},

			set(option) {
				if (option?.id) {
					this.chat.setProfile(option.id)
				}
			},
		},

		tokens() {
			return this.chat.contextTokens + Math.ceil(this.text.length / 4)
		},

		placeholder() {
			return this.chat.activeProfile
				? this.t('llmchat', 'Message the model…')
				: this.t('llmchat', 'Create a profile to start chatting')
		},

		costHint() {
			const connection = this.chat.activeConnection
			if (connection?.provider_hint !== 'openrouter') {
				return null
			}

			const usd = (this.tokens / 1000) * ROUGH_USD_PER_1K

			return this.t('llmchat', '≈ ${amount} per request (rough)', { amount: usd.toFixed(4) })
		},
	},

	watch: {
		'chat.activeId': function() {
			this.text = ''
			this.$nextTick(this.autogrow)
		},
	},

	methods: {
		onKeydown(event) {
			if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
				event.preventDefault()
				this.submit()
			}
		},

		submit() {
			if (!this.canSend) {
				return
			}

			this.$emit('send', this.text)
			this.text = ''
			this.$nextTick(this.autogrow)
		},

		autogrow() {
			const el = this.$refs.input
			if (!el) {
				return
			}

			el.style.height = 'auto'
			el.style.height = `${Math.min(el.scrollHeight, 320)}px`
		},
	},
}
</script>

<style scoped>
.composer {
	flex: 0 0 auto;
	padding: 8px max(16px, calc((100% - 900px) / 2)) 12px;
	border-top: 1px solid var(--color-border);
}

.composer__input {
	display: flex;
	align-items: flex-end;
	gap: 6px;
}

.composer__textarea {
	flex: 1 1 auto;
	min-height: 44px;
	max-height: 320px;
	margin: 0;
	resize: none;
	overflow-y: auto;
}

.composer__status {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 4px 12px;
	margin-top: 4px;
	color: var(--color-text-maxcontrast);
	font-size: 0.78em;
}

/*
 * NcSelect brings its own min-height sized for form layouts, which would make
 * the status bar twice as tall. Scale it down to fit a metadata row.
 */
.composer__profile {
	flex: 0 0 auto;
	min-width: 150px;
	max-width: 240px;
}

.composer__profile :deep(.vs__dropdown-toggle) {
	min-height: 30px;
}

.composer__profile :deep(input) {
	min-height: 30px;
	height: 30px;
	font-size: 1em;
}

.composer__model {
	font-family: var(--font-face-monospace, monospace);
}

.composer__hint {
	margin-inline-start: auto;
}

/* the keyboard hint is the first thing worth dropping on narrow screens */
@media (max-width: 700px) {
	.composer__hint {
		display: none;
	}
}
</style>
