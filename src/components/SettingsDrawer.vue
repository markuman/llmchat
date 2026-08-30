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
	},

	created() {
		this.archiveFolder = this.config.settings.archive_folder
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
