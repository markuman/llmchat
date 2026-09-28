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
 * External MCP servers (issue #11).
 *
 * Unlike the LLM connections, nothing secret in here ever reaches the browser:
 * every MCP request goes through this server anyway (CORS leaves no choice),
 * so the tokens stay where they are used. Everything credential-shaped —
 * access and refresh token, client secret, the pending PKCE verifier — is
 * ICrypto-encrypted, hence TEXT rather than a sized string.
 *
 * `llm_` prefix like the other two tables rather than `llmchat_`: one naming
 * scheme per app is worth more than matching a sentence in an issue.
 */
class Version1009Date20260928120000 extends SimpleMigrationStep {
	/**
	 * @param Closure(): ISchemaWrapper $schemaClosure
	 */
	public function changeSchema(IOutput $output, Closure $schemaClosure, array $options): ?ISchemaWrapper {
		/** @var ISchemaWrapper $schema */
		$schema = $schemaClosure();

		if ($schema->hasTable('llm_mcp_servers')) {
			return null;
		}

		$table = $schema->createTable('llm_mcp_servers');
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
		// goes into every function name the model sees: mcp_{slug}_{tool}
		$table->addColumn('slug', Types::STRING, [
			'notnull' => true,
			'length' => 32,
		]);
		$table->addColumn('url', Types::STRING, [
			'notnull' => true,
			'length' => 1024,
		]);
		$table->addColumn('auth_type', Types::STRING, [
			'notnull' => true,
			'length' => 16,
			'default' => 'none',
		]);
		$table->addColumn('enabled', Types::BOOLEAN, [
			'notnull' => false,
			'default' => true,
		]);
		// public by definition, so stored in the clear
		$table->addColumn('client_id', Types::STRING, [
			'notnull' => false,
			'length' => 512,
		]);
		$table->addColumn('client_secret', Types::TEXT, [
			'notnull' => false,
		]);
		// for auth_type=bearer this is the static token / PAT
		$table->addColumn('access_token', Types::TEXT, [
			'notnull' => false,
		]);
		$table->addColumn('refresh_token', Types::TEXT, [
			'notnull' => false,
		]);
		$table->addColumn('token_expires_at', Types::BIGINT, [
			'notnull' => false,
			'length' => 20,
		]);
		// discovered endpoints, resource, scope, where the client id came from
		$table->addColumn('oauth_meta', Types::TEXT, [
			'notnull' => false,
		]);
		// state + PKCE verifier of a sign-in in progress, encrypted
		$table->addColumn('oauth_pending', Types::TEXT, [
			'notnull' => false,
		]);
		$table->addColumn('last_error', Types::STRING, [
			'notnull' => false,
			'length' => 512,
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
		$table->addIndex(['user_id'], 'llm_mcp_uid_idx');

		return $schema;
	}
}
