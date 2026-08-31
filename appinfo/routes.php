<?php

declare(strict_types=1);

/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

return [
	'routes' => [
		['name' => 'page#index', 'url' => '/', 'verb' => 'GET'],

		// connections
		['name' => 'connections#index', 'url' => '/api/v1/connections', 'verb' => 'GET'],
		['name' => 'connections#create', 'url' => '/api/v1/connections', 'verb' => 'POST'],
		['name' => 'connections#update', 'url' => '/api/v1/connections/{id}', 'verb' => 'PUT',
			'requirements' => ['id' => '\d+']],
		['name' => 'connections#destroy', 'url' => '/api/v1/connections/{id}', 'verb' => 'DELETE',
			'requirements' => ['id' => '\d+']],

		// profiles — the literal routes come first so that `reorder` and
		// `import` can never be swallowed by the `{id}` pattern
		['name' => 'profiles#reorder', 'url' => '/api/v1/profiles/reorder', 'verb' => 'POST'],
		['name' => 'profiles#import', 'url' => '/api/v1/profiles/import', 'verb' => 'POST'],
		['name' => 'profiles#index', 'url' => '/api/v1/profiles', 'verb' => 'GET'],
		['name' => 'profiles#create', 'url' => '/api/v1/profiles', 'verb' => 'POST'],
		['name' => 'profiles#update', 'url' => '/api/v1/profiles/{id}', 'verb' => 'PUT',
			'requirements' => ['id' => '\d+']],
		['name' => 'profiles#destroy', 'url' => '/api/v1/profiles/{id}', 'verb' => 'DELETE',
			'requirements' => ['id' => '\d+']],
		['name' => 'profiles#duplicate', 'url' => '/api/v1/profiles/{id}/duplicate', 'verb' => 'POST',
			'requirements' => ['id' => '\d+']],

		// archive
		['name' => 'archive#store', 'url' => '/api/v1/archive', 'verb' => 'POST'],

		// agent tools — only fetching needs the server; search goes from the
		// browser straight to SearXNG. POST on purpose: the url lands in the
		// body instead of the access log, the CSRF check applies, and there is
		// no cacheable GET with attacker-controlled parameters
		['name' => 'tools#fetch', 'url' => '/api/v1/tools/fetch', 'verb' => 'POST'],

		// settings
		['name' => 'settings#show', 'url' => '/api/v1/settings', 'verb' => 'GET'],
		['name' => 'settings#update', 'url' => '/api/v1/settings', 'verb' => 'PUT'],
	],
];
