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
 * @method string getPath()
 * @method void setPath(string $path)
 * @method int getMaxChars()
 * @method void setMaxChars(int $maxChars)
 * @method bool getRecapEnabled()
 * @method void setRecapEnabled(bool $recapEnabled)
 * @method int|null getRecapProfileId()
 * @method void setRecapProfileId(?int $recapProfileId)
 * @method bool getAutoCompact()
 * @method void setAutoCompact(bool $autoCompact)
 * @method int getCompactThreshold()
 * @method void setCompactThreshold(int $compactThreshold)
 * @method string getCreatedAt()
 * @method void setCreatedAt(string $createdAt)
 * @method string getUpdatedAt()
 * @method void setUpdatedAt(string $updatedAt)
 */
class MemoryProfile extends Entity implements \JsonSerializable {
	protected string $userId = '';
	protected string $name = '';
	/** relative to the user's home, always ends in .md */
	protected string $path = '';
	/** roughly 3k tokens; what goes into the system prompt at most */
	protected int $maxChars = 12000;
	protected bool $recapEnabled = true;
	/** null = the chat profile that produced the answer */
	protected ?int $recapProfileId = null;
	protected bool $autoCompact = false;
	/** percent of maxChars */
	protected int $compactThreshold = 80;
	protected string $createdAt = '';
	protected string $updatedAt = '';

	public function __construct() {
		$this->addType('userId', 'string');
		$this->addType('name', 'string');
		$this->addType('path', 'string');
		$this->addType('maxChars', 'integer');
		$this->addType('recapEnabled', 'boolean');
		$this->addType('recapProfileId', 'integer');
		$this->addType('autoCompact', 'boolean');
		$this->addType('compactThreshold', 'integer');
		$this->addType('createdAt', 'string');
		$this->addType('updatedAt', 'string');
	}

	public function jsonSerialize(): array {
		return [
			'id' => $this->getId(),
			'name' => $this->getName(),
			'path' => $this->getPath(),
			'max_chars' => $this->getMaxChars(),
			'recap_enabled' => $this->getRecapEnabled(),
			'recap_profile_id' => $this->getRecapProfileId(),
			'auto_compact' => $this->getAutoCompact(),
			'compact_threshold' => $this->getCompactThreshold(),
			'created_at' => $this->getCreatedAt(),
			'updated_at' => $this->getUpdatedAt(),
		];
	}
}
