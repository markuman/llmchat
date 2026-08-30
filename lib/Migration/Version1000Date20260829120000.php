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

class Version1000Date20260829120000 extends SimpleMigrationStep {
	/**
	 * @param Closure(): ISchemaWrapper $schemaClosure
	 */
	public function changeSchema(IOutput $output, Closure $schemaClosure, array $options): ?ISchemaWrapper {
		/** @var ISchemaWrapper $schema */
		$schema = $schemaClosure();

		if (!$schema->hasTable('llm_connections')) {
			$table = $schema->createTable('llm_connections');
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
			$table->addColumn('base_url', Types::STRING, [
				'notnull' => true,
				'length' => 512,
			]);
			$table->addColumn('api_key', Types::TEXT, [
				'notnull' => false,
			]);
			$table->addColumn('provider_hint', Types::STRING, [
				'notnull' => true,
				'length' => 32,
				'default' => 'openai_compatible',
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
			$table->addIndex(['user_id'], 'llm_conn_uid_idx');
		}

		if (!$schema->hasTable('llm_profiles')) {
			$table = $schema->createTable('llm_profiles');
			$table->addColumn('id', Types::BIGINT, [
				'autoincrement' => true,
				'notnull' => true,
				'length' => 20,
			]);
			$table->addColumn('user_id', Types::STRING, [
				'notnull' => true,
				'length' => 64,
			]);
			$table->addColumn('connection_id', Types::BIGINT, [
				'notnull' => true,
				'length' => 20,
			]);
			$table->addColumn('name', Types::STRING, [
				'notnull' => true,
				'length' => 128,
			]);
			$table->addColumn('model', Types::STRING, [
				'notnull' => true,
				'length' => 255,
			]);
			$table->addColumn('system_prompt', Types::TEXT, [
				'notnull' => false,
			]);
			$table->addColumn('temperature', Types::FLOAT, [
				'notnull' => false,
			]);
			$table->addColumn('max_tokens', Types::INTEGER, [
				'notnull' => false,
			]);
			$table->addColumn('is_default', Types::BOOLEAN, [
				'notnull' => false,
				'default' => false,
			]);
			$table->addColumn('streaming', Types::BOOLEAN, [
				'notnull' => false,
				'default' => true,
			]);
			$table->addColumn('sort_order', Types::INTEGER, [
				'notnull' => true,
				'default' => 0,
			]);

			$table->setPrimaryKey(['id']);
			$table->addIndex(['user_id'], 'llm_prof_uid_idx');
			$table->addIndex(['connection_id'], 'llm_prof_conn_idx');
		}

		return $schema;
	}
}
