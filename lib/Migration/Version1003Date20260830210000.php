<?php

declare(strict_types=1);

/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\LlmChat\Migration;

use Closure;
use OCP\DB\ISchemaWrapper;
use OCP\DB\Types;
use OCP\IDBConnection;
use OCP\Migration\IOutput;
use OCP\Migration\SimpleMigrationStep;

/**
 * Replaces the all-or-nothing `tools` flag with a per-tool allowlist.
 *
 * A comma separated list rather than one column per tool: the tools differ in
 * what they cost you privacy-wise (datetime is answered in the browser, the
 * web tools route through this server), so they must be individually
 * selectable — and adding a fourth tool later should not need a migration.
 */
class Version1003Date20260830210000 extends SimpleMigrationStep {
	public function __construct(
		private IDBConnection $db,
	) {
	}

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
		if (!$table->hasColumn('enabled_tools')) {
			$table->addColumn('enabled_tools', Types::STRING, [
				'notnull' => false,
				'length' => 255,
				'default' => '',
			]);
		}

		return $schema;
	}

	/**
	 * Carries the old boolean over: a profile that had tools on gets all three,
	 * which is exactly what it was doing before.
	 *
	 * @param Closure(): ISchemaWrapper $schemaClosure
	 */
	public function postSchemaChange(IOutput $output, Closure $schemaClosure, array $options): void {
		/** @var ISchemaWrapper $schema */
		$schema = $schemaClosure();

		if (!$schema->hasTable('llm_profiles')) {
			return;
		}

		// the old column is dropped in the next migration, so this runs exactly once
		if (!$schema->getTable('llm_profiles')->hasColumn('tools')) {
			return;
		}

		$qb = $this->db->getQueryBuilder();
		$qb->update('llm_profiles')
			->set('enabled_tools', $qb->createNamedParameter('datetime,web_search,web_fetch'))
			->where($qb->expr()->eq('tools', $qb->createNamedParameter(true, \OCP\DB\QueryBuilder\IQueryBuilder::PARAM_BOOL)));

		$updated = $qb->executeStatement();
		if ($updated > 0) {
			$output->info('llmchat: migrated ' . $updated . ' profile(s) to the per-tool allowlist');
		}
	}
}
