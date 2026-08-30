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
 * @method string getBaseUrl()
 * @method void setBaseUrl(string $baseUrl)
 * @method string|null getApiKey()
 * @method void setApiKey(?string $apiKey)
 * @method string getProviderHint()
 * @method void setProviderHint(string $providerHint)
 * @method string getCreatedAt()
 * @method void setCreatedAt(string $createdAt)
 * @method string getUpdatedAt()
 * @method void setUpdatedAt(string $updatedAt)
 */
class Connection extends Entity implements \JsonSerializable {
	protected string $userId = '';
	protected string $name = '';
	protected string $baseUrl = '';
	protected ?string $apiKey = null;
	protected string $providerHint = 'openai_compatible';
	protected string $createdAt = '';
	protected string $updatedAt = '';

	public function __construct() {
		$this->addType('userId', 'string');
		$this->addType('name', 'string');
		$this->addType('baseUrl', 'string');
		$this->addType('apiKey', 'string');
		$this->addType('providerHint', 'string');
		$this->addType('createdAt', 'string');
		$this->addType('updatedAt', 'string');
	}

	/**
	 * The API key is deliberately absent — see spec §10.
	 * Only `has_key` is exposed here; the decrypted key is added by the
	 * service layer for the initial state, where the browser actually needs it.
	 */
	public function jsonSerialize(): array {
		return [
			'id' => $this->getId(),
			'name' => $this->getName(),
			'base_url' => $this->getBaseUrl(),
			'has_key' => ($this->getApiKey() ?? '') !== '',
			'provider_hint' => $this->getProviderHint(),
			'created_at' => $this->getCreatedAt(),
			'updated_at' => $this->getUpdatedAt(),
		];
	}
}
