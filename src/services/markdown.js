/**
 * Markdown rendering with syntax highlighting (spec §5).
 *
 * Everything is sanitised with DOMPurify — the content comes from a remote
 * model and is therefore untrusted input, even though the user asked for it.
 */

import DOMPurify from 'dompurify'
import hljs from 'highlight.js/lib/common'
import { Marked } from 'marked'

const marked = new Marked({
	gfm: true,
	breaks: true,
})

marked.use({
	renderer: {
		code({ text, lang }) {
			const language = hljs.getLanguage(lang ?? '') ? lang : null
			const highlighted = language
				? hljs.highlight(text, { language, ignoreIllegals: true }).value
				: escapeHtml(text)

			return '<div class="llm-code">'
				+ `<div class="llm-code__head"><span>${escapeHtml(language ?? 'text')}</span>`
				+ '<button class="llm-code__copy" type="button" '
				+ `data-code="${encodeURIComponent(text)}">${escapeHtml(copyLabel())}</button></div>`
				+ `<pre><code class="hljs language-${escapeHtml(language ?? 'plaintext')}">${highlighted}</code></pre>`
				+ '</div>'
		},
	},
})

let copyText = 'Copy'

export function setCopyLabel(label) {
	copyText = label
}

function copyLabel() {
	return copyText
}

export function escapeHtml(value) {
	return String(value ?? '')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;')
}

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
	if (node.tagName === 'A') {
		node.setAttribute('target', '_blank')
		node.setAttribute('rel', 'noopener noreferrer')
	}
})

export function renderMarkdown(source) {
	const html = marked.parse(String(source ?? ''))

	return DOMPurify.sanitize(html, {
		ADD_ATTR: ['target', 'data-code'],
		FORBID_TAGS: ['style', 'form', 'input', 'iframe'],
	})
}

export function renderPlain(source) {
	return `<p>${escapeHtml(source).replace(/\n/g, '<br>')}</p>`
}
