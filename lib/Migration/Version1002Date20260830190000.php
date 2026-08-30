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
 * Adds the per-profile tools switch.
 *
 * Default is `false`: enabling web tools sends search queries and URLs to the
 * Nextcloud server (which performs the fetch) and page content to the model.
 * That is a meaningful privacy change, so it is strictly opt-in.
 */
class Version1002Date20260830190000 extends SimpleMigrationStep {
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
		if (!$table->hasColumn('tools')) {
			$table->addColumn('tools', Types::BOOLEAN, [
				'notnull' => false,
				'default' => false,
			]);
		}

		return $schema;
	}
}
