/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { n, t } from '@nextcloud/l10n'
import { createPinia } from 'pinia'
import { createApp } from 'vue'
import App from './App.vue'
import { setCopyLabel } from './services/markdown.js'

import './css/app.css'

setCopyLabel(t('llmchat', 'Copy'))

const app = createApp(App)

app.use(createPinia())

app.config.globalProperties.t = t
app.config.globalProperties.n = n

app.mount('#llmchat')
