/**
 * Turning a Nextcloud path into something safe to put in a prompt.
 *
 * Extracted from ChatComposer because the Files action (issue #20) needs
 * exactly the same treatment and a second copy would drift.
 */

/**
 * Wraps a path so a filename with spaces still reads as one path (issue #16).
 *
 * Nextcloud allows `"` in filenames, so a plain `"…"` wrapper can be closed
 * by the name itself and the tail becomes prose. Backslash-escaping would
 * fix the parse and create a worse problem: the model would have to know to
 * strip the escapes again before calling a tool with the path, and one that
 * does not passes `report \"final\".pdf` to the file service, which 404s on a
 * file that exists. So the quote character steps aside instead — single
 * quotes when the name contains a double one, backticks when it contains
 * both. Whatever comes out is a path that can be copied verbatim into a tool
 * call.
 *
 * @param {string} path relative path from the picker
 * @return {string} the path, delimited
 */
export function quotePath(path) {
	if (!path.includes('"')) {
		return `"${path}"`
	}
	if (!path.includes("'")) {
		return `'${path}'`
	}

	// A filename with both kinds of quote. Backticks read as code to the
	// model, which is if anything clearer — and markdown's own answer to a
	// backtick inside a code span is a longer fence, so even that case
	// delimits without touching the path. Nothing here may rewrite it: a
	// path the model cannot resolve is a 404 on a file that exists.
	const longestRun = Math.max(0, ...[...path.matchAll(/`+/g)].map((m) => m[0].length))
	const fence = '`'.repeat(longestRun + 1)

	// a leading or trailing backtick in the name would fuse with the fence
	return `${fence} ${path} ${fence}`
}

/**
 * The form the file tools take: relative to the user's home, no leading
 * slash. The picker and the Files app both hand out paths rooted at the home
 * with one.
 *
 * @param {string} path path rooted at the user's home
 * @return {string} path relative to it
 */
export function relativeToHome(path) {
	return String(path ?? '').replace(/^\/+/, '')
}
