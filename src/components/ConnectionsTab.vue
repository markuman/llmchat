<template>
	<div class="tab">
		<div class="tab__list">
			<div
				v-for="connection in config.connections"
				:key="connection.id"
				class="row"
				:class="{ 'row--active': form.id === connection.id }">
				<div class="row__main">
					<strong>{{ connection.name }}</strong>
					<span class="row__sub">{{ connection.base_url }}</span>
				</div>
				<span class="row__badge">{{ providerLabel(connection.provider_hint) }}</span>
				<span v-if="connection.has_key" class="row__badge">{{ t('llmchat', 'key set') }}</span>

				<NcButton variant="tertiary" :aria-label="t('llmchat', 'Edit')" @click="edit(connection)">
					<template #icon>
						<Pencil :size="20" />
					</template>
				</NcButton>
				<NcButton variant="tertiary" :aria-label="t('llmchat', 'Delete')" @click="remove(connection)">
					<template #icon>
						<Delete :size="20" />
					</template>
				</NcButton>
			</div>

			<NcEmptyContent
				v-if="!config.hasConnections"
				:name="t('llmchat', 'No connections yet')"
				:description="t('llmchat', 'Add the address of your Ollama instance or an OpenAI-compatible API.')" />
		</div>

		<form class="form" @submit.prevent="save">
			<h3 class="form__title">
				{{ form.id ? t('llmchat', 'Edit connection') : t('llmchat', 'New connection') }}
			</h3>

			<NcTextField
				v-model="form.name"
				:label="t('llmchat', 'Name')"
				placeholder="ollama laptop" />

			<NcTextField
				v-model="form.base_url"
				:label="t('llmchat', 'Base URL')"
				placeholder="http://127.0.0.1:11434/v1"
				:helper-text="t('llmchat', 'The connection is activated after the page reloads.')" />

			<NcTextField
				v-model="form.api_key"
				type="password"
				:label="t('llmchat', 'API key')"
				:placeholder="form.has_key ? t('llmchat', 'unchanged') : t('llmchat', 'empty for Ollama')" />

			<NcSelect
				v-model="providerOption"
				:input-label="t('llmchat', 'Provider')"
				:options="providerOptions"
				:clearable="false"
				label="label" />

			<NcNoteCard v-if="testResult" :type="testResult.ok ? 'success' : 'error'">
				{{ testResult.message }}
			</NcNoteCard>

			<div class="form__actions">
				<NcButton :disabled="!canSubmit || saving" variant="primary" type="submit">
					{{ form.id ? t('llmchat', 'Save') : t('llmchat', 'Create') }}
				</NcButton>
				<NcButton :disabled="!canTest || testing" @click="test">
					{{ testing ? t('llmchat', 'Testing…') : t('llmchat', 'Test connection') }}
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
import Delete from 'vue-material-design-icons/Delete.vue'
import Pencil from 'vue-material-design-icons/Pencil.vue'

import NcButton from '@nextcloud/vue/components/NcButton'
import NcEmptyContent from '@nextcloud/vue/components/NcEmptyContent'
import NcNoteCard from '@nextcloud/vue/components/NcNoteCard'
import NcSelect from '@nextcloud/vue/components/NcSelect'
import NcTextField from '@nextcloud/vue/components/NcTextField'

import { dropCachedModels } from '../services/db.js'
import { testConnection } from '../services/llm.js'
import { useConfigStore } from '../store/config.js'

function emptyForm() {
	return {
		id: null,
		name: '',
		base_url: '',
		api_key: '',
		provider_hint: 'openai_compatible',
		has_key: false,
	}
}

export default {
	name: 'ConnectionsTab',

	components: {
		Delete,
		NcButton,
		NcEmptyContent,
		NcNoteCard,
		NcSelect,
		NcTextField,
		Pencil,
	},

	setup() {
		return { config: useConfigStore() }
	},

	data() {
		return {
			form: emptyForm(),
			saving: false,
			testing: false,
			testResult: null,
			providerOptions: [
				{ id: 'ollama', label: 'Ollama' },
				{ id: 'openai_compatible', label: 'OpenAI-compatible' },
				{ id: 'openrouter', label: 'OpenRouter' },
			],
		}
	},

	computed: {
		providerOption: {
			get() {
				return this.providerOptions.find((o) => o.id === this.form.provider_hint)
			},
			set(option) {
				this.form.provider_hint = option?.id ?? 'openai_compatible'
			},
		},

		canSubmit() {
			return this.form.name.trim() !== '' && this.form.base_url.trim() !== ''
		},

		canTest() {
			return this.form.base_url.trim() !== ''
		},
	},

	methods: {
		providerLabel(hint) {
			return this.providerOptions.find((o) => o.id === hint)?.label ?? hint
		},

		edit(connection) {
			// the api key is never returned, so the field starts empty and an
			// empty value means "leave it alone" (spec §4.2)
			this.form = { ...connection, api_key: '' }
			this.testResult = null
		},

		reset() {
			this.form = emptyForm()
			this.testResult = null
		},

		/**
		 * Spec §7.3: tests against the values in the form, not the stored ones,
		 * so a key can be verified before saving it.
		 */
		async test() {
			this.testing = true
			this.testResult = null

			try {
				const candidate = {
					base_url: this.form.base_url.trim(),
					provider_hint: this.form.provider_hint,
					api_key: this.form.api_key || this.storedKey(),
				}

				// a brand-new host is not in the running page's CSP yet
				if (!this.form.id && !this.config.cspBaseUrls.includes(candidate.base_url)) {
					this.testResult = {
						ok: false,
						message: this.t('llmchat', 'This address is not allowed by the page yet. Save the connection and reload, then test again.'),
					}
					return
				}

				this.testResult = await testConnection(candidate)
			} finally {
				this.testing = false
			}
		},

		storedKey() {
			return this.config.connectionById(this.form.id)?.api_key ?? ''
		},

		async save() {
			this.saving = true

			try {
				const payload = {
					name: this.form.name.trim(),
					base_url: this.form.base_url.trim(),
					provider_hint: this.form.provider_hint,
				}

				// only send a key when the user actually typed one
				if (this.form.api_key !== '') {
					payload.api_key = this.form.api_key
				}

				if (this.form.id) {
					await this.config.updateConnection(this.form.id, payload)
					await dropCachedModels(this.form.id)
				} else {
					await this.config.createConnection(payload)
				}

				showSuccess(this.t('llmchat', 'Connection saved'))
				this.reset()
			} catch (error) {
				showError(error.message)
			} finally {
				this.saving = false
			}
		},

		async remove(connection) {
			if (!window.confirm(this.t('llmchat', 'Delete connection "{name}"?', { name: connection.name }))) {
				return
			}

			try {
				await this.config.deleteConnection(connection.id)
				await dropCachedModels(connection.id)
				if (this.form.id === connection.id) {
					this.reset()
				}
			} catch (error) {
				// the backend blocks deletion while profiles still reference it
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

.form__actions {
	display: flex;
	gap: 6px;
}
</style>
