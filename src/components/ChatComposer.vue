<template>
	<div class="composer">
		<!--
			One rounded box holds everything that belongs to the input: the
			textarea on top, a toolbar underneath with attachment button,
			profile switcher and send/stop — the way Mistral, Claude and
			OpenWebUI do it. The row below the box is pure metadata.
		-->
		<div class="composer__box">
			<textarea
				ref="input"
				v-model="text"
				class="composer__textarea"
				:placeholder="placeholder"
				:disabled="!chat.activeProfile"
				rows="1"
				@input="autogrow"
				@keydown="onKeydown" />

			<div class="composer__toolbar">
				<!--
					Issue #16: the file tools take a path relative to the home, and
					typing one by hand is tedious enough that people instead
					describe the file and hope the model finds it — which costs a
					search, a listing and often the wrong file. Only shown when the
					profile can actually read files; a path in the prompt is noise
					to a profile that cannot open it.
				-->
				<NcButton
					v-if="canPickFiles"
					class="composer__tool"
					:aria-label="t('llmchat', 'Insert a file path')"
					:title="t('llmchat', 'Insert a file path')"
					:disabled="chat.generating"
					@click="pickFiles">
					<template #icon>
						<Paperclip :size="20" />
					</template>
				</NcButton>

				<!--
					No visible label on purpose: the selected profile name is its
					own label. `ariaLabelCombobox` keeps it announced.
				-->
				<NcSelect
					v-model="selectedProfile"
					class="composer__profile"
					:options="profileOptions"
					:clearable="false"
					:disabled="chat.generating"
					:aria-label-combobox="t('llmchat', 'Profile')"
					label="label" />

				<span class="composer__spacer" />

				<NcButton
					v-if="chat.generating"
					class="composer__send"
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
					class="composer__send"
					variant="primary"
					:aria-label="t('llmchat', 'Send')"
					:title="hint"
					:disabled="!canSend"
					@click="submit">
					<template #icon>
						<Send :size="20" />
					</template>
				</NcButton>
			</div>
		</div>

		<!-- status bar (spec §5): metadata only, the controls live in the box -->
		<div class="composer__status">
			<span v-if="chat.activeProfile" class="composer__model">
				{{ chat.activeProfile.model }}
			</span>
			<span>{{ n('llmchat', '~%n token in context', '~%n tokens in context', tokens) }}</span>
			<span v-if="costHint">{{ costHint }}</span>
			<span class="composer__hint">{{ hint }}</span>
		</div>
	</div>
</template>

<script>
import { FilePickerClosed, getFilePickerBuilder, showError } from '@nextcloud/dialogs'
import NcButton from '@nextcloud/vue/components/NcButton'
import NcSelect from '@nextcloud/vue/components/NcSelect'
import Paperclip from 'vue-material-design-icons/Paperclip.vue'
import Send from 'vue-material-design-icons/Send.vue'
// aliased: <Stop> collides with the reserved SVG element name
import StopIcon from 'vue-material-design-icons/Stop.vue'
import { quotePath, relativeToHome } from '../services/paths.js'
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
		Paperclip,
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
			/** where the file picker reopens; not persisted, one session is enough */
			lastPickerPath: '/',
		}
	},

	computed: {
		canSend() {
			return this.text.trim() !== '' && !this.chat.generating && Boolean(this.chat.activeProfile)
		},

		profileOptions() {
			return this.config.usableProfiles.map((p) => ({ id: p.id, label: p.name }))
		},

		/**
		 * Issue #16: only worth offering when the model can do something with
		 * the path. Tied to `nc_read` rather than shown unconditionally —
		 * pasting a path into a profile without file tools produces a
		 * confident answer about a file nobody read.
		 */
		canPickFiles() {
			return this.chat.activeProfile?.enabled_tools?.includes('nc_read') === true
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

		/**
		 * Which modifier combination submits, mirrored in the hint next to
		 * the status bar. Default (enter_sends off): Enter breaks the line,
		 * Shift+Enter sends — the convention of the big chat UIs.
		 */
		hint() {
			return this.config.settings.enter_sends
				? this.t('llmchat', 'Enter sends, Shift+Enter adds a line break')
				: this.t('llmchat', 'Shift+Enter sends, Enter adds a line break')
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
		/**
		 * Switching chats clears the draft — except when something queued a
		 * prompt for the chat being switched *to* (issue #20). The Files
		 * action creates the chat and sets the text in the same breath, and
		 * this watcher runs after both.
		 */
		'chat.activeId': function() {
			this.text = this.chat.takePendingPrompt()
			this.$nextTick(this.focusEnd)
		},
	},

	mounted() {
		// the store may have been initialised before this component existed
		const pending = this.chat.takePendingPrompt()
		if (pending) {
			this.text = pending
			this.$nextTick(this.focusEnd)
		}
	},

	methods: {
		onKeydown(event) {
			if (event.key !== 'Enter' || event.isComposing) {
				return
			}

			// enter_sends on: Enter submits, Shift+Enter adds a line break.
			// Off (default): Enter adds a line break, Shift+Enter submits.
			const sends = this.config.settings.enter_sends ? !event.shiftKey : event.shiftKey
			if (sends) {
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

		/** Resizes and puts the caret after the text, ready to type. */
		focusEnd() {
			this.autogrow()

			const el = this.$refs.input
			if (!el || this.text === '') {
				return
			}

			el.focus()
			el.setSelectionRange(this.text.length, this.text.length)
		},

		/**
		 * Issue #16: pick files in the Files dialog and drop their paths into
		 * the prompt.
		 *
		 * Inserted as plain relative paths — no markdown link, no attachment
		 * chip. That is exactly what `nc_read_text`, `nc_read_pdf` and
		 * `nc_read_image` take as their `path` argument, so the model can pass
		 * it straight through instead of translating a display form back into
		 * one. Delimited, because a space in a filename otherwise reads as two
		 * paths.
		 */
		async pickFiles() {
			let picked
			try {
				const picker = getFilePickerBuilder(this.t('llmchat', 'Pick files for the model'))
					.setMultiSelect(true)
					// directories too: "summarise everything in here" is a
					// reasonable ask when nc_list_files exists
					.allowDirectories()
					.startAt(this.lastPickerPath)
					// the picker has no confirm button unless one is supplied
					.addButton({
						label: this.t('llmchat', 'Insert path'),
						variant: 'primary',
						callback: () => {},
					})
					.build()

				picked = await picker.pick()
			} catch (error) {
				// Cancelling *is* a rejection here, so the normal path arrives
				// as an exception and must stay quiet. Anything else is a real
				// failure, and swallowing it leaves a button that does nothing
				// and says nothing — so it gets a toast rather than a console
				// line nobody has open. Matched by class, not by `error.name`:
				// the bundled class sets no name, so that would read "Error"
				// and silence everything.
				if (!(error instanceof FilePickerClosed)) {
					showError(this.t('llmchat', 'Could not open the file picker: {message}', {
						message: error?.message ?? String(error),
					}))
				}

				return
			}

			// single-select still resolves to a bare string in some versions
			const paths = (Array.isArray(picked) ? picked : [picked])
				.filter((path) => typeof path === 'string' && path !== '')
				// the tools address files relative to the home, the picker
				// returns them rooted at it
				.map(relativeToHome)
				.filter(Boolean)

			if (paths.length === 0) {
				return
			}

			// reopen where the last pick happened: files that belong to one
			// question usually live in one folder
			const parent = paths[0].split('/').slice(0, -1).join('/')
			this.lastPickerPath = `/${parent}`

			const insert = paths.map(quotePath).join(' ')
			this.text = this.text === '' ? `${insert} ` : `${this.text.replace(/\s*$/, '')} ${insert} `

			this.$nextTick(this.focusEnd)
		},
	},
}
</script>

<style scoped>
.composer {
	flex: 0 0 auto;
	padding: 8px max(16px, calc((100% - 900px) / 2)) 10px;
	border-top: 1px solid var(--color-border);
}

/* the input is one box: textarea on top, toolbar with the controls below */
.composer__box {
	display: flex;
	flex-direction: column;
	border: 1px solid var(--color-border);
	/* rounder than NC's own --border-radius-large: this box should read as
	   one chat input, not as a form field */
	border-radius: 16px;
	background-color: var(--color-main-background);
	transition: border-color 100ms ease-in-out, box-shadow 100ms ease-in-out;
}

.composer__box:focus-within {
	border-color: var(--color-primary-element);
	box-shadow: 0 0 0 1px var(--color-primary-element);
}

.composer__textarea {
	width: 100%;
	min-height: 44px;
	max-height: 320px;
	margin: 0;
	padding: 12px 16px 4px;
	border: none;
	border-radius: 16px 16px 0 0;
	background: transparent;
	box-shadow: none;
	resize: none;
	overflow-y: auto;
}

.composer__textarea:focus {
	outline: none;
	box-shadow: none;
}

.composer__toolbar {
	display: flex;
	align-items: center;
	gap: 4px;
	padding: 4px 8px 6px;
}

.composer__spacer {
	flex: 1 1 auto;
}

/*
 * Round icon buttons, like the send/mic buttons of the big chat UIs. The
 * extra .composer__box in the selector outranks NcButton's own scoped
 * min-height/padding rules.
 */
.composer__box .composer__tool,
.composer__box .composer__send {
	flex: 0 0 auto;
	justify-content: center;
	width: 36px;
	min-width: 36px;
	height: 36px;
	min-height: 36px;
	padding: 0;
	border-radius: 50%;
}

/* the profile switcher as a borderless chip inside the toolbar. The scope
   attribute lands on .composer__toolbar (ours), so these selectors come
   out at (0,5,0) — ahead of NcSelect's own .nc-select… .vs__dropdown-toggle
   at (0,4,0), which would otherwise win the border-radius. */
.composer__profile {
	flex: 0 1 auto;
	min-width: 0;
	max-width: 240px;
}

.composer__box .composer__toolbar :deep(.composer__profile .vs__dropdown-toggle) {
	min-height: 34px;
	height: 34px;
	padding: 0 4px 0 12px;
	border: none;
	border-radius: 999px;
	background-color: var(--color-background-hover);
	box-shadow: none;
}

.composer__box .composer__toolbar :deep(.composer__profile .vs__dropdown-toggle:hover) {
	background-color: var(--color-background-dark);
}

.composer__box .composer__toolbar :deep(.composer__profile .vs__selected) {
	margin: 0;
	padding: 0;
	overflow: hidden;
	font-size: 0.85em;
	white-space: nowrap;
	text-overflow: ellipsis;
}

.composer__box .composer__toolbar :deep(.composer__profile .vs__search) {
	min-height: 30px;
	height: 30px;
	margin: 0;
	padding: 0;
	font-size: 0.85em;
}

.composer__box .composer__toolbar :deep(.composer__profile .vs__actions) {
	padding: 0 8px 0 4px;
}

.composer__box .composer__toolbar :deep(.composer__profile .vs__dropdown-menu) {
	font-size: 0.9em;
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

.composer__model {
	font-family: var(--font-face-monospace, monospace);
}

.composer__hint {
	margin-inline-start: auto;
}

@media (max-width: 700px) {
	.composer {
		padding: 6px 8px 8px;
	}

	.composer__textarea {
		padding: 10px 12px 2px;
	}

	/* the chip takes what is left between the icon buttons */
	.composer__profile {
		flex: 1 1 auto;
		max-width: none;
	}

	/* bigger touch targets */
	.composer__box .composer__tool,
	.composer__box .composer__send {
		width: 40px;
		min-width: 40px;
		height: 40px;
		min-height: 40px;
	}

	/* the keyboard hint is the first thing worth dropping on narrow screens */
	.composer__hint {
		display: none;
	}
}
</style>
