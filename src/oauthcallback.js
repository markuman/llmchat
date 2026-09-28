/**
 * The OAuth popup's landing page (issue #11).
 *
 * Tells the settings over a BroadcastChannel rather than through
 * `window.opener`: the opener link is cut before the popup navigates to the
 * provider, so a hostile authorization page cannot reach back and rewrite
 * the tab it came from. A same-origin channel needs no such link.
 *
 * Its own tiny entry point — this page has no business loading Vue.
 */

// same string as MCP_OAUTH_CHANNEL in services/mcp.js — not imported, since
// that would drag axios into a page that needs nothing but this
const CHANNEL = 'llmchat-mcp-oauth'

const element = document.getElementById('llmchat-oauth')

if (element) {
	const result = {
		type: CHANNEL,
		ok: element.dataset.ok === '1',
		server_id: Number(element.dataset.serverId) || null,
		message: element.dataset.message ?? '',
	}

	try {
		const channel = new BroadcastChannel(CHANNEL)
		channel.postMessage(result)
		channel.close()
	} catch {
		// no BroadcastChannel: the settings still pick it up on focus
	}

	// only on success — an error message is worth reading before it goes
	if (result.ok) {
		setTimeout(() => window.close(), 1500)
	}
}
