<template>
	<!--
		Spec §4.1: deliberately not registered in Nextcloud's settings framework.
		A cog in the navigation footer, like the Mail app, with nothing but
		toggles and one button.
	-->
	<NcAppNavigationSettings :name="t('llmchat', 'Settings')">
		<div class="drawer">
			<NcSelect
				v-if="config.hasProfiles"
				v-model="defaultProfile"
				:input-label="t('llmchat', 'Default profile')"
				:options="profileOptions"
				:clearable="false"
				label="label" />

			<div class="drawer__field">
				<label class="drawer__label" for="llm-archive-folder">
					{{ t('llmchat', 'Archive folder') }}
				</label>
				<div class="drawer__row">
					<input
						id="llm-archive-folder"
						v-model="archiveFolder"
						type="text"
						class="drawer__input"
						@blur="saveFolder">
					<NcButton
						:aria-label="t('llmchat', 'Pick folder')"
						variant="tertiary"
						@click="pickFolder">
						<template #icon>
							<Folder :size="20" />
						</template>
					</NcButton>
				</div>
			</div>

			<NcCheckboxRadioSwitch
				:model-value="config.settings.compact_mode"
				type="switch"
				@update:model-value="save('compact_mode', $event)">
				{{ t('llmchat', 'Compact mode') }}
			</NcCheckboxRadioSwitch>

			<NcCheckboxRadioSwitch
				:model-value="config.settings.markdown_rendering"
				type="switch"
				@update:model-value="save('markdown_rendering', $event)">
				{{ t('llmchat', 'Render Markdown') }}
			</NcCheckboxRadioSwitch>

			<!--
				Display only. Actually disabling thinking is a per-profile
				setting, because it changes the request sent to the backend.
			-->
			<NcCheckboxRadioSwitch
				:model-value="config.settings.show_reasoning"
				type="switch"
				@update:model-value="save('show_reasoning', $event)">
				{{ t('llmchat', 'Display reasoning blocks') }}
			</NcCheckboxRadioSwitch>
			<p class="drawer__hint">
				{{ t('llmchat', 'Display only — the tokens are still generated. Turn reasoning off in the profile to actually save them.') }}
			</p>

			<NcSelect
				v-model="searchProvider"
				:input-label="t('llmchat', 'Web search provider')"
				:options="searchProviderOptions"
				:clearable="false"
				label="label" />
			<p v-if="config.settings.search_provider === 'duckduckgo'" class="drawer__hint">
				{{ t('llmchat', 'DuckDuckGo instant answers only — needs no setup, but results are thin. A SearXNG instance gives real search results.') }}
			</p>

			<div v-if="config.settings.search_provider === 'searxng'" class="drawer__field">
				<label class="drawer__label" for="llm-searxng-url">
					{{ t('llmchat', 'SearXNG URL') }}
				</label>
				<input
					id="llm-searxng-url"
					v-model="searxngUrl"
					type="url"
					class="drawer__input"
					placeholder="https://searx.example.org"
					@blur="saveSearxngUrl">
				<p class="drawer__hint">
					{{ t('llmchat', 'The instance needs "formats: [html, json]" in its settings.yml.') }}
				</p>
			</div>

			<NcButton wide @click="$emit('open-manager')">
				<template #icon>
					<Tune :size="20" />
				</template>
				{{ t('llmchat', 'Manage connections & profiles') }}
			</NcButton>
		</div>
	</NcAppNavigationSettings>
</template>

<script>
import { getFilePickerBuilder, showError } from '@nextcloud/dialogs'
import Folder from 'vue-material-design-icons/Folder.vue'
import Tune from 'vue-material-design-icons/Tune.vue'

import NcAppNavigationSettings from '@nextcloud/vue/components/NcAppNavigationSettings'
import NcButton from '@nextcloud/vue/components/NcButton'
import NcCheckboxRadioSwitch from '@nextcloud/vue/components/NcCheckboxRadioSwitch'
import NcSelect from '@nextcloud/vue/components/NcSelect'

import { useConfigStore } from '../store/config.js'

export default {
	name: 'SettingsDrawer',

	components: {
		Folder,
		NcAppNavigationSettings,
		NcButton,
		NcCheckboxRadioSwitch,
		NcSelect,
		Tune,
	},

	emits: ['open-manager'],

	setup() {
		return { config: useConfigStore() }
	},

	data() {
		return {
			archiveFolder: this.config?.settings?.archive_folder ?? '/LLM Chats',
			searxngUrl: this.config?.settings?.searxng_url ?? '',
			searchProviderOptions: [
				{ id: 'duckduckgo', label: 'DuckDuckGo (instant answers)' },
				{ id: 'searxng', label: 'SearXNG (self-hosted)' },
			],
		}
	},

	computed: {
		profileOptions() {
			return this.config.sortedProfiles.map((p) => ({ id: p.id, label: p.name }))
		},

		defaultProfile: {
			get() {
				const current = this.config.defaultProfile
				return current ? { id: current.id, label: current.name } : null
			},
			set(option) {
				if (option?.id) {
					this.save('default_profile_id', option.id)
				}
			},
		},

		searchProvider: {
			get() {
				const current = this.config.settings.search_provider
				return this.searchProviderOptions.find((o) => o.id === current)
					?? this.searchProviderOptions[0]
			},
			set(option) {
				if (option?.id) {
					this.save('search_provider', option.id)
				}
			},
		},
	},

	created() {
		this.archiveFolder = this.config.settings.archive_folder
		this.searxngUrl = this.config.settings.searxng_url
	},

	methods: {
		async save(key, value) {
			try {
				await this.config.saveSettings({ [key]: value })
			} catch (error) {
				showError(error.message)
			}
		},

		async saveFolder() {
			const folder = this.archiveFolder.trim()
			if (folder === this.config.settings.archive_folder) {
				return
			}

			await this.save('archive_folder', folder)
			this.archiveFolder = this.config.settings.archive_folder
		},

		async saveSearxngUrl() {
			const url = this.searxngUrl.trim()
			if (url === this.config.settings.searxng_url) {
				return
			}

			await this.save('searxng_url', url)
			// the backend clears invalid urls; reflect what was actually stored
			this.searxngUrl = this.config.settings.searxng_url
			if (url !== '' && this.searxngUrl === '') {
				showError(this.t('llmchat', 'Invalid URL — must be absolute http(s).'))
			}
		},

		async pickFolder() {
			try {
				const picker = getFilePickerBuilder(this.t('llmchat', 'Choose archive folder'))
					.setMultiSelect(false)
					.addMimeTypeFilter('httpd/unix-directory')
					.allowDirectories()
					.startAt(this.config.settings.archive_folder)
					// the picker has no confirm button unless one is supplied
					.addButton({
						label: this.t('llmchat', 'Choose'),
						variant: 'primary',
						callback: () => {},
					})
					.build()

				const path = await picker.pick()
				this.archiveFolder = path || '/'
				await this.saveFolder()
			} catch {
				// picker cancelled
			}
		},
	},
}
</script>

<style scoped>
.drawer {
	display: flex;
	flex-direction: column;
	gap: 8px;
	padding: 4px 0;
}

.drawer__field {
	display: flex;
	flex-direction: column;
	gap: 2px;
}

.drawer__label {
	font-size: 0.85em;
	color: var(--color-text-maxcontrast);
}

.drawer__hint {
	margin: -4px 0 0;
	font-size: 0.8em;
	line-height: 1.35;
	color: var(--color-text-maxcontrast);
}

.drawer__row {
	display: flex;
	align-items: center;
	gap: 4px;
}

.drawer__input {
	flex: 1 1 auto;
	min-width: 0;
}
</style>
