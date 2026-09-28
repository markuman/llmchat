<?php

declare(strict_types=1);

/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\LlmChat\Db;

use OCP\AppFramework\Db\Entity;

/**
 * @method string getUserId()
 * @method void setUserId(string $userId)
 * @method string getName()
 * @method void setName(string $name)
 * @method string getSlug()
 * @method void setSlug(string $slug)
 * @method string getUrl()
 * @method void setUrl(string $url)
 * @method string getAuthType()
 * @method void setAuthType(string $authType)
 * @method bool getEnabled()
 * @method void setEnabled(bool $enabled)
 * @method string|null getClientId()
 * @method void setClientId(?string $clientId)
 * @method string|null getClientSecret()
 * @method void setClientSecret(?string $clientSecret)
 * @method string|null getAccessToken()
 * @method void setAccessToken(?string $accessToken)
 * @method string|null getRefreshToken()
 * @method void setRefreshToken(?string $refreshToken)
 * @method int|null getTokenExpiresAt()
 * @method void setTokenExpiresAt(?int $tokenExpiresAt)
 * @method string|null getOauthMeta()
 * @method void setOauthMeta(?string $oauthMeta)
 * @method string|null getOauthPending()
 * @method void setOauthPending(?string $oauthPending)
 * @method string|null getLastError()
 * @method void setLastError(?string $lastError)
 * @method string getCreatedAt()
 * @method void setCreatedAt(string $createdAt)
 * @method string getUpdatedAt()
 * @method void setUpdatedAt(string $updatedAt)
 */
class McpServer extends Entity implements \JsonSerializable {
	protected string $userId = '';
	protected string $name = '';
	protected string $slug = '';
	protected string $url = '';
	/** none | bearer | oauth */
	protected string $authType = 'none';
	protected bool $enabled = true;
	protected ?string $clientId = null;
	/** encrypted */
	protected ?string $clientSecret = null;
	/** encrypted; the PAT for auth_type=bearer */
	protected ?string $accessToken = null;
	/** encrypted */
	protected ?string $refreshToken = null;
	/** unix timestamp, null = unknown / does not expire */
	protected ?int $tokenExpiresAt = null;
	/** JSON, see McpService::discover() */
	protected ?string $oauthMeta = null;
	/** encrypted JSON {state, verifier, redirect_uri, created} */
	protected ?string $oauthPending = null;
	protected ?string $lastError = null;
	protected string $createdAt = '';
	protected string $updatedAt = '';

	public function __construct() {
		$this->addType('userId', 'string');
		$this->addType('name', 'string');
		$this->addType('slug', 'string');
		$this->addType('url', 'string');
		$this->addType('authType', 'string');
		$this->addType('enabled', 'boolean');
		$this->addType('clientId', 'string');
		$this->addType('clientSecret', 'string');
		$this->addType('accessToken', 'string');
		$this->addType('refreshToken', 'string');
		$this->addType('tokenExpiresAt', 'integer');
		$this->addType('oauthMeta', 'string');
		$this->addType('oauthPending', 'string');
		$this->addType('lastError', 'string');
		$this->addType('createdAt', 'string');
		$this->addType('updatedAt', 'string');
	}

	/**
	 * @return array<string, mixed>
	 */
	public function getMetaArray(): array {
		$raw = $this->getOauthMeta();
		if ($raw === null || $raw === '') {
			return [];
		}

		$decoded = json_decode($raw, true);

		return is_array($decoded) ? $decoded : [];
	}

	public function hasToken(): bool {
		return ($this->getAccessToken() ?? '') !== '';
	}

	/**
	 * What the settings badge shows. Derived rather than stored, so it cannot
	 * disagree with the columns it describes.
	 */
	public function getAuthState(): string {
		return match ($this->getAuthType()) {
			'bearer' => $this->hasToken() ? 'ready' : 'needs_token',
			'oauth' => $this->hasToken()
				? 'connected'
				: (($this->getMetaArray()['needs_client_id'] ?? false) ? 'needs_client_id' : 'needs_auth'),
			default => 'ready',
		};
	}

	/**
	 * Never a token, never the client secret, never the pending verifier —
	 * issue #11: the browser has no use for any of them, since every MCP
	 * request goes through the proxy. `has_token` and `auth_state` are all
	 * the settings need.
	 */
	public function jsonSerialize(): array {
		return [
			'id' => $this->getId(),
			'name' => $this->getName(),
			'slug' => $this->getSlug(),
			'url' => $this->getUrl(),
			'auth_type' => $this->getAuthType(),
			'enabled' => $this->getEnabled(),
			'client_id' => $this->getClientId(),
			'client_id_source' => $this->getMetaArray()['client_source'] ?? null,
			'has_client_secret' => ($this->getClientSecret() ?? '') !== '',
			'has_token' => $this->hasToken(),
			'token_expires_at' => $this->getTokenExpiresAt(),
			'auth_state' => $this->getAuthState(),
			'last_error' => $this->getLastError(),
			'created_at' => $this->getCreatedAt(),
			'updated_at' => $this->getUpdatedAt(),
		];
	}
}
