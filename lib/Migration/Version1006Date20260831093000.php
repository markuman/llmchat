<?php

declare(strict_types=1);

/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\LlmChat\Migration;

use Closure;
use OCP\DB\ISchemaWrapper;
use OCP\DB\Types;
use OCP\Migration\IOutput;
use OCP\Migration\SimpleMigrationStep;

/**
 * Adds the per-profile approval switch for tool calls.
 *
 * Default is `true`: a model deciding on its own to read your Nextcloud or
 * fetch a URL should be visible before it happens, not afterwards in the tool
 * log. Turning it off is a deliberate choice.
 */
class Version1006Date20260831093000 extends SimpleMigrationStep {
	/**
	 * @param Closure(): ISchemaWrapper $schemaClosure
	 */
	public function changeSchema(IOutput $output, Closure $schemaClosure, array $options): ?ISchemaWrapper {
		/** @var ISchemaWrapper $schema */
		$schema = $schemaClosure();

		if (!$schema->hasTable('llm_profiles')) {
			return null;
		}

		$table = $schema->getTable('llm_profiles');
		if (!$table->hasColumn('tool_approval')) {
			$table->addColumn('tool_approval', Types::BOOLEAN, [
				'notnull' => false,
				'default' => true,
			]);
		}

		return $schema;
	}
}
