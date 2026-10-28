<template>
	<!-- 3.0.0: one Markdown file per memory profile, chat profiles point at one -->
	<div class="tab">
		<div class="tab__list">
			<div
				v-for="entry in config.memoryProfiles"
				:key="entry.id"
				class="row"
				:class="{ 'row--active': form.id === entry.id }">
				<div class="row__main">
					<strong>{{ entry.name }}</strong>
					<span class="row__sub">{{ entry.path }}</span>
				</div>
				<span class="row__badge" :title="t('llmchat', 'Current size / limit, in characters')">
					{{ sizeLabel(entry) }}
				</span>
				<span v-if="!entry.recap_enabled" class="row__badge">{{ t('llmchat', 'read-only') }}</span>
				<span v-if="entry.auto_compact" class="row__badge">{{ t('llmchat', 'autocompact') }}</span>

				<NcButton
					variant="tertiary"
					:href="fileUrl(entry)"
					target="_blank"
					:aria-label="t('llmchat', 'Open file')"
					:title="t('llmchat', 'Open file')">
					<template #icon>
						<FileDocumentOutline :size="20" />
					</template>
				</NcButton>
				<NcButton
					variant="tertiary"
					:disabled="memory.compacting[entry.id]"
					:aria-label="t('llmchat', 'Compact now')"
					:title="t('llmchat', 'Compact now — merge duplicates, drop outdated facts')"
					@click="compact(entry)">
					<template #icon>
						<ArrowCollapseVertical :size="20" />
					</template>
				</NcButton>
				<NcButton
					v-if="memory.canUndo(entry.id)"
					variant="tertiary"
					:aria-label="t('llmchat', 'Undo last change')"
					:title="t('llmchat', 'Undo the last change made in this session')"
					@click="undo(entry)">
					<template #icon>
						<Undo :size="20" />
					</template>
				</NcButton>
				<NcButton variant="tertiary" :aria-label="t('llmchat', 'Edit')" @click="edit(entry)">
					<template #icon>
						<Pencil :size="20" />
					</template>
				</NcButton>
				<NcButton variant="tertiary" :aria-label="t('llmchat', 'Delete')" @click="remove(entry)">
					<template #icon>
						<Delete :size="20" />
					</template>
				</NcButton>
			</div>

			<NcEmptyContent
				v-if="config.memoryProfiles.length === 0"
				:name="t('llmchat', 'No memory yet')"
				:description="t('llmchat', 'A memory is a Markdown file in your Nextcloud. Profiles that use it read it at the start of a chat, and a short recap after each answer keeps it up to date.')" />
		</div>

		<form class="form" @submit.prevent="save">
			<h3 class="form__title">
				{{ form.id ? t('llmchat', 'Edit memory') : t('llmchat', 'New memory') }}
			</h3>

			<NcTextField
				v-model="form.name"
				:label="t('llmchat', 'Name')"
				placeholder="private" />

			<NcTextField
				v-model="form.path"
				:label="t('llmchat', 'File')"
				:placeholder="defaultPath"
				:helperText="t('llmchat', 'Relative to your home. Empty uses the default. An existing file is used as it is, several memories may share one. A file in a folder shared with you can be edited by others — and ends up in your system prompt.')" />

			<NcTextField
				v-model="form.max_chars"
				type="number"
				min="1000"
				max="100000"
				step="1000"
				:label="t('llmchat', 'Maximum size in characters')"
				:helperText="t('llmchat', '≈ {tokens} tokens in every system prompt', { tokens: approxTokens })" />

			<NcCheckboxRadioSwitch v-model="form.recap_enabled" type="switch">
				{{ t('llmchat', 'Recap after each answer') }}
			</NcCheckboxRadioSwitch>
			<p class="form__hint">
				{{ t('llmchat', 'One extra model call per answer. It sees your message and the final answer — never tool results — and only stores what you said yourself. Off: the file is only read, you maintain it by hand.') }}
			</p>

			<NcSelect
				v-if="form.recap_enabled"
				v-model="recapOption"
				:inputLabel="t('llmchat', 'Recap and compact with')"
				:options="recapOptions"
				:clearable="false"
				label="label" />

			<NcCheckboxRadioSwitch v-model="form.auto_compact" type="switch">
				{{ t('llmchat', 'Compact automatically') }}
			</NcCheckboxRadioSwitch>
			<NcTextField
				v-model="form.compact_threshold"
				type="number"
				min="50"
				max="100"
				:label="t('llmchat', 'Compact at % of the maximum size')" />
			<p class="form__hint">
				{{ form.auto_compact
					? t('llmchat', 'Over the threshold the file is rewritten shorter right away. The previous version stays in the file versions.')
					: t('llmchat', 'Over the threshold the chat asks first.') }}
			</p>

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
import NcButton from '@nextcloud/vue/components/NcButton'
import NcCheckboxRadioSwitch from '@nextcloud/vue/components/NcCheckboxRadioSwitch'
import NcEmptyContent from '@nextcloud/vue/components/NcEmptyContent'
import NcSelect from '@nextcloud/vue/components/NcSelect'
import NcTextField from '@nextcloud/vue/components/NcTextField'
import ArrowCollapseVertical from 'vue-material-design-icons/ArrowCollapseVertical.vue'
import Delete from 'vue-material-design-icons/Delete.vue'
import FileDocumentOutline from 'vue-material-design-icons/FileDocumentOutline.vue'
import Pencil from 'vue-material-design-icons/Pencil.vue'
import Undo from 'vue-material-design-icons/Undo.vue'
import { filesAppUrl } from '../services/nextcloud.js'
import { useConfigStore } from '../store/config.js'
import { kilo, useMemoryStore } from '../store/memory.js'

function emptyForm() {
	return {
		id: null,
		name: '',
		path: '',
		max_chars: 12000,
		recap_enabled: true,
		recap_profile_id: null,
		auto_compact: false,
		compact_threshold: 80,
	}
}

export default {
	name: 'MemoryTab',

	components: {
		ArrowCollapseVertical,
		Delete,
		FileDocumentOutline,
		NcButton,
		NcCheckboxRadioSwitch,
		NcEmptyContent,
		NcSelect,
		NcTextField,
		Pencil,
		Undo,
	},

	setup() {
		return {
			config: useConfigStore(),
			memory: useMemoryStore(),
		}
	},

	data() {
		return {
			form: emptyForm(),
			saving: false,
		}
	},

	computed: {
		recapOptions() {
			return [
				{ id: null, label: this.t('llmchat', 'Same as the chat profile') },
				...this.config.usableProfiles.map((p) => ({ id: p.id, label: `${p.name} — ${p.model}` })),
			]
		},

		recapOption: {
			get() {
				return this.recapOptions.find((o) => o.id === this.form.recap_profile_id) ?? this.recapOptions[0]
			},

			set(option) {
				this.form.recap_profile_id = option?.id ?? null
			},
		},

		/** mirrors MemoryProfileService::normalizePath() for the placeholder */
		defaultPath() {
			const slug = (this.form.name || 'memory')
				.toLowerCase()
				.replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
				.replace(/[^a-z0-9]+/g, '-')
				.replace(/^-+|-+$/g, '')

			return `LLM Memory/${slug || 'memory'}.md`
		},

		approxTokens() {
			return kilo(Math.round(Number(this.form.max_chars || 0) / 4))
		},

		canSubmit() {
			return this.form.name.trim() !== ''
		},
	},

	mounted() {
		// the sizes in the list; failures just leave a question mark
		this.config.memoryProfiles.forEach((entry) => {
			this.memory.read(entry).catch(() => {})
		})
	},

	methods: {
		sizeLabel(entry) {
			const size = this.memory.sizes[entry.id]

			return `${size === undefined ? '?' : kilo(size)} / ${kilo(entry.max_chars)}`
		},

		fileUrl(entry) {
			return filesAppUrl(entry.path)
		},

		edit(entry) {
			this.form = { ...entry }
		},

		reset() {
			this.form = emptyForm()
		},

		async save() {
			this.saving = true

			try {
				const payload = {
					name: this.form.name.trim(),
					path: this.form.path.trim(),
					max_chars: Number(this.form.max_chars) || 12000,
					recap_enabled: this.form.recap_enabled,
					recap_profile_id: this.form.recap_profile_id,
					auto_compact: this.form.auto_compact,
					compact_threshold: Number(this.form.compact_threshold) || 80,
				}

				const saved = this.form.id
					? await this.config.updateMemoryProfile(this.form.id, payload)
					: await this.config.createMemoryProfile(payload)

				// the path may have changed, or the file just been created
				this.memory.read(saved).catch(() => {})

				showSuccess(this.t('llmchat', 'Memory saved'))
				this.reset()
			} catch (error) {
				showError(error.message)
			} finally {
				this.saving = false
			}
		},

		compact(entry) {
			this.memory.compactNow(entry, null)
		},

		undo(entry) {
			this.memory.undo(entry)
		},

		async remove(entry) {
			if (!window.confirm(this.t('llmchat', 'Delete the memory "{name}"? The file {path} stays in your Nextcloud.', { name: entry.name, path: entry.path }))) {
				return
			}

			try {
				await this.config.deleteMemoryProfile(entry.id)
				if (this.form.id === entry.id) {
					this.reset()
				}
			} catch (error) {
				// blocked while profiles still use it
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
	background-color: var(--color-background-dark);
	color: var(--color-text-maxcontrast);
	font-size: 0.78em;
	white-space: nowrap;
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

.form__hint {
	margin: -4px 0 0;
	font-size: 0.85em;
	color: var(--color-text-maxcontrast);
}

.form__actions {
	display: flex;
	gap: 6px;
}
</style>
