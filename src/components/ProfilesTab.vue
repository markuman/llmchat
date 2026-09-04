<template>
	<div class="tab">
		<NcNoteCard v-if="!config.hasConnections" type="warning">
			{{ t('llmchat', 'Create a connection first.') }}
		</NcNoteCard>

		<ul v-else class="tab__list">
			<li
				v-for="(profile, index) in config.sortedProfiles"
				:key="profile.id"
				class="row"
				:class="{ 'row--active': form.id === profile.id }"
				draggable="true"
				@dragstart="dragIndex = index"
				@dragover.prevent
				@drop="drop(index)">
				<DragHorizontalVariant :size="20" class="row__handle" />

				<div class="row__main">
					<strong>{{ profile.name }}</strong>
					<span class="row__sub">
						{{ connectionName(profile.connection_id) }} / {{ profile.model }}
					</span>
				</div>

				<span v-if="profile.is_default" class="row__badge">{{ t('llmchat', 'default') }}</span>

				<NcButton variant="tertiary" :aria-label="t('llmchat', 'Edit')" @click="edit(profile)">
					<template #icon>
						<Pencil :size="20" />
					</template>
				</NcButton>

				<!-- spec §4.2: duplicating is a primary action, not buried in an overflow menu -->
				<NcButton variant="tertiary" :aria-label="t('llmchat', 'Duplicate')" @click="duplicate(profile)">
					<template #icon>
						<ContentDuplicate :size="20" />
					</template>
				</NcButton>

				<NcActions :aria-label="t('llmchat', 'More actions')">
					<NcActionButton
						:disabled="profile.is_default"

						@click="makeDefault(profile)">
						<template #icon>
							<Star :size="20" />
						</template>
						{{ t('llmchat', 'Set as default') }}
					</NcActionButton>
					<NcActionButton @click="exportOne(profile)">
						<template #icon>
							<Download :size="20" />
						</template>
						{{ t('llmchat', 'Export') }}
					</NcActionButton>
					<NcActionButton @click="remove(profile)">
						<template #icon>
							<Delete :size="20" />
						</template>
						{{ t('llmchat', 'Delete') }}
					</NcActionButton>
				</NcActions>
			</li>
		</ul>

		<div class="tab__io">
			<NcButton :disabled="!config.hasProfiles" @click="exportAll">
				<template #icon>
					<Download :size="20" />
				</template>
				{{ t('llmchat', 'Export all') }}
			</NcButton>
			<NcButton :disabled="!config.hasConnections" @click="$refs.importInput.click()">
				<template #icon>
					<Upload :size="20" />
				</template>
				{{ t('llmchat', 'Import') }}
			</NcButton>
			<input
				ref="importInput"
				type="file"
				accept="application/json,.json"
				class="tab__file"
				@change="importFile">
		</div>

		<form v-if="config.hasConnections" class="form" @submit.prevent="save">
			<h3 class="form__title">
				{{ form.id ? t('llmchat', 'Edit profile') : t('llmchat', 'New profile') }}
			</h3>

			<NcTextField v-model="form.name" :label="t('llmchat', 'Name')" />

			<NcSelect
				v-model="connectionOption"
				:inputLabel="t('llmchat', 'Connection')"
				:options="connectionOptions"
				:clearable="false"
				label="label" />

			<div class="form__model">
				<!--
					Spec §7.4: pick from a fetched list instead of typing, which
					kills the "model xyz does not work" tickets caused by typos.
					The free-text field only appears when the list is unavailable.
				-->
				<NcSelect
					v-if="modelOptions.length > 0"
					v-model="modelOption"
					class="form__model-select"
					:inputLabel="t('llmchat', 'Model')"
					:options="modelOptions"
					:loading="loadingModels"
					:clearable="false"
					label="label" />
				<NcTextField
					v-else
					v-model="form.model"
					class="form__model-select"
					:label="t('llmchat', 'Model')"
					:placeholder="t('llmchat', 'e.g. llama3.2:3b')" />
				<NcButton
					:aria-label="t('llmchat', 'Refresh model list')"
					:title="t('llmchat', 'Refresh model list')"
					:disabled="!form.connection_id || loadingModels"
					@click="loadModels(true)">
					<template #icon>
						<Refresh :size="20" />
					</template>
				</NcButton>
			</div>

			<NcNoteCard v-if="modelError" type="warning">
				{{ modelError }}
			</NcNoteCard>

			<label class="form__label" for="llm-system-prompt">
				{{ t('llmchat', 'System prompt') }}
			</label>
			<textarea
				id="llm-system-prompt"
				ref="systemPrompt"
				v-model="form.system_prompt"
				class="form__prompt"
				rows="4"
				@input="autogrow" />

			<div class="form__grid">
				<NcTextField
					v-model="form.temperature"
					type="number"
					step="0.1"
					min="0"
					max="2"
					:label="t('llmchat', 'Temperature')"
					:placeholder="t('llmchat', 'backend default')" />
				<NcTextField
					v-model="form.max_tokens"
					type="number"
					min="1"
					:label="t('llmchat', 'Max tokens')"
					:placeholder="t('llmchat', 'backend default')" />
			</div>

			<NcCheckboxRadioSwitch v-model="form.streaming" type="switch">
				{{ t('llmchat', 'Stream responses') }}
			</NcCheckboxRadioSwitch>

			<NcCheckboxRadioSwitch v-model="form.reasoning" type="switch">
				{{ t('llmchat', 'Allow reasoning') }}
			</NcCheckboxRadioSwitch>
			<p class="form__hint">
				{{ t('llmchat', 'Off actually disables thinking on backends that support it, which saves tokens. Not every model can be told to stop.') }}
			</p>

			<!--
				Individually selectable, not one switch: datetime is answered
				in the browser and costs nothing privacy-wise, the web tools
				route queries and URLs through this server.
			-->
			<label class="form__label">{{ t('llmchat', 'Tools') }}</label>

			<NcCheckboxRadioSwitch
				:modelValue="form.enabled_tools.includes('datetime')"
				@update:modelValue="toggleTool('datetime', $event)">
				{{ t('llmchat', 'Date & time — answered locally by your browser') }}
			</NcCheckboxRadioSwitch>

			<!-- issue #15: the only tool whose answer comes from the user -->
			<NcCheckboxRadioSwitch
				:modelValue="form.enabled_tools.includes('ask_user')"
				@update:modelValue="toggleTool('ask_user', $event)">
				{{ t('llmchat', 'Ask you a question — the model asks instead of guessing') }}
			</NcCheckboxRadioSwitch>

			<NcCheckboxRadioSwitch
				:modelValue="form.enabled_tools.includes('web_search')"
				@update:modelValue="toggleTool('web_search', $event)">
				{{ t('llmchat', 'Web search — your browser queries SearXNG directly') }}
			</NcCheckboxRadioSwitch>

			<NcCheckboxRadioSwitch
				:modelValue="form.enabled_tools.includes('web_fetch')"
				@update:modelValue="toggleTool('web_fetch', $event)">
				{{ t('llmchat', 'Fetch web pages — URLs go through this server') }}
			</NcCheckboxRadioSwitch>

			<NcCheckboxRadioSwitch
				:modelValue="form.enabled_tools.includes('nc_read')"
				@update:modelValue="toggleTool('nc_read', $event)">
				{{ t('llmchat', 'Read Nextcloud — search, files and collectives, read-only') }}
			</NcCheckboxRadioSwitch>

			<p class="form__hint">
				{{ toolsHint }}
			</p>

			<!--
				Not derived from the model name: the list of vision-capable
				models changes weekly and a wrong guess either hides a working
				feature or sends a megabyte of base64 to something that reads
				it as gibberish. So the user says.
			-->
			<template v-if="form.enabled_tools.includes('nc_read')">
				<NcCheckboxRadioSwitch v-model="form.vision" type="switch">
					{{ t('llmchat', 'Model can see images') }}
				</NcCheckboxRadioSwitch>
				<p class="form__hint">
					{{ visionHint }}
				</p>
			</template>

			<template v-if="form.enabled_tools.length > 0">
				<NcCheckboxRadioSwitch v-model="form.tool_approval" type="switch">
					{{ t('llmchat', 'Ask before each tool call') }}
				</NcCheckboxRadioSwitch>
				<p class="form__hint">
					{{ t('llmchat', 'Recommended. A fetched page can contain instructions aimed at the model, so this is where you see the resulting request before it goes out. Date/time and web search are never confirmed.') }}
				</p>

				<!--
					Overrides the general setting: a research profile may chain
					a search into several fetches, while a plain chat profile
					should not pay for that budget.
				-->
				<NcTextField
					v-model="form.tool_rounds"
					type="number"
					:min="minToolRounds"
					:max="maxToolRounds"
					step="1"
					:label="t('llmchat', 'Tool rounds per answer')"
					:placeholder="toolRoundsPlaceholder" />
				<p class="form__hint">
					{{ toolRoundsHint }}
				</p>
			</template>

			<div class="form__actions">
				<NcButton :disabled="!canSubmit || saving" variant="primary" type="submit">
					{{ form.id ? t('llmchat', 'Save') : t('llmchat', 'Create') }}
				</NcButton>
				<NcButton v-if="form.id" @click="reset">
					{{ t('llmchat', 'Cancel') }}
				</NcButton>
			</div>
		</form>
	</div>
</template>

<script>
import { showError, showSuccess } from '@nextcloud/dialogs'
import NcActionButton from '@nextcloud/vue/components/NcActionButton'
import NcActions from '@nextcloud/vue/components/NcActions'
import NcButton from '@nextcloud/vue/components/NcButton'
import NcCheckboxRadioSwitch from '@nextcloud/vue/components/NcCheckboxRadioSwitch'
import NcNoteCard from '@nextcloud/vue/components/NcNoteCard'
import NcSelect from '@nextcloud/vue/components/NcSelect'
import NcTextField from '@nextcloud/vue/components/NcTextField'
import ContentDuplicate from 'vue-material-design-icons/ContentDuplicate.vue'
import Delete from 'vue-material-design-icons/Delete.vue'
import Download from 'vue-material-design-icons/Download.vue'
import DragHorizontalVariant from 'vue-material-design-icons/DragHorizontalVariant.vue'
import Pencil from 'vue-material-design-icons/Pencil.vue'
import Refresh from 'vue-material-design-icons/Refresh.vue'
import Star from 'vue-material-design-icons/Star.vue'
import Upload from 'vue-material-design-icons/Upload.vue'
import { cacheModels, getCachedModels } from '../services/db.js'
import { fetchModels } from '../services/llm.js'
import { MAX_TOOL_ROUNDS, MIN_TOOL_ROUNDS, useConfigStore } from '../store/config.js'

function emptyForm(connectionId = null) {
	return {
		id: null,
		name: '',
		connection_id: connectionId,
		model: '',
		system_prompt: '',
		temperature: '',
		max_tokens: '',
		streaming: true,
		reasoning: true,
		enabled_tools: [],
		tool_approval: true,
		// empty means "follow the general setting"
		tool_rounds: '',
		vision: false,
	}
}

export default {
	name: 'ProfilesTab',

	components: {
		ContentDuplicate,
		Delete,
		Download,
		DragHorizontalVariant,
		NcActionButton,
		NcActions,
		NcButton,
		NcCheckboxRadioSwitch,
		NcNoteCard,
		NcSelect,
		NcTextField,
		Pencil,
		Refresh,
		Star,
		Upload,
	},

	setup() {
		return { config: useConfigStore() }
	},

	data() {
		return {
			form: emptyForm(),
			saving: false,
			models: [],
			loadingModels: false,
			modelError: null,
			dragIndex: null,
			minToolRounds: MIN_TOOL_ROUNDS,
			maxToolRounds: MAX_TOOL_ROUNDS,
		}
	},

	computed: {
		connectionOptions() {
			return this.config.connections.map((c) => ({ id: c.id, label: c.name }))
		},

		connectionOption: {
			get() {
				return this.connectionOptions.find((o) => o.id === this.form.connection_id) ?? null
			},

			set(option) {
				this.form.connection_id = option?.id ?? null
			},
		},

		modelOptions() {
			return this.models.map((m) => ({ id: m, label: m }))
		},

		modelOption: {
			get() {
				return this.form.model ? { id: this.form.model, label: this.form.model } : null
			},

			set(option) {
				this.form.model = option?.id ?? ''
			},
		},

		canSubmit() {
			return this.form.name.trim() !== ''
				&& this.form.model.trim() !== ''
				&& Boolean(this.form.connection_id)
		},

		toolsHint() {
			const tools = this.form.enabled_tools
			if (tools.length === 0) {
				return this.t('llmchat', 'No tools. The model answers from what it was trained on.')
			}

			const base = this.t('llmchat', 'Requires a model that supports tool calling.')

			// what matters is what ends up at the model, so name the most
			// far-reaching consequence of the current selection
			if (tools.includes('nc_read')) {
				return `${base} ${this.t('llmchat', 'Nextcloud content the model reads — pages, files, PDFs — is sent to the model. Think twice with a hosted provider.')}`
			}
			if (tools.includes('web_fetch')) {
				return `${base} ${this.t('llmchat', 'Fetching runs on this Nextcloud server, and the page content is sent to the model.')}`
			}
			if (tools.includes('web_search')) {
				return `${base} ${this.t('llmchat', 'Search queries go to your SearXNG instance, not to this server.')}`
			}
			if (tools.includes('ask_user')) {
				return `${base} ${this.t('llmchat', 'Questions appear in a dialog, at most five at a time. Nothing leaves your browser.')}`
			}

			return `${base} ${this.t('llmchat', 'Nothing leaves your browser with this selection.')}`
		},

		visionHint() {
			if (!this.form.vision) {
				return this.t('llmchat', 'Off: the model can read text files and extract PDF text, but images are not offered to it at all.')
			}

			return this.t('llmchat', 'Only for models that actually understand images (GPT-4o, Claude, Gemini, LLaVA, Qwen-VL and the like). Adds reading images and rendering a PDF page as one. One image per answer, up to 10 MB.')
		},

		toolRoundsPlaceholder() {
			return this.t('llmchat', 'general setting ({rounds})', { rounds: this.config.toolRounds })
		},

		toolRoundsHint() {
			if (this.form.tool_rounds === '' || this.form.tool_rounds === null) {
				return this.t('llmchat', 'Empty follows the general setting. Set a value between {min} and {max} to override it for this profile only.', { min: MIN_TOOL_ROUNDS, max: MAX_TOOL_ROUNDS })
			}

			return this.t('llmchat', 'How often the model may call tools before it has to answer. The last round always runs without tools.')
		},
	},

	watch: {
		'form.connection_id': function() {
			this.loadModels(false)
		},
	},

	created() {
		this.form = emptyForm(this.config.connections[0]?.id ?? null)
	},

	methods: {
		connectionName(id) {
			return this.config.connectionById(id)?.name ?? this.t('llmchat', 'unknown connection')
		},

		/**
		 * Spec §7.4: pull the list, cache it, offer a manual refresh. Typing a
		 * model name is still allowed as a fallback, but it is not the default
		 * path.
		 *
		 * @param {boolean} force skip the cache
		 */
		async loadModels(force) {
			const connection = this.config.connectionById(this.form.connection_id)
			if (!connection) {
				this.models = []
				return
			}

			this.modelError = null

			if (!force) {
				const cached = await getCachedModels(connection.id)
				if (cached?.models?.length) {
					this.models = cached.models
					return
				}
			}

			this.loadingModels = true
			try {
				const models = await fetchModels(connection)
				this.models = models
				await cacheModels(connection.id, models)
			} catch (error) {
				this.models = []
				this.modelError = error.message
			} finally {
				this.loadingModels = false
			}
		},

		edit(profile) {
			this.form = {
				...profile,
				system_prompt: profile.system_prompt ?? '',
				temperature: profile.temperature ?? '',
				max_tokens: profile.max_tokens ?? '',
				// profiles created before the reasoning column existed have no
				// value here, and `undefined` would leave the switch unbound
				streaming: profile.streaming ?? true,
				reasoning: profile.reasoning ?? true,
				// copied, not referenced: toggling must not mutate the store
				enabled_tools: [...(profile.enabled_tools ?? [])],
				tool_approval: profile.tool_approval ?? true,
				tool_rounds: profile.tool_rounds ?? '',
				vision: profile.vision === true,
			}
			this.$nextTick(this.autogrow)
		},

		toggleTool(id, enabled) {
			const current = new Set(this.form.enabled_tools)
			if (enabled) {
				current.add(id)
			} else {
				current.delete(id)
			}
			this.form.enabled_tools = [...current]
		},

		reset() {
			this.form = emptyForm(this.config.connections[0]?.id ?? null)
		},

		autogrow() {
			const el = this.$refs.systemPrompt
			if (!el) {
				return
			}

			el.style.height = 'auto'
			el.style.height = `${Math.min(el.scrollHeight, 400)}px`
		},

		async save() {
			this.saving = true

			try {
				const payload = {
					name: this.form.name.trim(),
					connection_id: this.form.connection_id,
					model: this.form.model.trim(),
					system_prompt: this.form.system_prompt.trim() || null,
					temperature: this.form.temperature === '' ? null : Number(this.form.temperature),
					max_tokens: this.form.max_tokens === '' ? null : Number(this.form.max_tokens),
					streaming: this.form.streaming,
					reasoning: this.form.reasoning,
					enabled_tools: this.form.enabled_tools,
					tool_approval: this.form.tool_approval,
					tool_rounds: this.form.tool_rounds === '' || this.form.tool_rounds === null
						? null
						: Number(this.form.tool_rounds),

					vision: this.form.vision,
				}

				if (this.form.id) {
					await this.config.updateProfile(this.form.id, payload)
				} else {
					await this.config.createProfile(payload)
				}

				showSuccess(this.t('llmchat', 'Profile saved'))
				this.reset()
			} catch (error) {
				showError(error.message)
			} finally {
				this.saving = false
			}
		},

		/**
		 * Spec §3.3: the copy opens in the form right away with the name
		 * preselected, because renaming is the whole point of duplicating.
		 *
		 * @param {object} profile source profile
		 */
		async duplicate(profile) {
			try {
				const copy = await this.config.duplicateProfile(profile.id)
				this.edit(copy)
				this.$nextTick(() => {
					const input = this.$el.querySelector('.form input[type="text"]')
					input?.focus()
					input?.select()
				})
			} catch (error) {
				showError(error.message)
			}
		},

		async makeDefault(profile) {
			try {
				await this.config.updateProfile(profile.id, { is_default: true })
				await this.config.saveSettings({ default_profile_id: profile.id })
			} catch (error) {
				showError(error.message)
			}
		},

		async remove(profile) {
			if (!window.confirm(this.t('llmchat', 'Delete profile "{name}"?', { name: profile.name }))) {
				return
			}

			try {
				await this.config.deleteProfile(profile.id)
				if (this.form.id === profile.id) {
					this.reset()
				}
			} catch (error) {
				showError(error.message)
			}
		},

		async drop(targetIndex) {
			if (this.dragIndex === null || this.dragIndex === targetIndex) {
				return
			}

			const ordered = [...this.config.sortedProfiles]
			const [moved] = ordered.splice(this.dragIndex, 1)
			ordered.splice(targetIndex, 0, moved)
			this.dragIndex = null

			try {
				await this.config.reorderProfiles(ordered.map((p) => p.id))
			} catch (error) {
				showError(error.message)
			}
		},

		/**
		 * Spec §3.4: export never contains the api key or anything identifying
		 * the connection — profiles are meant to be passed around.
		 *
		 * @param {Array} profiles profiles to export
		 * @param {string} filename download name
		 */
		download(profiles, filename) {
			const payload = {
				version: 1,
				profiles: profiles.map((p) => ({
					name: p.name,
					model: p.model,
					system_prompt: p.system_prompt,
					temperature: p.temperature,
					max_tokens: p.max_tokens,
					streaming: p.streaming,
					reasoning: p.reasoning,
					enabled_tools: p.enabled_tools,
					tool_approval: p.tool_approval,
					tool_rounds: p.tool_rounds ?? null,
					vision: p.vision === true,
				})),
			}

			const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
			const url = URL.createObjectURL(blob)
			const link = document.createElement('a')
			link.href = url
			link.download = filename
			link.click()
			URL.revokeObjectURL(url)
		},

		exportOne(profile) {
			this.download([profile], `${profile.name.replace(/[^\w-]+/g, '-')}.json`)
		},

		exportAll() {
			this.download(this.config.sortedProfiles, 'llm-profiles.json')
		},

		async importFile(event) {
			const file = event.target.files?.[0]
			event.target.value = ''
			if (!file) {
				return
			}

			try {
				const payload = JSON.parse(await file.text())
				const profiles = Array.isArray(payload) ? payload : payload.profiles

				if (!Array.isArray(profiles) || profiles.length === 0) {
					throw new Error(this.t('llmchat', 'No profiles found in the file.'))
				}

				// the file carries no credentials, so the target connection has
				// to be chosen here
				const connectionId = this.form.connection_id ?? this.config.connections[0]?.id
				if (!connectionId) {
					throw new Error(this.t('llmchat', 'Create a connection first.'))
				}

				const name = this.connectionName(connectionId)
				if (!window.confirm(this.t('llmchat', 'Import {count} profiles and assign them to "{connection}"?', { count: profiles.length, connection: name }))) {
					return
				}

				await this.config.importProfiles(profiles, connectionId)
				showSuccess(this.t('llmchat', 'Profiles imported'))
			} catch (error) {
				showError(error.message)
			}
		},
	},
}
</script>

<style scoped>
.tab {
	display: flex;
	flex-direction: column;
	gap: 16px;
}

.tab__list {
	display: flex;
	flex-direction: column;
	gap: 2px;
	list-style: none;
	margin: 0;
	padding: 0;
}

.tab__io {
	display: flex;
	gap: 6px;
}

.tab__file {
	display: none;
}

.row {
	display: flex;
	align-items: center;
	gap: 8px;
	padding: 4px 8px;
	border-radius: var(--border-radius);
}

.row:hover {
	background-color: var(--color-background-hover);
}

.row--active {
	background-color: var(--color-primary-element-light);
}

.row__handle {
	cursor: grab;
	color: var(--color-text-maxcontrast);
}

.row__main {
	display: flex;
	flex-direction: column;
	flex: 1 1 auto;
	min-width: 0;
}

.row__sub {
	color: var(--color-text-maxcontrast);
	font-size: 0.85em;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.row__badge {
	padding: 1px 8px;
	border-radius: var(--border-radius-pill);
	background-color: var(--color-primary-element);
	color: var(--color-primary-element-text);
	font-size: 0.78em;
}

.form {
	display: flex;
	flex-direction: column;
	gap: 10px;
	padding-top: 12px;
	border-top: 1px solid var(--color-border);
}

.form__title {
	margin: 0;
	font-size: 1.05em;
}

.form__label {
	font-size: 0.85em;
	color: var(--color-text-maxcontrast);
}

.form__hint {
	margin: -4px 0 0;
	font-size: 0.85em;
	color: var(--color-text-maxcontrast);
}

.form__prompt {
	width: 100%;
	min-height: 80px;
	font-family: var(--font-face-monospace, monospace);
	font-size: 0.9em;
	resize: vertical;
}

.form__model {
	display: flex;
	align-items: flex-end;
	gap: 6px;
}

.form__model-select {
	flex: 1 1 auto;
}

.form__grid {
	display: grid;
	grid-template-columns: 1fr 1fr;
	gap: 10px;
}

.form__actions {
	display: flex;
	gap: 6px;
}
</style>
