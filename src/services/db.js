/**
 * IndexedDB layer for active chats (spec §6.1).
 *
 * Deliberately not localStorage: 5 MB cap, synchronous API, blocks the main
 * thread. The consequence of storing here is that histories are per browser
 * and per device — that is the point, and the reason the archive exists.
 */

import { toRaw } from 'vue'

const DB_NAME = 'nc_llm'
const DB_VERSION = 2

let dbPromise = null

function openDb() {
	if (dbPromise) {
		return dbPromise
	}

	dbPromise = new Promise((resolve, reject) => {
		const request = indexedDB.open(DB_NAME, DB_VERSION)

		request.onupgradeneeded = (event) => {
			const db = request.result

			if (!db.objectStoreNames.contains('chats')) {
				const chats = db.createObjectStore('chats', { keyPath: 'id' })
				chats.createIndex('updated_at', 'updated_at')
			}

			if (!db.objectStoreNames.contains('messages')) {
				const messages = db.createObjectStore('messages', { keyPath: 'id' })
				messages.createIndex('chat_id', 'chat_id')
			}

			// model list cache (spec §7.4)
			if (event.oldVersion < 2 && !db.objectStoreNames.contains('models')) {
				db.createObjectStore('models', { keyPath: 'connection_id' })
			}
		}

		request.onsuccess = () => resolve(request.result)
		request.onerror = () => reject(request.error)
		request.onblocked = () => reject(new Error('indexeddb blocked by another tab'))
	})

	return dbPromise
}

async function tx(stores, mode, callback) {
	const db = await openDb()

	return new Promise((resolve, reject) => {
		const transaction = db.transaction(stores, mode)
		let result

		transaction.oncomplete = () => resolve(result)
		transaction.onerror = () => reject(transaction.error)
		transaction.onabort = () => reject(transaction.error)

		try {
			result = callback(transaction)
		} catch (error) {
			transaction.abort()
			reject(error)
		}
	})
}

function req(request) {
	return new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result)
		request.onerror = () => reject(request.error)
	})
}

/**
 * Strips Vue reactivity before handing an object to IndexedDB.
 *
 * IndexedDB serialises with the structured clone algorithm, which throws
 * "Proxy object could not be cloned." on reactive objects. Anything that was
 * ever touched through the store — a message whose `tool_log` was appended to
 * during streaming, for instance — is a Proxy, and it fails at write time,
 * long after the code that created it.
 *
 * Doing this in the db layer rather than at the call sites means no future
 * write can reintroduce the bug.
 *
 * @param {object} value plain or reactive object
 * @return {object} structured-cloneable copy
 */
function detach(value) {
	// toRaw only unwraps the outermost proxy; nested arrays stay reactive,
	// so round-trip through JSON — the stored shapes are plain data anyway
	return JSON.parse(JSON.stringify(toRaw(value)))
}

export function uid() {
	if (globalThis.crypto?.randomUUID) {
		return globalThis.crypto.randomUUID()
	}
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

export async function listChats() {
	const chats = await tx(['chats'], 'readonly', (t) => req(t.objectStore('chats').getAll()))

	return (chats ?? []).sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0))
}

export async function getChat(id) {
	return tx(['chats'], 'readonly', (t) => req(t.objectStore('chats').get(id)))
}

export async function putChat(chat) {
	const plain = detach(chat)
	await tx(['chats'], 'readwrite', (t) => t.objectStore('chats').put(plain))

	return plain
}

export async function createChat({ profileId, title = '' }) {
	const now = Date.now()

	return putChat({
		id: uid(),
		title,
		profile_id: profileId ?? null,
		archived_path: null,
		created_at: now,
		updated_at: now,
	})
}

export async function deleteChat(id) {
	const messages = await listMessages(id)

	await tx(['chats', 'messages'], 'readwrite', (t) => {
		t.objectStore('chats').delete(id)
		const store = t.objectStore('messages')
		messages.forEach((message) => store.delete(message.id))
	})
}

export async function listMessages(chatId) {
	const messages = await tx(['messages'], 'readonly', (t) =>
		req(t.objectStore('messages').index('chat_id').getAll(chatId)),
	)

	return (messages ?? []).sort((a, b) => a.ts - b.ts)
}

export async function putMessage(message) {
	const plain = detach(message)
	await tx(['messages'], 'readwrite', (t) => t.objectStore('messages').put(plain))

	return plain
}

export async function deleteMessages(ids) {
	await tx(['messages'], 'readwrite', (t) => {
		const store = t.objectStore('messages')
		ids.forEach((id) => store.delete(id))
	})
}

export async function getCachedModels(connectionId) {
	const entry = await tx(['models'], 'readonly', (t) =>
		req(t.objectStore('models').get(connectionId)),
	)

	return entry ?? null
}

export async function cacheModels(connectionId, models) {
	const entry = detach({ connection_id: connectionId, models, fetched_at: Date.now() })
	await tx(['models'], 'readwrite', (t) => t.objectStore('models').put(entry))

	return entry
}

export async function dropCachedModels(connectionId) {
	await tx(['models'], 'readwrite', (t) => t.objectStore('models').delete(connectionId))
}

/**
 * Spec §11: at least warn before the quota bites. Returns null when the
 * browser does not expose an estimate.
 */
export async function storageEstimate() {
	if (!navigator.storage?.estimate) {
		return null
	}

	try {
		const { usage = 0, quota = 0 } = await navigator.storage.estimate()
		if (!quota) {
			return null
		}

		return { usage, quota, ratio: usage / quota }
	} catch {
		return null
	}
}
