<template>
	<div class="composer">
		<div class="composer__input">
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
				:aria-label="t('llmchat', 'Insert a file path')"
				:title="t('llmchat', 'Insert a file path')"
				:disabled="chat.generating"
				@click="pickFiles">
				<template #icon>
					<Paperclip :size="20" />
				</template>
			</NcButton>

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
import { FilePickerClosed, getFilePickerBuilder, showError } from '@nextcloud/dialogs'
import NcButton from '@nextcloud/vue/components/NcButton'
import NcSelect from '@nextcloud/vue/components/NcSelect'
import Paperclip from 'vue-material-design-icons/Paperclip.vue'
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

/**
 * Wraps a picked path so a filename with spaces still reads as one path
 * (issue #16).
 *
 * Nextcloud allows `"` in filenames, so a plain `"…"` wrapper can be closed
 * by the name itself and the tail becomes prose. Backslash-escaping would
 * fix the parse and create a worse problem: the model would have to know to
 * strip the escapes again before calling a tool with the path, and one that
 * does not passes `report \"final\".pdf` to the file service, which 404s on a
 * file that exists. So the quote character steps aside instead — single
 * quotes when the name contains a double one, backticks when it contains
 * both. Whatever comes out is a path that can be copied verbatim into a tool
 * call.
 *
 * @param {string} path relative path from the picker
 * @return {string} the path, delimited
 */
function quotePath(path) {
	if (!path.includes('"')) {
		return `"${path}"`
	}
	if (!path.includes("'")) {
		return `'${path}'`
	}

	// A filename with both kinds of quote. Backticks read as code to the
	// model, which is if anything clearer — and markdown's own answer to a
	// backtick inside a code span is a longer fence, so even that case
	// delimits without touching the path. Nothing here may rewrite it: a
	// path the model cannot resolve is a 404 on a file that exists.
	const longestRun = Math.max(0, ...[...path.matchAll(/`+/g)].map((m) => m[0].length))
	const fence = '`'.repeat(longestRun + 1)

	// a leading or trailing backtick in the name would fuse with the fence
	return `${fence} ${path} ${fence}`
}

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
				.map((path) => path.replace(/^\/+/, ''))
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

			this.$nextTick(() => {
				this.autogrow()
				const el = this.$refs.input
				el?.focus()
				el?.setSelectionRange(this.text.length, this.text.length)
			})
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
