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
 * Memory profiles (3.0.0).
 *
 * A memory profile is a pointer to one Markdown file in the user's home plus
 * the knobs for recap and compact. The file itself never passes through this
 * table or this server: the browser reads and writes it over WebDAV. The only
 * thing PHP ever does with it is create it once, empty.
 *
 * `llm_profiles.memory_profile_id` goes in the same step: null is incognito,
 * which is exactly how every existing profile behaves today.
 */
class Version1010Date20261028120000 extends SimpleMigrationStep {
	/**
	 * @param Closure(): ISchemaWrapper $schemaClosure
	 */
	public function changeSchema(IOutput $output, Closure $schemaClosure, array $options): ?ISchemaWrapper {
		/** @var ISchemaWrapper $schema */
		$schema = $schemaClosure();

		if (!$schema->hasTable('llm_memory_profiles')) {
			$table = $schema->createTable('llm_memory_profiles');
			$table->addColumn('id', Types::BIGINT, [
				'autoincrement' => true,
				'notnull' => true,
				'length' => 20,
			]);
			$table->addColumn('user_id', Types::STRING, [
				'notnull' => true,
				'length' => 64,
			]);
			$table->addColumn('name', Types::STRING, [
				'notnull' => true,
				'length' => 128,
			]);
			// relative to the user's home, see MemoryProfileService::normalizePath()
			$table->addColumn('path', Types::STRING, [
				'notnull' => true,
				'length' => 1024,
			]);
			$table->addColumn('max_chars', Types::INTEGER, [
				'notnull' => true,
				'default' => 12000,
			]);
			$table->addColumn('recap_enabled', Types::BOOLEAN, [
				'notnull' => false,
				'default' => true,
			]);
			// null = whichever chat profile produced the answer
			$table->addColumn('recap_profile_id', Types::BIGINT, [
				'notnull' => false,
				'length' => 20,
			]);
			$table->addColumn('auto_compact', Types::BOOLEAN, [
				'notnull' => false,
				'default' => false,
			]);
			// percent of max_chars
			$table->addColumn('compact_threshold', Types::INTEGER, [
				'notnull' => true,
				'default' => 80,
			]);
			$table->addColumn('created_at', Types::STRING, [
				'notnull' => true,
				'length' => 32,
				'default' => '',
			]);
			$table->addColumn('updated_at', Types::STRING, [
				'notnull' => true,
				'length' => 32,
				'default' => '',
			]);

			$table->setPrimaryKey(['id']);
			$table->addIndex(['user_id'], 'llm_mem_uid_idx');
		}

		if ($schema->hasTable('llm_profiles')) {
			$profiles = $schema->getTable('llm_profiles');
			if (!$profiles->hasColumn('memory_profile_id')) {
				$profiles->addColumn('memory_profile_id', Types::BIGINT, [
					'notnull' => false,
					'length' => 20,
				]);
			}
		}

		return $schema;
	}
}
