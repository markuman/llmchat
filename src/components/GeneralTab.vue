<template>
	<!--
		Issue #2: the navigation footer used to hold these. Settings that
		change what a request looks like belong next to connections and
		profiles, not in a drawer that covers the chat list.
	-->
	<div class="tab">
		<section class="tab__section">
			<h3 class="tab__title">
				{{ t('llmchat', 'Chat') }}
			</h3>

			<NcSelect
				v-if="config.hasProfiles"
				v-model="defaultProfile"
				:inputLabel="t('llmchat', 'Default profile')"
				:options="profileOptions"
				:clearable="false"
				label="label" />
			<p class="tab__hint">
				{{ t('llmchat', 'Used for every new chat. Existing chats keep the profile they were started with.') }}
			</p>

			<NcCheckboxRadioSwitch
				:modelValue="config.settings.compact_mode"
				type="switch"
				@update:modelValue="save('compact_mode', $event)">
				{{ t('llmchat', 'Compact mode') }}
			</NcCheckboxRadioSwitch>

			<NcCheckboxRadioSwitch
				:modelValue="config.settings.markdown_rendering"
				type="switch"
				@update:modelValue="save('markdown_rendering', $event)">
				{{ t('llmchat', 'Render Markdown') }}
			</NcCheckboxRadioSwitch>

			<!--
				Display only. Actually disabling thinking is a per-profile
				setting, because it changes the request sent to the backend.
			-->
			<NcCheckboxRadioSwitch
				:modelValue="config.settings.show_reasoning"
				type="switch"
				@update:modelValue="save('show_reasoning', $event)">
				{{ t('llmchat', 'Display reasoning blocks') }}
			</NcCheckboxRadioSwitch>
			<p class="tab__hint">
				{{ t('llmchat', 'Display only — the tokens are still generated. Turn reasoning off in the profile to actually save them.') }}
			</p>
		</section>

		<section class="tab__section">
			<h3 class="tab__title">
				{{ t('llmchat', 'Tools') }}
			</h3>

			<!-- issue #3: the agent loop's budget, no longer hardcoded -->
			<label class="tab__label" for="llm-tool-rounds">
				{{ t('llmchat', 'Tool rounds per answer') }}
			</label>
			<div class="tab__slider">
				<input
					id="llm-tool-rounds"
					v-model.number="toolRounds"
					type="range"
					:min="minToolRounds"
					:max="maxToolRounds"
					step="1"
					class="tab__range"
					@change="saveToolRounds">
				<output class="tab__value" for="llm-tool-rounds">{{ toolRounds }}</output>
			</div>
			<p class="tab__hint">
				{{ t('llmchat', 'How often the model may call tools before it has to answer. Higher values let it chain a search into a page fetch, at the cost of latency and tokens. The last round always runs without tools.') }}
			</p>
			<p class="tab__hint">
				{{ t('llmchat', 'The default for every profile. A single profile can override it in its own settings.') }}
			</p>

			<!-- SearXNG is the only search backend; without a URL, web search is off -->
			<label class="tab__label" for="llm-searxng-url">
				{{ t('llmchat', 'SearXNG URL (for web search)') }}
			</label>
			<input
				id="llm-searxng-url"
				v-model="searxngUrl"
				type="url"
				class="tab__input"
				placeholder="https://searx.example.org"
				@blur="saveSearxngUrl">
			<p class="tab__hint">
				{{ searxngHint }}
			</p>
		</section>

		<section class="tab__section">
			<h3 class="tab__title">
				{{ t('llmchat', 'Archive') }}
			</h3>

			<label class="tab__label" for="llm-archive-folder">
				{{ t('llmchat', 'Archive folder') }}
			</label>
			<div class="tab__row">
				<input
					id="llm-archive-folder"
					v-model="archiveFolder"
					type="text"
					class="tab__input"
					@blur="saveFolder">
				<NcButton
					:aria-label="t('llmchat', 'Pick folder')"
					:title="t('llmchat', 'Pick folder')"
					@click="pickFolder">
					<template #icon>
						<Folder :size="20" />
					</template>
				</NcButton>
			</div>
			<p class="tab__hint">
				{{ t('llmchat', 'Archived chats are written there as Markdown files. The local copy stays in this browser.') }}
			</p>
		</section>

		<!-- issue #17 -->
		<section class="tab__section">
			<h3 class="tab__title">
				{{ t('llmchat', 'Skills') }}
			</h3>

			<NcCheckboxRadioSwitch
				:modelValue="config.settings.skills_enabled"
				:disabled="skillsBusy"
				type="switch"
				@update:modelValue="toggleSkills">
				{{ t('llmchat', 'Enable skills') }}
			</NcCheckboxRadioSwitch>
			<p class="tab__hint">
				{{ t('llmchat', 'Skills are Markdown files with instructions for a specific task — how to answer a weather question, which API to call, what the reply should look like. The model is told which ones exist and reads the one it needs.') }}
			</p>
			<p class="tab__hint">
				{{ t('llmchat', 'They live in the "{folder}" folder next to your archived chats. Switching this on creates it, together with an example skill for weather forecasts. Switching it off deletes nothing.', { folder: skillsFolder }) }}
			</p>

			<template v-if="config.settings.skills_enabled">
				<p v-if="config.skills.length === 0" class="tab__hint">
					{{ t('llmchat', 'No skills found yet.') }}
				</p>
				<ul v-else class="tab__skills">
					<li v-for="skill in config.skills" :key="skill.id" class="tab__skill">
						<span class="tab__skill-name">{{ skill.name }}</span>
						<span v-if="skill.description" class="tab__skill-desc">{{ skill.description }}</span>
						<span v-else class="tab__skill-warn">
							{{ t('llmchat', 'No description in the front matter — the model will not be offered this skill.') }}
						</span>
					</li>
				</ul>

				<div class="tab__row tab__row--start">
					<NcButton @click="refreshSkills">
						{{ t('llmchat', 'Rescan folder') }}
					</NcButton>
					<NcButton @click="openSkillsFolder">
						{{ t('llmchat', 'Open folder') }}
					</NcButton>
				</div>
				<p class="tab__hint">
					{{ t('llmchat', 'Edited a skill in Files? Rescan, then reload the page — a skill that reaches a new host needs it in the page security policy first.') }}
				</p>
			</template>
		</section>
	</div>
</template>

<script>
import { getFilePickerBuilder, showError, showSuccess } from '@nextcloud/dialogs'
import { generateUrl } from '@nextcloud/router'
import NcButton from '@nextcloud/vue/components/NcButton'
import NcCheckboxRadioSwitch from '@nextcloud/vue/components/NcCheckboxRadioSwitch'
import NcSelect from '@nextcloud/vue/components/NcSelect'
import Folder from 'vue-material-design-icons/Folder.vue'
import { SKILLS_FOLDER_NAME } from '../services/skills.js'
import { MAX_TOOL_ROUNDS, MIN_TOOL_ROUNDS, useConfigStore } from '../store/config.js'

export default {
	name: 'GeneralTab',

	components: {
		Folder,
		NcButton,
		NcCheckboxRadioSwitch,
		NcSelect,
	},

	setup() {
		return { config: useConfigStore() }
	},

	data() {
		return {
			archiveFolder: '/LLM Chats',
			searxngUrl: '',
			toolRounds: MIN_TOOL_ROUNDS,
			minToolRounds: MIN_TOOL_ROUNDS,
			maxToolRounds: MAX_TOOL_ROUNDS,
			/** guards the toggle while the folder is being created (issue #17) */
			skillsBusy: false,
		}
	},

	computed: {
		/** Where the skills live, derived from the archive folder. */
		skillsFolder() {
			const base = (this.config.settings.archive_folder || '/LLM Chats').replace(/\/+$/, '')

			return `${base}/${SKILLS_FOLDER_NAME}`
		},

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

		searxngHint() {
			return this.config.settings.searxng_url === ''
				? this.t('llmchat', 'Not set — the web search tool will report that it is unconfigured. Fetching a URL the user provides still works.')
				: this.t('llmchat', 'The instance needs "formats: [html, json]" in its settings.yml.')
		},
	},

	created() {
		this.archiveFolder = this.config.settings.archive_folder
		this.searxngUrl = this.config.settings.searxng_url
		this.toolRounds = this.config.toolRounds
	},

	methods: {
		async save(key, value) {
			try {
				await this.config.saveSettings({ [key]: value })
			} catch (error) {
				showError(error.message)
			}
		},

		async saveToolRounds() {
			if (this.toolRounds === this.config.toolRounds) {
				return
			}

			await this.save('max_tool_rounds', this.toolRounds)
			// the backend clamps; show what was actually stored
			this.toolRounds = this.config.toolRounds
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

		/**
		 * Issue #17. Switching on creates the folder and the example skill;
		 * switching off only stops offering them.
		 *
		 * @param {boolean} enabled new switch state
		 */
		async toggleSkills(enabled) {
			this.skillsBusy = true
			try {
				const result = await this.config.setSkillsEnabled(enabled)

				if (result?.example_created) {
					showSuccess(this.t('llmchat', 'Created {path} with an example skill.', {
						path: `${result.path}/weather.md`,
					}))
				}
			} catch (error) {
				showError(error.message)
			} finally {
				this.skillsBusy = false
			}
		},

		async refreshSkills() {
			try {
				await this.config.reloadSkills()
				showSuccess(this.n(
					'llmchat',
					'%n skill found.',
					'%n skills found.',
					this.config.skills.length,
				))
			} catch (error) {
				showError(error.message)
			}
		},

		openSkillsFolder() {
			window.open(
				generateUrl('/apps/files/?dir={dir}', { dir: this.skillsFolder }),
				'_blank',
				'noopener,noreferrer',
			)
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
.tab {
	display: flex;
	flex-direction: column;
	gap: 20px;
}

.tab__section {
	display: flex;
	flex-direction: column;
	gap: 4px;
	max-width: 520px;
}

.tab__title {
	margin: 0 0 4px;
	font-size: 1.05em;
}

.tab__label {
	margin-top: 8px;
	font-size: 0.9em;
	color: var(--color-text-maxcontrast);
}

.tab__hint {
	margin: 2px 0 0;
	font-size: 0.85em;
	line-height: 1.4;
	color: var(--color-text-maxcontrast);
}

.tab__row {
	display: flex;
	align-items: center;
	gap: 6px;
}

.tab__row--start {
	justify-content: flex-start;
	margin-top: 8px;
}

.tab__skills {
	margin: 8px 0 0;
	padding: 0;
	list-style: none;
	display: flex;
	flex-direction: column;
	gap: 6px;
}

.tab__skill {
	display: flex;
	flex-direction: column;
	padding: 6px 8px;
	border-radius: var(--border-radius);
	background-color: var(--color-background-hover);
	font-size: 0.85em;
}

.tab__skill-name {
	font-weight: 600;
}

.tab__skill-desc {
	color: var(--color-text-maxcontrast);
	line-height: 1.4;
}

.tab__skill-warn {
	color: var(--color-warning-text, var(--color-warning));
	line-height: 1.4;
}

.tab__input {
	flex: 1 1 auto;
	min-width: 0;
	width: 100%;
}

.tab__slider {
	display: flex;
	align-items: center;
	gap: 12px;
}

.tab__range {
	flex: 1 1 auto;
	min-width: 0;
}

.tab__value {
	min-width: 2ch;
	font-weight: 600;
	text-align: end;
}
</style>
