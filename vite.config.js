import { createAppConfig } from '@nextcloud/vite-config'
import { join, resolve } from 'path'

export default createAppConfig({
	main: resolve(join('src', 'main.js')),
	// Issue #20: loaded into the Files app, not into ours. Kept as its own
	// entry point so that visiting Files does not pull in Vue, pinia and
	// pdf.js for the sake of one menu entry.
	filesplugin: resolve(join('src', 'filesplugin.js')),
}, {
	config: {
		build: {
			cssCodeSplit: false,
		},
	},
	inlineCSS: false,
	minify: process.env.NODE_ENV === 'production',

	/**
	 * The pdf.js worker is an emitted asset, not a chunk, and the default rule
	 * for anything that is neither image, style nor font drops it into a
	 * `dist/` directory of its own. That would be a third build output next to
	 * js/ and css/ — untracked by .gitignore, unswept by `make clean` and easy
	 * to forget when deploying. Everything executable belongs in js/.
	 *
	 * @param {object} asset rollup asset info
	 * @return {string|undefined} output pattern, or undefined for the default
	 */
	assetFileNames: (asset) => (
		(asset.names ?? []).some((name) => name.endsWith('.mjs'))
			? 'js/[name]-[hash][extname]'
			: undefined
	),
})
