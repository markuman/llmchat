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
 * Adds the per-profile reasoning switch.
 *
 * Default is `true`, meaning "leave the backend alone" — Ollama enables
 * thinking by default on capable models, so existing profiles keep behaving
 * exactly as before this migration.
 */
class Version1001Date20260830170000 extends SimpleMigrationStep {
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
		if (!$table->hasColumn('reasoning')) {
			$table->addColumn('reasoning', Types::BOOLEAN, [
				'notnull' => false,
				'default' => true,
			]);
		}

		return $schema;
	}
}
