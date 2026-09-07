/**
 * Connections, profiles and user settings.
 *
 * Seeded from the initial state (spec §9) so the profile switcher does not
 * flicker on load; mutations go through the API and update in place.
 */

import { loadState } from '@nextcloud/initial-state'
import { defineStore } from 'pinia'
import { api } from '../services/api.js'

/**
 * Bounds of the agent loop's tool budget, mirrored from SettingsService so the
 * slider and the loop cannot disagree.
 */
export const MIN_TOOL_ROUNDS = 3
export const MAX_TOOL_ROUNDS = 7

/**
 * @param {number|string|null|undefined} value raw round count, from the
 *   settings or from a profile
 * @return {number} value inside [MIN_TOOL_ROUNDS, MAX_TOOL_ROUNDS]
 */
function clampRounds(value) {
	const rounds = Number(value ?? MIN_TOOL_ROUNDS)
	if (!Number.isFinite(rounds)) {
		return MIN_TOOL_ROUNDS
	}

	return Math.max(MIN_TOOL_ROUNDS, Math.min(MAX_TOOL_ROUNDS, Math.round(rounds)))
}

function safeState(key, fallback) {
	try {
		return loadState('llmchat', key, fallback)
	} catch {
		return fallback
	}
}

/**
 * Issue #19: where the settings footer sends people. Not read from info.xml's
 * `<website>` — that is server-side data and would need a round trip to reach
 * the browser, for a string that changes when the repository moves and not a
 * minute sooner.
 */
export const APP_REPO_URL = 'https://github.com/markuman/llmchat'

export const useConfigStore = defineStore('config', {
	state: () => ({
		/**
		 * Installed app version, straight from the app manager (issue #19).
		 * Empty when the initial state is missing, which is what the footer
		 * checks before claiming a version it does not know.
		 */
		version: safeState('version', ''),
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
			max_tool_rounds: MIN_TOOL_ROUNDS,
			skills_enabled: false,
		}),
		/**
		 * Skill metadata (issue #17): `{id, name, description, domains, path}`
		 * each, never a body. Seeded from the initial state because the
		 * descriptions go into the very first system prompt — a fetch here
		 * would mean the first message of a session silently has no skills.
		 */
		skills: safeState('skills', []),
		/**
		 * Urls known to the CSP of the *currently loaded page* — connections,
		 * the SearXNG instance and whatever hosts the skills declared, since
		 * the browser talks to all of them directly. Anything added later
		 * needs a reload before it can be reached (spec §7.1).
		 */
		cspBaseUrls: [
			...safeState('connections', []).map((c) => c.base_url),
			safeState('settings', {}).searxng_url,
			...safeState('skills', []).flatMap((s) => (s.domains ?? []).map((d) => `https://${d}`)),
		].filter(Boolean),
		reloadRequired: false,
	}),

	getters: {
		hasConnections: (state) => state.connections.length > 0,
		hasProfiles: (state) => state.profiles.length > 0,

		/**
		 * Tool rounds the agent loop may spend. Clamped here rather than at
		 * the call site: a stored value from an older version, or from a
		 * hand-edited config, must not unbound the loop.
		 */
		toolRounds: (state) => clampRounds(state.settings.max_tool_rounds),

		/**
		 * The budget a given profile runs with: its own `tool_rounds` if set,
		 * otherwise the general setting. A profile that chains a search into
		 * a fetch needs more rounds than a plain chat profile, and paying for
		 * that globally is the wrong trade.
		 */
		toolRoundsFor() {
			return (profile) => {
				const own = profile?.tool_rounds
				if (own === null || own === undefined || own === '') {
					return this.toolRounds
				}

				return clampRounds(own)
			}
		},

		sortedProfiles: (state) => [...state.profiles].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)),

		connectionById: (state) => (id) => state.connections.find((c) => c.id === id) ?? null,

		profileById: (state) => (id) => state.profiles.find((p) => p.id === id) ?? null,

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
			return this.sortedProfiles.filter((p) => state.connections.some((c) => c.id === p.connection_id))
		},

		/**
		 * Skills the `skills` tool can actually offer (issue #17).
		 *
		 * A skill with no description is dropped rather than listed: the
		 * description *is* the thing the model chooses on, and a bare name in
		 * the catalogue costs tokens to say nothing.
		 */
		usableSkills: (state) => (
			state.settings.skills_enabled
				? state.skills.filter((skill) => skill.description)
				: []
		),

		hasSkills() {
			return this.usableSkills.length > 0
		},

		/**
		 * The catalogue as it goes into the system prompt. One line per skill:
		 * enough for the model to pick one, small enough to send every time.
		 */
		skillCatalogue() {
			if (!this.hasSkills) {
				return ''
			}

			const lines = this.usableSkills
				.map((skill) => `- ${skill.id}: ${skill.name} — ${skill.description}`)
				.join('\n')

			return 'Available skills — procedures the user has written down for specific '
				+ 'tasks. When one matches what is being asked, call `skill_read` with its '
				+ 'id and follow it, instead of searching the web or improvising. Reading a '
				+ 'skill is cheap; ignoring one that applies produces a worse answer.\n\n'
				+ lines
		},

		/**
		 * Hosts the loaded page may reach for skills. The tool checks against
		 * this rather than trusting the skill body, so a fetch that the CSP
		 * would block fails with an explanation instead of a bare TypeError.
		 *
		 * Taken from every skill, not only the usable ones: a skill with no
		 * description is never offered but its host is in the page's CSP all
		 * the same, and this list has to describe what the page can reach.
		 * Empty when skills are off, so the tool cannot outlive the switch.
		 */
		skillDomains: (state) => (
			state.settings.skills_enabled
				? [...new Set(state.skills.flatMap((skill) => skill.domains ?? []))]
				: []
		),
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

		async reloadSkills() {
			this.skills = await api.listSkills()
			// a skill file added or edited since the page loaded can name a
			// host the running page's CSP has never heard of
			this.skills
				.flatMap((skill) => skill.domains ?? [])
				.forEach((domain) => this.markCspStale(`https://${domain}`))
		},

		/**
		 * Switches skills on or off (issue #17).
		 *
		 * Turning them on creates the folder and the example skill; turning
		 * them off deletes nothing. The files are the user's, and a toggle is
		 * not consent to remove something they may have spent an evening
		 * writing.
		 *
		 * @param {boolean} enabled new state
		 * @return {Promise<object|null>} provisioning result when switched on
		 */
		async setSkillsEnabled(enabled) {
			await this.saveSettings({ skills_enabled: enabled })

			if (!enabled) {
				this.skills = []

				return null
			}

			const result = await api.provisionSkills()
			await this.reloadSkills()

			return result
		},
	},
})
