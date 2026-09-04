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
 * Adds the per-profile vision flag.
 *
 * Defaults to false, and that default is the point: handing base64 image data
 * to a text-only model burns the whole context window and produces nonsense.
 * Only a profile whose model actually understands images gets the image tools
 * offered at all.
 */
class Version1008Date20260904090000 extends SimpleMigrationStep {
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
		if (!$table->hasColumn('vision')) {
			$table->addColumn('vision', Types::BOOLEAN, [
				'notnull' => false,
				'default' => false,
			]);
		}

		return $schema;
	}
}
