<template>
	<!--
		Issue #15: the model asking instead of guessing. Same place as the
		approval dialog, on purpose — a request that blocks the answer belongs
		in front of the chat, not appended to it as another message the user
		has to notice.
	-->
	<NcDialog
		:name="t('llmchat', 'The model has a question')"
		size="normal"
		:closeOnClickOutside="false"
		@closing="dismiss">
		<div class="questions">
			<p class="questions__intro">
				{{ intro }}
			</p>

			<fieldset
				v-for="question in pending.questions"
				:key="question.id"
				class="question">
				<legend v-if="question.header" class="question__header">
					{{ question.header }}
				</legend>

				<p class="question__text">
					{{ question.question }}
				</p>

				<ul v-if="question.options.length > 0" class="question__options">
					<li v-for="(option, index) in question.options" :key="index">
						<NcCheckboxRadioSwitch
							:type="question.multiple ? 'checkbox' : 'radio'"
							:name="question.id"
							:value="option.label"
							:modelValue="selection[question.id]"
							@update:modelValue="selection[question.id] = $event">
							{{ option.label }}
						</NcCheckboxRadioSwitch>
						<span v-if="option.description" class="question__option-hint">
							{{ option.description }}
						</span>
					</li>
				</ul>

				<!--
					Always present, even with options: the model guessed the
					choices, and being forced into the closest wrong one is
					worse than typing.
				-->
				<input
					v-model="custom[question.id]"
					type="text"
					class="question__custom"
					:placeholder="question.options.length > 0
						? t('llmchat', 'Or type your own answer…')
						: t('llmchat', 'Your answer…')"
					@keydown.enter.prevent="submit">
			</fieldset>
		</div>

		<template #actions>
			<NcButton @click="dismiss">
				{{ t('llmchat', 'Skip') }}
			</NcButton>
			<NcButton variant="primary" :disabled="!canSubmit" @click="submit">
				{{ t('llmchat', 'Answer') }}
			</NcButton>
		</template>
	</NcDialog>
</template>

<script>
import NcButton from '@nextcloud/vue/components/NcButton'
import NcCheckboxRadioSwitch from '@nextcloud/vue/components/NcCheckboxRadioSwitch'
import NcDialog from '@nextcloud/vue/components/NcDialog'
import { useChatStore } from '../store/chat.js'

export default {
	name: 'ToolQuestions',

	components: {
		NcButton,
		NcCheckboxRadioSwitch,
		NcDialog,
	},

	setup() {
		return { chat: useChatStore() }
	},

	data() {
		return {
			/** picked option labels, by question id — a string, or an array when multiple */
			selection: {},
			/** free text, by question id; wins over the selection when filled */
			custom: {},
		}
	},

	computed: {
		pending() {
			return this.chat.pendingQuestions
		},

		intro() {
			const count = this.pending.questions.length

			return count === 1
				? this.t('llmchat', 'It needs one thing cleared up before it can answer.')
				: this.t('llmchat', 'It needs a few things cleared up before it can answer.')
		},

		/**
		 * At least one answer. Not all of them: a model asking five questions
		 * has usually asked one too many, and forcing an answer to each turns
		 * a helpful prompt into a form.
		 */
		canSubmit() {
			return this.pending.questions.some((question) => this.answerFor(question) !== '')
		},
	},

	created() {
		// multi-select needs an array from the start — NcCheckboxRadioSwitch
		// pushes into the bound value and would otherwise get a string
		this.pending.questions.forEach((question) => {
			this.selection[question.id] = question.multiple ? [] : ''
			this.custom[question.id] = ''
		})
	},

	methods: {
		/**
		 * @param {object} question one entry of the dialog
		 * @return {string} what the model gets for it, empty when unanswered
		 */
		answerFor(question) {
			const typed = (this.custom[question.id] ?? '').trim()
			if (typed !== '') {
				return typed
			}

			const picked = this.selection[question.id]

			return Array.isArray(picked) ? picked.join(', ') : (picked ?? '')
		},

		submit() {
			if (!this.canSubmit) {
				return
			}

			const answers = {}
			this.pending.questions.forEach((question) => {
				const answer = this.answerFor(question)
				// skipped questions are left out rather than sent as empty
				// strings, so the model can tell "no opinion" from ""
				if (answer !== '') {
					answers[question.id] = answer
				}
			})

			this.chat.resolveQuestions(answers)
		},

		dismiss() {
			this.chat.resolveQuestions(null)
		},
	},
}
</script>

<style scoped>
.questions {
	display: flex;
	flex-direction: column;
	gap: 14px;
	padding: 0 12px 8px;
}

.questions__intro {
	margin: 0;
	color: var(--color-text-maxcontrast);
}

.question {
	margin: 0;
	padding: 8px 10px;
	border: none;
	border-radius: var(--border-radius);
	background-color: var(--color-background-dark);
}

.question__header {
	padding: 0;
	color: var(--color-text-maxcontrast);
	font-size: 0.8em;
	text-transform: uppercase;
}

.question__text {
	margin: 0 0 6px;
	font-weight: 600;
}

.question__options {
	list-style: none;
	margin: 0 0 6px;
	padding: 0;
}

.question__option-hint {
	display: block;
	margin: -4px 0 4px 34px;
	color: var(--color-text-maxcontrast);
	font-size: 0.85em;
}

.question__custom {
	width: 100%;
}
</style>
