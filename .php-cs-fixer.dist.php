<?php

declare(strict_types=1);

/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

require_once __DIR__ . '/vendor/autoload.php';

$config = new Nextcloud\CodingStandard\Config();
$config
	->getFinder()
	->in(__DIR__ . '/appinfo')
	->in(__DIR__ . '/lib');

return $config;
