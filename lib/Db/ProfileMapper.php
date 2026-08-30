<?php

declare(strict_types=1);

/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\LlmChat\Db;

use OCP\AppFramework\Db\DoesNotExistException;
use OCP\AppFramework\Db\MultipleObjectsReturnedException;
use OCP\AppFramework\Db\QBMapper;
use OCP\DB\Exception;
use OCP\DB\QueryBuilder\IQueryBuilder;
use OCP\IDBConnection;

/**
 * @template-extends QBMapper<Profile>
 */
class ProfileMapper extends QBMapper {
	public function __construct(IDBConnection $db) {
		parent::__construct($db, 'llm_profiles', Profile::class);
	}

	/**
	 * @return Profile[]
	 * @throws Exception
	 */
	public function findAllForUser(string $userId): array {
		$qb = $this->db->getQueryBuilder();
		$qb->select('*')
			->from($this->getTableName())
			->where($qb->expr()->eq('user_id', $qb->createNamedParameter($userId)))
			->orderBy('sort_order', 'ASC')
			->addOrderBy('id', 'ASC');

		return $this->findEntities($qb);
	}

	/**
	 * @return Profile[]
	 * @throws Exception
	 */
	public function findByConnection(int $connectionId, string $userId): array {
		$qb = $this->db->getQueryBuilder();
		$qb->select('*')
			->from($this->getTableName())
			->where($qb->expr()->eq('connection_id', $qb->createNamedParameter($connectionId, IQueryBuilder::PARAM_INT)))
			->andWhere($qb->expr()->eq('user_id', $qb->createNamedParameter($userId)));

		return $this->findEntities($qb);
	}

	/**
	 * @throws DoesNotExistException
	 * @throws MultipleObjectsReturnedException
	 * @throws Exception
	 */
	public function findForUser(int $id, string $userId): Profile {
		$qb = $this->db->getQueryBuilder();
		$qb->select('*')
			->from($this->getTableName())
			->where($qb->expr()->eq('id', $qb->createNamedParameter($id, IQueryBuilder::PARAM_INT)))
			->andWhere($qb->expr()->eq('user_id', $qb->createNamedParameter($userId)));

		return $this->findEntity($qb);
	}

	/**
	 * Clears the default flag on every profile of the user except $exceptId.
	 *
	 * @throws Exception
	 */
	public function clearDefault(string $userId, ?int $exceptId = null): void {
		$qb = $this->db->getQueryBuilder();
		$qb->update($this->getTableName())
			->set('is_default', $qb->createNamedParameter(false, IQueryBuilder::PARAM_BOOL))
			->where($qb->expr()->eq('user_id', $qb->createNamedParameter($userId)));

		if ($exceptId !== null) {
			$qb->andWhere($qb->expr()->neq('id', $qb->createNamedParameter($exceptId, IQueryBuilder::PARAM_INT)));
		}

		$qb->executeStatement();
	}

	/**
	 * @throws Exception
	 */
	public function maxSortOrder(string $userId): int {
		$qb = $this->db->getQueryBuilder();
		$qb->select($qb->func()->max('sort_order'))
			->from($this->getTableName())
			->where($qb->expr()->eq('user_id', $qb->createNamedParameter($userId)));

		$result = $qb->executeQuery();
		$value = $result->fetchOne();
		$result->closeCursor();

		return $value === false || $value === null ? 0 : (int)$value;
	}

	/**
	 * @throws Exception
	 */
	public function deleteAllForUser(string $userId): void {
		$qb = $this->db->getQueryBuilder();
		$qb->delete($this->getTableName())
			->where($qb->expr()->eq('user_id', $qb->createNamedParameter($userId)));
		$qb->executeStatement();
	}
}
