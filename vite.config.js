import { createAppConfig } from '@nextcloud/vite-config'
import { join, resolve } from 'path'

export default createAppConfig({
	main: resolve(join('src', 'main.js')),
}, {
	config: {
		build: {
			cssCodeSplit: false,
		},
	},
	inlineCSS: false,
	minify: process.env.NODE_ENV === 'production',
})
