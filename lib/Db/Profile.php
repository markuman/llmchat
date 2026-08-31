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
 * @method int getConnectionId()
 * @method void setConnectionId(int $connectionId)
 * @method string getName()
 * @method void setName(string $name)
 * @method string getModel()
 * @method void setModel(string $model)
 * @method string|null getSystemPrompt()
 * @method void setSystemPrompt(?string $systemPrompt)
 * @method float|null getTemperature()
 * @method void setTemperature(?float $temperature)
 * @method int|null getMaxTokens()
 * @method void setMaxTokens(?int $maxTokens)
 * @method bool getIsDefault()
 * @method void setIsDefault(bool $isDefault)
 * @method bool getStreaming()
 * @method void setStreaming(bool $streaming)
 * @method bool getReasoning()
 * @method void setReasoning(bool $reasoning)
 * @method string getEnabledTools()
 * @method void setEnabledTools(string $enabledTools)
 * @method bool getToolApproval()
 * @method void setToolApproval(bool $toolApproval)
 * @method int getSortOrder()
 * @method void setSortOrder(int $sortOrder)
 */
class Profile extends Entity implements \JsonSerializable {
	protected string $userId = '';
	protected int $connectionId = 0;
	protected string $name = '';
	protected string $model = '';
	protected ?string $systemPrompt = null;
	protected ?float $temperature = null;
	protected ?int $maxTokens = null;
	protected bool $isDefault = false;
	protected bool $streaming = true;
	/** true = leave the backend default alone, false = actively switch thinking off */
	protected bool $reasoning = true;
	/**
	 * Comma separated allowlist of tool ids, empty means no tools.
	 * Stored flat, exposed as an array — see TOOL_IDS for the valid values.
	 */
	protected string $enabledTools = '';
	/** ask before each tool call that reaches outside the browser */
	protected bool $toolApproval = true;
	protected int $sortOrder = 0;

	public function __construct() {
		$this->addType('userId', 'string');
		$this->addType('connectionId', 'integer');
		$this->addType('name', 'string');
		$this->addType('model', 'string');
		$this->addType('systemPrompt', 'string');
		$this->addType('temperature', 'float');
		$this->addType('maxTokens', 'integer');
		$this->addType('isDefault', 'boolean');
		$this->addType('streaming', 'boolean');
		$this->addType('reasoning', 'boolean');
		$this->addType('enabledTools', 'string');
		$this->addType('toolApproval', 'boolean');
		$this->addType('sortOrder', 'integer');
	}

	public function jsonSerialize(): array {
		return [
			'id' => $this->getId(),
			'connection_id' => $this->getConnectionId(),
			'name' => $this->getName(),
			'model' => $this->getModel(),
			'system_prompt' => $this->getSystemPrompt(),
			'temperature' => $this->getTemperature(),
			'max_tokens' => $this->getMaxTokens(),
			'is_default' => $this->getIsDefault(),
			'streaming' => $this->getStreaming(),
			'reasoning' => $this->getReasoning(),
			'enabled_tools' => $this->getEnabledToolsArray(),
			'tool_approval' => $this->getToolApproval(),
			'sort_order' => $this->getSortOrder(),
		];
	}

	/**
	 * @return string[]
	 */
	public function getEnabledToolsArray(): array {
		$raw = trim($this->getEnabledTools());
		if ($raw === '') {
			return [];
		}

		return array_values(array_filter(array_map('trim', explode(',', $raw))));
	}

	/**
	 * Export shape — deliberately without ids and without anything
	 * that touches the connection (spec §3.4).
	 */
	public function toExportArray(): array {
		return [
			'name' => $this->getName(),
			'model' => $this->getModel(),
			'system_prompt' => $this->getSystemPrompt(),
			'temperature' => $this->getTemperature(),
			'max_tokens' => $this->getMaxTokens(),
			'streaming' => $this->getStreaming(),
			'reasoning' => $this->getReasoning(),
			'enabled_tools' => $this->getEnabledToolsArray(),
			'tool_approval' => $this->getToolApproval(),
		];
	}
}
