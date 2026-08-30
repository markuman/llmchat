<?php

declare(strict_types=1);

/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\LlmChat\Migration;

use Closure;
use OCA\LlmChat\AppInfo\Application;
use OCP\DB\ISchemaWrapper;
use OCP\IDBConnection;
use OCP\Migration\IOutput;
use OCP\Migration\SimpleMigrationStep;

/**
 * Removes the obsolete `search_provider` preference.
 *
 * The DuckDuckGo provider is gone, so the setting has nothing left to select.
 * It lives in oc_preferences rather than in a table of ours, which no schema
 * change would ever clean up.
 */
class Version1005Date20260830223000 extends SimpleMigrationStep {
	public function __construct(
		private IDBConnection $db,
	) {
	}

	/**
	 * @param Closure(): ISchemaWrapper $schemaClosure
	 */
	public function postSchemaChange(IOutput $output, Closure $schemaClosure, array $options): void {
		$qb = $this->db->getQueryBuilder();
		$qb->delete('preferences')
			->where($qb->expr()->eq('appid', $qb->createNamedParameter(Application::APP_ID)))
			->andWhere($qb->expr()->eq('configkey', $qb->createNamedParameter('search_provider')));

		$removed = $qb->executeStatement();
		if ($removed > 0) {
			$output->info('llmchat: removed ' . $removed . ' obsolete search_provider preference(s)');
		}
	}
}
