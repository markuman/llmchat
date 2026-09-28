/**
 * Thin wrapper around the app's own backend. Same origin, session cookie,
 * CSRF handled by @nextcloud/axios.
 */

import axios from '@nextcloud/axios'
import { generateUrl } from '@nextcloud/router'

function url(path) {
	return generateUrl(`/apps/llmchat/api/v1${path}`)
}

function unwrap(error) {
	const message = error?.response?.data?.message
	const wrapped = new Error(message || error.message)
	wrapped.status = error?.response?.status ?? null

	return wrapped
}

async function call(promise) {
	try {
		const { data } = await promise
		return data
	} catch (error) {
		throw unwrap(error)
	}
}

export const api = {
	listConnections: () => call(axios.get(url('/connections'))),
	createConnection: (payload) => call(axios.post(url('/connections'), payload)),
	updateConnection: (id, payload) => call(axios.put(url(`/connections/${id}`), payload)),
	deleteConnection: (id) => call(axios.delete(url(`/connections/${id}`))),

	listProfiles: () => call(axios.get(url('/profiles'))),
	createProfile: (payload) => call(axios.post(url('/profiles'), payload)),
	updateProfile: (id, payload) => call(axios.put(url(`/profiles/${id}`), payload)),
	deleteProfile: (id) => call(axios.delete(url(`/profiles/${id}`))),
	duplicateProfile: (id) => call(axios.post(url(`/profiles/${id}/duplicate`))),
	reorderProfiles: (ids) => call(axios.post(url('/profiles/reorder'), { ids })),
	importProfiles: (profiles, connectionId) => call(axios.post(url('/profiles/import'), { profiles, connection_id: connectionId })),

	archive: (payload) => call(axios.post(url('/archive'), payload)),

	getSettings: () => call(axios.get(url('/settings'))),
	updateSettings: (payload) => call(axios.put(url('/settings'), payload)),

	// issue #17
	listSkills: () => call(axios.get(url('/skills'))),
	readSkill: (id) => call(axios.get(url('/skills/read'), { params: { id } })),
	provisionSkills: () => call(axios.post(url('/skills/provision'))),

	// issue #11 — the rpc route is used by services/mcp.js directly, which
	// needs the whole envelope rather than this error unwrapping
	listMcpServers: () => call(axios.get(url('/mcp'))),
	createMcpServer: (payload) => call(axios.post(url('/mcp'), payload)),
	updateMcpServer: (id, payload) => call(axios.put(url(`/mcp/${id}`), payload)),
	deleteMcpServer: (id) => call(axios.delete(url(`/mcp/${id}`))),
	connectMcpServer: (id) => call(axios.post(url(`/mcp/${id}/connect`))),
	disconnectMcpServer: (id) => call(axios.post(url(`/mcp/${id}/disconnect`))),
}
