<template>
	<!--
		Issue #11. External MCP servers only — Nextcloud itself is covered by
		the built-in tools and stays that way. Every request goes through this
		Nextcloud (the servers send no CORS headers), which is also why no
		token ever comes back to this page.
	-->
	<div class="tab">
		<div class="tab__list">
			<div
				v-for="server in config.mcpServers"
				:key="server.id"
				class="row"
				:class="{ 'row--active': form.id === server.id, 'row--off': !server.enabled }">
				<div class="row__main">
					<strong>{{ server.name }}</strong>
					<span class="row__sub">{{ server.url }}</span>
					<span v-if="server.last_error" class="row__error">{{ server.last_error }}</span>
				</div>

				<span class="row__badge" :class="`row__badge--${badge(server).tone}`">{{ badge(server).label }}</span>

				<NcButton
					v-if="server.auth_type === 'oauth'"
					:disabled="busyId === server.id"
					@click="connect(server)">
					{{ server.has_token ? t('llmchat', 'Reconnect') : t('llmchat', 'Connect') }}
				</NcButton>
				<NcButton
					:disabled="busyId === server.id || !server.enabled"
					@click="test(server)">
					{{ t('llmchat', 'Test') }}
				</NcButton>

				<NcActions>
					<NcActionButton @click="edit(server)">
						<template #icon>
							<Pencil :size="20" />
						</template>
						{{ t('llmchat', 'Edit') }}
					</NcActionButton>
					<NcActionButton v-if="server.auth_type === 'oauth' && server.has_token" @click="disconnect(server)">
						<template #icon>
							<LinkOff :size="20" />
						</template>
						{{ t('llmchat', 'Sign out') }}
					</NcActionButton>
					<NcActionButton @click="remove(server)">
						<template #icon>
							<Delete :size="20" />
						</template>
						{{ t('llmchat', 'Delete') }}
					</NcActionButton>
				</NcActions>
			</div>

			<NcEmptyContent
				v-if="config.mcpServers.length === 0"
				:name="t('llmchat', 'No MCP servers yet')"
				:description="t('llmchat', 'Connect external services that speak the Model Context Protocol. Their tools become available to profiles with MCP switched on.')" />
		</div>

		<NcNoteCard v-if="testResult" :type="testResult.ok ? 'success' : 'error'">
			<p>{{ testResult.message }}</p>
			<ul v-if="testResult.tools?.length" class="tools">
				<li v-for="tool in testResult.tools" :key="tool.name">
					<code>{{ tool.name }}</code>
					<span v-if="tool.description" class="tools__desc">{{ short(tool.description) }}</span>
				</li>
			</ul>
		</NcNoteCard>

		<form class="form" @submit.prevent="save">
			<h3 class="form__title">
				{{ form.id ? t('llmchat', 'Edit MCP server') : t('llmchat', 'New MCP server') }}
			</h3>

			<NcTextField
				v-model="form.name"
				:label="t('llmchat', 'Name')"
				placeholder="maps" />

			<NcTextField
				v-model="form.url"
				:label="t('llmchat', 'URL')"
				placeholder="https://mcp.example.org/mcp"
				:helperText="t('llmchat', 'Streamable HTTP endpoint. stdio servers and the old SSE transport are not supported.')" />

			<NcSelect
				v-model="authOption"
				:inputLabel="t('llmchat', 'Authentication')"
				:options="authOptions"
				:clearable="false"
				label="label" />

			<template v-if="form.auth_type === 'bearer'">
				<NcTextField
					v-model="form.token"
					type="password"
					:label="t('llmchat', 'Token')"
					:placeholder="form.has_token ? t('llmchat', 'unchanged') : t('llmchat', 'personal access token')" />
				<p class="form__hint">
					{{ t('llmchat', 'Sent as an "Authorization: Bearer" header. Stored encrypted and never sent back to the browser.') }}
				</p>
			</template>

			<template v-if="form.auth_type === 'oauth'">
				<p class="form__hint">
					{{ t('llmchat', 'Save, then press Connect: a window opens where you sign in with the provider. Most servers register this app on their own; if yours does not, register it there and enter the client id below.') }}
				</p>
				<NcTextField
					v-model="form.client_id"
					:label="t('llmchat', 'Client ID (optional)')"
					:placeholder="t('llmchat', 'empty = register automatically')" />
				<NcTextField
					v-model="form.client_secret"
					type="password"
					:label="t('llmchat', 'Client secret (optional)')"
					:placeholder="form.has_client_secret ? t('llmchat', 'unchanged') : ''" />
				<p class="form__hint">
					{{ t('llmchat', 'Redirect URI for a manual registration:') }}
					<code class="form__code">{{ redirectUri }}</code>
				</p>
			</template>

			<NcCheckboxRadioSwitch v-model="form.enabled" type="switch">
				{{ t('llmchat', 'Enabled') }}
			</NcCheckboxRadioSwitch>

			<p class="form__hint">
				{{ t('llmchat', 'Tool arguments are sent to this server through your Nextcloud, and its answers go to the model. Every call asks for your approval first, whatever the profile says.') }}
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
import { generateUrl } from '@nextcloud/router'
import NcActionButton from '@nextcloud/vue/components/NcActionButton'
import NcActions from '@nextcloud/vue/components/NcActions'
import NcButton from '@nextcloud/vue/components/NcButton'
import NcCheckboxRadioSwitch from '@nextcloud/vue/components/NcCheckboxRadioSwitch'
import NcEmptyContent from '@nextcloud/vue/components/NcEmptyContent'
import NcNoteCard from '@nextcloud/vue/components/NcNoteCard'
import NcSelect from '@nextcloud/vue/components/NcSelect'
import NcTextField from '@nextcloud/vue/components/NcTextField'
import Delete from 'vue-material-design-icons/Delete.vue'
import LinkOff from 'vue-material-design-icons/LinkOff.vue'
import Pencil from 'vue-material-design-icons/Pencil.vue'
import { listTools, McpAuthRequired } from '../services/mcp.js'
import { useConfigStore } from '../store/config.js'

function emptyForm() {
	return {
		id: null,
		name: '',
		url: '',
		auth_type: 'none',
		enabled: true,
		token: '',
		client_id: '',
		client_secret: '',
		has_token: false,
		has_client_secret: false,
	}
}

export default {
	name: 'McpTab',

	components: {
		Delete,
		LinkOff,
		NcActionButton,
		NcActions,
		NcButton,
		NcCheckboxRadioSwitch,
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
			busyId: null,
			testResult: null,
			authOptions: [
				{ id: 'none', label: this.t('llmchat', 'None') },
				{ id: 'bearer', label: this.t('llmchat', 'Token (PAT)') },
				{ id: 'oauth', label: this.t('llmchat', 'OAuth') },
			],
		}
	},

	computed: {
		authOption: {
			get() {
				return this.authOptions.find((o) => o.id === this.form.auth_type)
			},

			set(option) {
				this.form.auth_type = option?.id ?? 'none'
			},
		},

		canSubmit() {
			return this.form.name.trim() !== '' && this.form.url.trim() !== ''
		},

		redirectUri() {
			return `${window.location.origin}${generateUrl('/apps/llmchat/oauth/callback')}`
		},
	},

	mounted() {
		this.config.watchMcpSignIn((result) => {
			const server = this.config.mcpServerById(result.server_id)
			if (result.ok) {
				showSuccess(this.t('llmchat', 'Connected to {name}', { name: server?.name ?? '' }))
			} else {
				showError(this.t('llmchat', 'Sign-in failed: {message}', { message: result.message }))
			}
		})
		// no BroadcastChannel, or the popup was closed by hand: coming back
		// to the tab is a good moment to look again
		window.addEventListener('focus', this.refresh)
	},

	beforeUnmount() {
		this.config.watchMcpSignIn(null)
		window.removeEventListener('focus', this.refresh)
	},

	methods: {
		badge(server) {
			if (!server.enabled) {
				return { label: this.t('llmchat', 'off'), tone: 'muted' }
			}
			if (server.last_error) {
				return { label: this.t('llmchat', 'error'), tone: 'error' }
			}

			switch (server.auth_state) {
				case 'connected':
					return { label: this.t('llmchat', 'connected'), tone: 'ok' }
				case 'needs_auth':
					return { label: this.t('llmchat', 'needs sign-in'), tone: 'warn' }
				case 'needs_client_id':
					return { label: this.t('llmchat', 'needs client id'), tone: 'warn' }
				case 'needs_token':
					return { label: this.t('llmchat', 'needs token'), tone: 'warn' }
				default:
					return { label: server.auth_type === 'bearer' ? this.t('llmchat', 'token set') : this.t('llmchat', 'no auth'), tone: 'ok' }
			}
		},

		short(text) {
			const line = String(text).split('\n')[0]

			return line.length > 140 ? `${line.slice(0, 140)}…` : line
		},

		async refresh() {
			try {
				await this.config.reloadMcpServers()
			} catch {
				// nothing to add to a failed background refresh
			}
		},

		edit(server) {
			// secrets never come back, so their fields start empty and an
			// empty value means "leave it alone"
			this.form = {
				...emptyForm(),
				...server,
				client_id: server.client_id_source === 'dcr' ? '' : (server.client_id ?? ''),
				token: '',
				client_secret: '',
			}
			this.testResult = null
		},

		reset() {
			this.form = emptyForm()
		},

		async save() {
			this.saving = true

			try {
				const payload = {
					name: this.form.name.trim(),
					url: this.form.url.trim(),
					auth_type: this.form.auth_type,
					enabled: this.form.enabled,
				}
				if (this.form.auth_type === 'bearer' && this.form.token !== '') {
					payload.token = this.form.token
				}
				if (this.form.auth_type === 'oauth') {
					const before = this.config.mcpServerById(this.form.id)
					const clientId = this.form.client_id.trim()
					// a registration the server made on its own shows up
					// as an empty field — sending that back would throw
					// it away on every save
					if (!before || before.client_id_source !== 'dcr' || clientId !== '') {
						payload.client_id = clientId
					}
					if (this.form.client_secret !== '') {
						payload.client_secret = this.form.client_secret
					}
				}

				if (this.form.id) {
					await this.config.updateMcpServer(this.form.id, payload)
				} else {
					await this.config.createMcpServer(payload)
				}

				showSuccess(this.t('llmchat', 'MCP server saved'))
				this.reset()
			} catch (error) {
				showError(error.message)
			} finally {
				this.saving = false
			}
		},

		/**
		 * The popup is opened *before* the request, inside the click: a
		 * window.open after an await is no longer a user gesture, and every
		 * popup blocker knows it. The opener link is cut before it leaves
		 * for the provider — the result comes back over a BroadcastChannel.
		 *
		 * @param {object} server server to sign in to
		 */
		async connect(server) {
			const popup = window.open('', 'llmchat-mcp-oauth', 'popup,width=560,height=720')
			this.busyId = server.id

			try {
				const authUrl = await this.config.connectMcpServer(server.id)
				if (!popup || popup.closed) {
					showError(this.t('llmchat', 'The sign-in window was blocked. Allow popups for this page and try again.'))
					return
				}

				popup.opener = null
				popup.location.href = authUrl
			} catch (error) {
				popup?.close()
				showError(error.message)
				await this.refresh()
			} finally {
				this.busyId = null
			}
		},

		async disconnect(server) {
			try {
				await this.config.disconnectMcpServer(server.id)
			} catch (error) {
				showError(error.message)
			}
		},

		async test(server) {
			this.busyId = server.id
			this.testResult = null

			try {
				const { tools } = await listTools(server, { fresh: true })
				this.testResult = {
					ok: true,
					message: this.n('llmchat', '{name}: %n tool', '{name}: %n tools', tools.length, { name: server.name }),
					tools,
				}
			} catch (error) {
				this.testResult = {
					ok: false,
					message: error instanceof McpAuthRequired
						? this.t('llmchat', '{name} needs you to sign in first.', { name: server.name })
						: error.message,
				}
			} finally {
				this.busyId = null
				await this.refresh()
			}
		},

		async remove(server) {
			if (!window.confirm(this.t('llmchat', 'Delete MCP server "{name}"?', { name: server.name }))) {
				return
			}

			try {
				await this.config.deleteMcpServer(server.id)
				if (this.form.id === server.id) {
					this.reset()
				}
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

.row--off .row__main {
	opacity: 0.6;
}

.row__main {
	display: flex;
	flex-direction: column;
	flex: 1 1 auto;
	min-width: 0;
}

.row__sub,
.row__error {
	font-size: 0.85em;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.row__sub {
	color: var(--color-text-maxcontrast);
}

.row__error {
	color: var(--color-error-text, var(--color-error));
}

.row__badge {
	padding: 1px 8px;
	border-radius: var(--border-radius-pill);
	background-color: var(--color-background-dark);
	color: var(--color-text-maxcontrast);
	font-size: 0.78em;
	white-space: nowrap;
}

.row__badge--ok {
	background-color: var(--color-success);
	color: var(--color-primary-element-text, #fff);
}

.row__badge--warn {
	background-color: var(--color-warning);
	color: var(--color-main-text);
}

.row__badge--error {
	background-color: var(--color-error);
	color: var(--color-primary-element-text, #fff);
}

.tools {
	margin: 6px 0 0;
	padding-inline-start: 18px;
	font-size: 0.9em;
}

.tools__desc {
	margin-inline-start: 6px;
	color: var(--color-text-maxcontrast);
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
	margin: 0;
	font-size: 0.85em;
	line-height: 1.4;
	color: var(--color-text-maxcontrast);
}

.form__code {
	overflow-wrap: anywhere;
}

.form__actions {
	display: flex;
	gap: 6px;
}
</style>
