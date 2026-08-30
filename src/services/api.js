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
	importProfiles: (profiles, connectionId) =>
		call(axios.post(url('/profiles/import'), { profiles, connection_id: connectionId })),

	archive: (payload) => call(axios.post(url('/archive'), payload)),

	getSettings: () => call(axios.get(url('/settings'))),
	updateSettings: (payload) => call(axios.put(url('/settings'), payload)),
}
