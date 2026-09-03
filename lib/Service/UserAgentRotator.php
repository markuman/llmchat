<?php

declare(strict_types=1);

/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\LlmChat\Service;

use OCP\ICacheFactory;
use OCP\IMemcache;

/**
 * Round-robin over a list of user agents.
 *
 * The counter lives in the distributed cache so the rotation actually
 * rotates across PHP-FPM workers. Without shared state every worker would
 * start at 0 and "rotation" would mostly serve the first entry. If no cache
 * is configured, falls back to random pick — still a rotation, just without
 * the strict round-robin order.
 */
class UserAgentRotator {
	private const CACHE_KEY = 'llmchat_ua_counter';

	public function __construct(
		private ICacheFactory $cacheFactory,
	) {
	}

	/**
	 * @param string[] $agents
	 */
	public function next(array $agents): string {
		if ($agents === []) {
			return 'Mozilla/5.0';
		}

		$cache = $this->cacheFactory->isAvailable()
			? $this->cacheFactory->createDistributed('llmchat')
			: null;

		// atomic add()/inc() are IMemcache, not plain ICache — a backend
		// without them would fatal here instead of rotating
		if ($cache instanceof IMemcache) {
			// add() is atomic: only the first worker creates the key
			$cache->add(self::CACHE_KEY, 0);
			$counter = $cache->inc(self::CACHE_KEY);
			if (is_int($counter)) {
				return $agents[$counter % count($agents)];
			}
		}

		return $agents[random_int(0, count($agents) - 1)];
	}
}
