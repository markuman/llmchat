<?php
declare(strict_types=1);
/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Issue #11: the page the OAuth popup lands on. The script tells the settings
 * tab over a BroadcastChannel and closes the window; without JavaScript the
 * text below still says what happened.
 *
 * @var array $_
 */
?>
<div id="llmchat-oauth"
	class="guest-box"
	data-ok="<?php p($_['ok'] ? '1' : '0'); ?>"
	data-server-id="<?php p((string)($_['server_id'] ?? '')); ?>"
	data-message="<?php p($_['message']); ?>">
	<h2>
		<?php if ($_['ok']): ?>
			<?php p($l->t('Connected to %s', [(string)$_['name']])); ?>
		<?php else: ?>
			<?php p($l->t('Sign-in failed')); ?>
		<?php endif; ?>
	</h2>
	<p>
		<?php if ($_['ok']): ?>
			<?php p($l->t('You can close this window. The tools of this server are offered from the next message on.')); ?>
		<?php else: ?>
			<?php p($_['message']); ?>
		<?php endif; ?>
	</p>
</div>
