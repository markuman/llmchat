/**
 * Connections, profiles and user settings.
 *
 * Seeded from the initial state (spec §9) so the profile switcher does not
 * flicker on load; mutations go through the API and update in place.
 */

import { loadState } from '@nextcloud/initial-state'
import { defineStore } from 'pinia'
import { api } from '../services/api.js'

function safeState(key, fallback) {
	try {
		return loadState('llmchat', key, fallback)
	} catch {
		return fallback
	}
}

export const useConfigStore = defineStore('config', {
	state: () => ({
		connections: safeState('connections', []),
		profiles: safeState('profiles', []),
		settings: safeState('settings', {
			archive_folder: '/LLM Chats',
			archive_target: 'files',
			compact_mode: false,
			markdown_rendering: true,
			show_reasoning: true,
			default_profile_id: null,
			searxng_url: '',
		}),
		/**
		 * Urls known to the CSP of the *currently loaded page* — connections
		 * plus the SearXNG instance, since the browser talks to both directly.
		 * Anything added later needs a reload before it can be reached
		 * (spec §7.1).
		 */
		cspBaseUrls: [
			...safeState('connections', []).map((c) => c.base_url),
			safeState('settings', {}).searxng_url,
		].filter(Boolean),
		reloadRequired: false,
	}),

	getters: {
		hasConnections: (state) => state.connections.length > 0,
		hasProfiles: (state) => state.profiles.length > 0,

		sortedProfiles: (state) =>
			[...state.profiles].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)),

		connectionById: (state) => (id) =>
			state.connections.find((c) => c.id === id) ?? null,

		profileById: (state) => (id) =>
			state.profiles.find((p) => p.id === id) ?? null,

		defaultProfile(state) {
			const configured = state.settings.default_profile_id
			if (configured) {
				const match = state.profiles.find((p) => p.id === configured)
				if (match) {
					return match
				}
			}

			return state.profiles.find((p) => p.is_default) ?? this.sortedProfiles[0] ?? null
		},

		/** Profiles whose connection still exists — anything else cannot be used. */
		usableProfiles(state) {
			return this.sortedProfiles.filter((p) =>
				state.connections.some((c) => c.id === p.connection_id))
		},
	},

	actions: {
		async reloadConnections() {
			this.connections = await api.listConnections()
		},

		async reloadProfiles() {
			this.profiles = await api.listProfiles()
		},

		markCspStale(baseUrl) {
			if (baseUrl && !this.cspBaseUrls.includes(baseUrl)) {
				this.reloadRequired = true
			}
		},

		async createConnection(payload) {
			await api.createConnection(payload)
			await this.reloadConnections()
			this.markCspStale(payload.base_url)
		},

		async updateConnection(id, payload) {
			const before = this.connectionById(id)
			await api.updateConnection(id, payload)
			await this.reloadConnections()

			// only a changed base_url invalidates the CSP; renaming does not
			if (payload.base_url && payload.base_url !== before?.base_url) {
				this.markCspStale(payload.base_url)
			}
		},

		async deleteConnection(id) {
			await api.deleteConnection(id)
			await this.reloadConnections()
		},

		async createProfile(payload) {
			const profile = await api.createProfile(payload)
			await this.reloadProfiles()

			return profile
		},

		async updateProfile(id, payload) {
			const profile = await api.updateProfile(id, payload)
			await this.reloadProfiles()

			return profile
		},

		async deleteProfile(id) {
			await api.deleteProfile(id)
			await this.reloadProfiles()
		},

		async duplicateProfile(id) {
			const copy = await api.duplicateProfile(id)
			await this.reloadProfiles()

			return copy
		},

		async reorderProfiles(ids) {
			this.profiles = await api.reorderProfiles(ids)
		},

		async importProfiles(profiles, connectionId) {
			const created = await api.importProfiles(profiles, connectionId)
			await this.reloadProfiles()

			return created
		},

		async saveSettings(patch) {
			this.settings = await api.updateSettings(patch)

			// the browser queries SearXNG directly, so a new instance url is
			// not in the running page's CSP yet — same rule as connections
			this.markCspStale(this.settings.searxng_url)
		},
	},
})
