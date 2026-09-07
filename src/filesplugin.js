/**
 * The "LLM Chat" entry in the Files app menu (issue #20).
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This is a second, tiny bundle: it is loaded on every page of the Files app,
 * so it must not drag in Vue, pinia, pdf.js or the chat itself. Everything it
 * does is build a URL and follow it — the app on the other end takes the
 * `path` parameter from there.
 *
 * Deliberately a link and not a message to an already-open tab: the chat
 * keeps its history in IndexedDB in the browser, and opening it fresh is both
 * simpler and the thing a user clicking a menu entry expects.
 */

import { registerFileAction } from '@nextcloud/files'
import { translate as t } from '@nextcloud/l10n'
import { generateUrl } from '@nextcloud/router'

/** Matches img/app.svg — inline, because the action takes a string. */
const ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24">'
	+ '<path d="M12 2a2 2 0 0 1 2 2c0 .74-.4 1.39-1 1.73V7h3a3 3 0 0 1 3 3v1h1a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-1v1a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3v-1H4a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1h1v-1a3 3 0 0 1 3-3h3V5.73c-.6-.34-1-.99-1-1.73a2 2 0 0 1 2-2m-2.5 9a1.5 1.5 0 0 0-1.5 1.5A1.5 1.5 0 0 0 9.5 14a1.5 1.5 0 0 0 1.5-1.5A1.5 1.5 0 0 0 9.5 11m5 0a1.5 1.5 0 0 0-1.5 1.5 1.5 1.5 0 0 0 1.5 1.5 1.5 1.5 0 0 0 1.5-1.5 1.5 1.5 0 0 0-1.5-1.5Z"/>'
	+ '</svg>'

/**
 * `node.path` is rooted at the user's home with a leading slash, which is
 * also what the app expects to strip. Encoding is left to URLSearchParams via
 * generateUrl's parameter substitution.
 *
 * @param {object} node the file or folder
 * @return {string|null} url to open, or null when the node has no usable path
 */
function chatUrlFor(node) {
	const path = String(node?.path ?? '').trim()
	if (path === '' || path === '/') {
		return null
	}

	return generateUrl('/apps/llmchat/?path={path}', { path })
}

registerFileAction({
	id: 'llmchat',

	displayName: () => t('llmchat', 'LLM Chat'),
	title: () => t('llmchat', 'Start a chat with this path in the prompt'),
	iconSvgInline: () => ICON_SVG,

	/**
	 * Files and folders both: the path only goes into the prompt, and what
	 * can be done with it is up to the profile's tools — a folder is a
	 * perfectly good argument for `nc_list_files`. Shared and external nodes
	 * are fine too, since the file tools read through the user's own session.
	 *
	 * @param {object} context action context
	 * @return {boolean} whether to show the entry
	 */
	enabled: ({ nodes }) => nodes.length === 1 && chatUrlFor(nodes[0]) !== null,

	/**
	 * @param {object} context action context with exactly one node
	 * @return {Promise<boolean|null>} null: navigating away is not a result
	 */
	async exec({ nodes: [node] }) {
		const url = chatUrlFor(node)
		if (url === null) {
			return false
		}

		// A new tab, not this one. Someone browsing their files clicked a
		// menu entry, not a link away — taking the Files app with it would
		// lose their place in a directory they may have navigated into.
		window.open(url, '_blank', 'noopener,noreferrer')

		return null
	},

	// after the built-in verbs (open, download, …), before the destructive
	// ones at the bottom
	order: 20,
})
