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
 * Adds the optional per-profile tool round budget.
 *
 * Nullable on purpose: NULL means "use the general setting", which keeps the
 * existing behaviour for every profile that predates this column and leaves
 * one place to change the budget for everything at once. A profile that
 * chains search into fetch can raise it without dragging the cheap chat
 * profiles along.
 */
class Version1007Date20260903120000 extends SimpleMigrationStep {
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
		if (!$table->hasColumn('tool_rounds')) {
			$table->addColumn('tool_rounds', Types::INTEGER, [
				'notnull' => false,
			]);
		}

		return $schema;
	}
}
