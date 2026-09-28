<?php

declare(strict_types=1);

/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\LlmChat\Service;

use OCA\LlmChat\Db\McpServer;
use OCA\LlmChat\Db\McpServerMapper;
use OCA\LlmChat\Exception\BadRequestException;
use OCA\LlmChat\Exception\McpAuthRequiredException;
use OCA\LlmChat\Exception\NotFoundException;
use OCA\LlmChat\Exception\OAuthException;
use OCP\AppFramework\Db\DoesNotExistException;
use OCP\AppFramework\Db\MultipleObjectsReturnedException;
use OCP\Http\Client\IClientService;
use OCP\Http\Client\IResponse;
use OCP\Http\Client\LocalServerException;
use OCP\IURLGenerator;
use OCP\Security\ICrypto;
use OCP\Security\ISecureRandom;
use Psr\Log\LoggerInterface;

/**
 * External MCP servers (issue #11): storage, OAuth, and the JSON-RPC proxy.
 *
 * Why a proxy at all, when everything else in this app goes out from the
 * browser: MCP servers, their `.well-known` documents and their token
 * endpoints almost never send CORS headers for a foreign origin. So the
 * browser speaks JSON-RPC to this class, and this class to the server — and
 * since the requests pass through here anyway, the tokens never leave. That
 * is the deliberate difference to the LLM keys, which have to be in the
 * browser because the LLM request is made there.
 *
 * What keeps this from becoming an open relay:
 *
 * - it only ever talks to the url the user registered, plus whatever that
 *   server's OAuth metadata names — never to a url from the request;
 * - only `initialize`, `notifications/initialized`, `ping`, `tools/list` and
 *   `tools/call` pass, everything else in MCP is out of scope and refused;
 * - every outbound url goes through OutboundUrlGuard and Nextcloud's HTTP
 *   client, which is the same SSRF protection `web_fetch` has — minus the
 *   standard-ports rule, since the user and not a model picked the url.
 *
 * Transport is Streamable HTTP only: stdio does not exist in a browser, and
 * the old HTTP+SSE transport is deprecated.
 */
class McpService {
	public const AUTH_TYPES = ['none', 'bearer', 'oauth'];
	public const MAX_SERVERS = 20;

	/** what `initialize` offers; the server may answer with an older one */
	public const PROTOCOL_VERSION = '2025-06-18';

	private const ALLOWED_METHODS = [
		'initialize',
		'notifications/initialized',
		'ping',
		'tools/list',
		'tools/call',
	];

	private const MAX_REQUEST_BYTES = 1024 * 1024;
	private const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
	private const MAX_METADATA_BYTES = 256 * 1024;
	/** a tool call may legitimately take a while — route planning, say */
	private const RPC_TIMEOUT = 120;
	private const METADATA_TIMEOUT = 15;
	/** how long a started sign-in stays valid */
	private const PENDING_TTL = 600;
	/** refresh this many seconds before the access token runs out */
	private const REFRESH_SKEW = 60;

	private const CLIENT_NAME = 'LLM Chat for Nextcloud';

	public function __construct(
		private McpServerMapper $mapper,
		private OutboundUrlGuard $guard,
		private IClientService $clientService,
		private ICrypto $crypto,
		private ISecureRandom $random,
		private IURLGenerator $urlGenerator,
		private LoggerInterface $logger,
	) {
	}

	// ------------------------------------------------------------ storage ----

	/**
	 * @return McpServer[]
	 */
	public function findAll(string $userId): array {
		return $this->mapper->findAllForUser($userId);
	}

	public function find(int $id, string $userId): McpServer {
		try {
			return $this->mapper->findForUser($id, $userId);
		} catch (DoesNotExistException|MultipleObjectsReturnedException) {
			throw new NotFoundException('mcp server not found');
		}
	}

	public function create(string $userId, array $data): McpServer {
		if (count($this->findAll($userId)) >= self::MAX_SERVERS) {
			throw new BadRequestException('at most ' . self::MAX_SERVERS . ' MCP servers per user');
		}

		$now = $this->now();
		$name = $this->requireName((string)($data['name'] ?? ''));

		$server = new McpServer();
		$server->setUserId($userId);
		$server->setName($name);
		$server->setSlug($this->uniqueSlug($userId, $name));
		$server->setUrl($this->normalizeUrl((string)($data['url'] ?? '')));
		$server->setAuthType($this->normalizeAuthType((string)($data['auth_type'] ?? 'none')));
		$server->setEnabled((bool)($data['enabled'] ?? true));
		$server->setClientId($this->nullableClientId($data['client_id'] ?? null));
		$server->setClientSecret($this->encrypt((string)($data['client_secret'] ?? '')));
		if ($server->getAuthType() === 'bearer') {
			$server->setAccessToken($this->encrypt((string)($data['token'] ?? '')));
		}
		$server->setCreatedAt($now);
		$server->setUpdatedAt($now);

		return $this->mapper->insert($server);
	}

	/**
	 * Absent keys leave a field alone, as with connections. The token and the
	 * client secret are never sent back, so the client cannot echo them.
	 *
	 * A new url, auth type or client id invalidates everything learned during
	 * sign-in: a token is bound to one server (RFC 8707) and to one client,
	 * so keeping it would only produce a confusing 401 later. The slug stays
	 * as it is on a rename — it is an identifier, not a label.
	 */
	public function update(int $id, string $userId, array $data): McpServer {
		$server = $this->find($id, $userId);

		if (array_key_exists('name', $data)) {
			$server->setName($this->requireName((string)$data['name']));
		}
		if (array_key_exists('enabled', $data)) {
			$server->setEnabled((bool)$data['enabled']);
		}

		$urlChanged = false;
		if (array_key_exists('url', $data)) {
			$url = $this->normalizeUrl((string)$data['url']);
			$urlChanged = $url !== $server->getUrl();
			$server->setUrl($url);
		}

		$typeChanged = false;
		if (array_key_exists('auth_type', $data)) {
			$type = $this->normalizeAuthType((string)$data['auth_type']);
			$typeChanged = $type !== $server->getAuthType();
			$server->setAuthType($type);
		}

		$clientChanged = false;
		$clientId = null;
		if (array_key_exists('client_id', $data)) {
			$clientId = $this->nullableClientId($data['client_id']);
			$clientChanged = $clientId !== $server->getClientId();
		}

		if ($urlChanged || $typeChanged || $clientChanged) {
			// a PAT survives a moved url, it belongs to the account and not
			// to one OAuth handshake
			$this->resetOAuth($server, $typeChanged || $server->getAuthType() === 'oauth');
		}
		if ($clientChanged) {
			$server->setClientId($clientId);
		}

		if (array_key_exists('client_secret', $data) && $data['client_secret'] !== null) {
			$server->setClientSecret($this->encrypt((string)$data['client_secret']));
		}
		if (array_key_exists('token', $data) && $data['token'] !== null && $server->getAuthType() === 'bearer') {
			$server->setAccessToken($this->encrypt((string)$data['token']));
			$server->setLastError(null);
		}

		$server->setUpdatedAt($this->now());

		return $this->mapper->update($server);
	}

	public function delete(int $id, string $userId): void {
		$this->mapper->delete($this->find($id, $userId));
	}

	/**
	 * Forgets the OAuth tokens; the registered client stays, so signing in
	 * again does not litter the authorization server with registrations.
	 */
	public function disconnect(int $id, string $userId): McpServer {
		$server = $this->find($id, $userId);
		$server->setAccessToken(null);
		$server->setRefreshToken(null);
		$server->setTokenExpiresAt(null);
		$server->setOauthPending(null);
		$server->setLastError(null);
		$server->setUpdatedAt($this->now());

		return $this->mapper->update($server);
	}

	// -------------------------------------------------------------- oauth ----

	/**
	 * Starts a sign-in: discovery, client registration if needed, PKCE.
	 * Returns the url the popup opens.
	 *
	 * Discovery runs every time rather than once: it is a handful of small
	 * GETs, and an authorization server that moved its endpoints should not
	 * need the user to delete and re-add the server.
	 *
	 * @return array{auth_url: string}
	 * @throws BadRequestException
	 */
	public function connect(int $id, string $userId): array {
		$server = $this->find($id, $userId);
		if ($server->getAuthType() !== 'oauth') {
			throw new BadRequestException('this server is not set up for OAuth');
		}

		$previous = $server->getMetaArray();
		$meta = $this->discover($server->getUrl());
		$redirectUri = $this->redirectUri();

		$clientId = (string)($server->getClientId() ?? '');
		$fromDcr = ($previous['client_source'] ?? '') === 'dcr';
		$meta['client_source'] = $clientId === '' ? null : ($fromDcr ? 'dcr' : 'manual');
		$meta['token_endpoint_auth_method'] = $previous['token_endpoint_auth_method'] ?? null;
		$meta['redirect_uri'] = $previous['redirect_uri'] ?? null;

		// A registered client belongs to one authorization server and one
		// redirect uri. If either changed — the instance moved, the server
		// switched its AS — the old registration is useless.
		$stale = $fromDcr && (
			($previous['issuer'] ?? '') !== $meta['issuer']
			|| ($previous['redirect_uri'] ?? '') !== $redirectUri
		);

		if ($clientId === '' || $stale) {
			if (($meta['registration_endpoint'] ?? null) === null) {
				$meta['needs_client_id'] = true;
				$this->saveMeta($server, $meta);
				throw new BadRequestException(
					'this server does not support dynamic client registration — register '
					. 'LLM Chat with its provider using the redirect URI ' . $redirectUri
					. ' and enter the client id here'
				);
			}

			$registration = $this->register($meta, $redirectUri);
			if ($registration === null) {
				$meta['needs_client_id'] = true;
				$this->saveMeta($server, $meta);
				throw new BadRequestException(
					'client registration at the authorization server failed — register LLM Chat '
					. 'manually using the redirect URI ' . $redirectUri . ' and enter the client id here'
				);
			}

			$server->setClientId($registration['client_id']);
			$server->setClientSecret($this->encrypt($registration['client_secret'] ?? ''));
			$meta['client_source'] = 'dcr';
			$meta['token_endpoint_auth_method'] = $registration['token_endpoint_auth_method'];
			$meta['redirect_uri'] = $redirectUri;
			$clientId = $registration['client_id'];
		}

		unset($meta['needs_client_id']);

		$state = $this->random->generate(43, ISecureRandom::CHAR_ALPHANUMERIC);
		$verifier = $this->random->generate(64, ISecureRandom::CHAR_ALPHANUMERIC);
		$challenge = rtrim(strtr(base64_encode(hash('sha256', $verifier, true)), '+/', '-_'), '=');

		$server->setOauthPending($this->crypto->encrypt((string)json_encode([
			'state' => $state,
			'verifier' => $verifier,
			'redirect_uri' => $redirectUri,
			'created' => time(),
		])));
		$this->saveMeta($server, $meta);

		$params = [
			'response_type' => 'code',
			'client_id' => $clientId,
			'redirect_uri' => $redirectUri,
			'code_challenge' => $challenge,
			'code_challenge_method' => 'S256',
			'state' => $state,
			// RFC 8707: the token is for this server and nothing else
			'resource' => $meta['resource'],
		];
		if (($meta['scope'] ?? '') !== '') {
			$params['scope'] = $meta['scope'];
		}

		$endpoint = (string)$meta['authorization_endpoint'];
		$glue = str_contains($endpoint, '?') ? '&' : '?';

		return ['auth_url' => $endpoint . $glue . http_build_query($params, '', '&', PHP_QUERY_RFC3986)];
	}

	/**
	 * The redirect target of the popup. `state` is the CSRF protection here —
	 * it is bound to one server row of the signed-in user and used once.
	 *
	 * @return array{ok: bool, server_id: int|null, name: string|null, message: string}
	 */
	public function handleCallback(string $userId, string $state, string $code, string $error, string $iss): array {
		$server = $this->findByState($userId, $state);
		if ($server === null) {
			return $this->callbackResult(false, null, 'unknown or expired sign-in attempt — start it again from the settings');
		}

		$pending = $this->decodePending($server);
		// single use, whatever happens next
		$server->setOauthPending(null);
		$server->setUpdatedAt($this->now());
		$this->mapper->update($server);

		if ($pending === null || time() - (int)($pending['created'] ?? 0) > self::PENDING_TTL) {
			return $this->callbackResult(false, $server, 'the sign-in took too long — start it again from the settings');
		}

		if ($error !== '') {
			return $this->callbackResult(false, $server, 'the provider refused: ' . mb_substr($error, 0, 200));
		}

		$meta = $server->getMetaArray();

		// RFC 9207: a response from a different authorization server than
		// the one we sent the user to is a mix-up attack, not a sign-in
		if ($iss !== '' && rtrim($iss, '/') !== rtrim((string)($meta['issuer'] ?? ''), '/')) {
			return $this->callbackResult(false, $server, 'the answer came from an unexpected authorization server');
		}

		if ($code === '') {
			return $this->callbackResult(false, $server, 'the provider sent no authorization code');
		}

		try {
			$tokens = $this->tokenRequest($server, $meta, [
				'grant_type' => 'authorization_code',
				'code' => $code,
				'redirect_uri' => (string)$pending['redirect_uri'],
				'code_verifier' => (string)$pending['verifier'],
			]);
		} catch (OAuthException|BadRequestException $e) {
			$server->setLastError(mb_substr($e->getMessage(), 0, 500));
			$this->mapper->update($server);

			return $this->callbackResult(false, $server, $e->getMessage());
		}

		$server->setRefreshToken(null);
		$this->storeTokens($server, $tokens);

		return $this->callbackResult(true, $server, 'connected');
	}

	// ---------------------------------------------------------------- rpc ----

	/**
	 * Forwards one JSON-RPC message to the server and returns its answer.
	 *
	 * The message arrives as the JSON string the browser built and leaves as
	 * exactly that string: decoding it into a PHP array and encoding it again
	 * would turn every `{}` in the tool arguments into `[]`, and a strict
	 * server rightly refuses an array where its schema says object. The same
	 * goes for the answer, which is decoded to objects, not arrays, so an
	 * empty `properties` in a tool schema survives the trip.
	 *
	 * @return array{ok: bool, reason?: string, message: mixed, session_id?: string|null}
	 * @throws BadRequestException
	 */
	public function rpc(int $id, string $userId, string $payload, ?string $sessionId): array {
		$server = $this->find($id, $userId);
		if (!$server->getEnabled()) {
			throw new BadRequestException('this MCP server is switched off');
		}

		[$method, $requestId] = $this->checkPayload($payload);
		$sessionId = $this->cleanSessionId($sessionId);
		$url = $this->guard->validate($server->getUrl(), false);

		try {
			$token = $this->accessTokenFor($server);
			$response = $this->postRpc($url, $payload, $token, $sessionId, $method);

			if ($response->getStatusCode() === 401 && $server->getAuthType() === 'oauth' && $this->refresh($server)) {
				$this->closeBody($response);
				$response = $this->postRpc($url, $payload, $this->accessTokenFor($server), $sessionId, $method);
			}

			if ($response->getStatusCode() === 401) {
				$this->closeBody($response);
				throw new McpAuthRequiredException($this->rejectedMessage($server));
			}
		} catch (McpAuthRequiredException $e) {
			return ['ok' => false, 'reason' => 'auth_required', 'message' => $e->getMessage()];
		} catch (BadRequestException $e) {
			$this->recordError($server, $e->getMessage());
			throw $e;
		}

		$status = $response->getStatusCode();
		$newSession = $this->cleanSessionId($response->getHeader('Mcp-Session-Id')) ?? $sessionId;

		// the spec's way of saying "that session is gone, initialize again"
		if ($status === 404 && $sessionId !== null) {
			$this->closeBody($response);

			return ['ok' => false, 'reason' => 'session_expired', 'message' => null];
		}

		if ($status === 202 || $status === 204) {
			$this->closeBody($response);

			return ['ok' => true, 'message' => null, 'session_id' => $newSession];
		}

		if ($status >= 400) {
			$excerpt = $this->errorExcerpt($this->readCapped($response->getBody(), 64 * 1024));
			$message = 'the MCP server answered with HTTP ' . $status . ($excerpt !== '' ? ': ' . $excerpt : '');
			$this->recordError($server, $message);
			throw new BadRequestException($message);
		}

		try {
			$message = $this->readMessage($response, $requestId);
		} catch (BadRequestException $e) {
			$this->recordError($server, $e->getMessage());
			throw $e;
		}

		if ($message === null && $requestId !== null) {
			$this->recordError($server, 'the MCP server closed the connection without answering');
			throw new BadRequestException('the MCP server closed the connection without answering');
		}

		if ($server->getLastError() !== null) {
			$server->setLastError(null);
			$this->mapper->update($server);
		}

		return ['ok' => true, 'message' => $message, 'session_id' => $newSession];
	}

	// ---------------------------------------------------- oauth internals ----

	/**
	 * RFC 9728 → RFC 8414, in the order the MCP authorization spec gives:
	 * ask the server, follow `resource_metadata` from its 401 (or guess the
	 * well-known location), read which authorization server it trusts, then
	 * read that server's metadata.
	 *
	 * @return array<string, mixed>
	 * @throws BadRequestException
	 */
	private function discover(string $serverUrl): array {
		$serverUrl = $this->guard->validate($serverUrl, false);
		$challenge = $this->probeChallenge($serverUrl);

		$candidates = [];
		if (($challenge['resource_metadata'] ?? '') !== '') {
			$candidates[] = $challenge['resource_metadata'];
		}
		array_push($candidates, ...$this->wellKnownUrls($serverUrl, 'oauth-protected-resource'));

		$prm = null;
		foreach ($candidates as $candidate) {
			$doc = $this->fetchJson($candidate);
			if ($doc !== null && is_array($doc['authorization_servers'] ?? null) && $doc['authorization_servers'] !== []) {
				$prm = $doc;
				break;
			}
		}

		// The resource the token will be bound to. Taken from the metadata
		// only when it is on the same origin as the server — a document that
		// claims to be about somebody else is not one to take a token
		// audience from.
		$resource = $serverUrl;
		if (is_string($prm['resource'] ?? null) && $this->sameOrigin($prm['resource'], $serverUrl)) {
			$resource = $prm['resource'];
		}

		// no protected resource metadata: the 2025-03-26 revision of the
		// spec, where the MCP server's own origin is the authorization server
		$issuer = $prm !== null ? (string)$prm['authorization_servers'][0] : $this->origin($serverUrl);
		$issuer = $this->guard->validate($issuer, false);

		$as = null;
		foreach ($this->authServerMetadataUrls($issuer) as $candidate) {
			$doc = $this->fetchJson($candidate);
			if ($doc === null || !is_string($doc['authorization_endpoint'] ?? null) || !is_string($doc['token_endpoint'] ?? null)) {
				continue;
			}
			// RFC 8414 §3.3: the document must be about the issuer we asked for
			if (isset($doc['issuer']) && rtrim((string)$doc['issuer'], '/') !== rtrim($issuer, '/')) {
				continue;
			}
			$as = $doc;
			break;
		}

		if ($as === null) {
			throw new BadRequestException('no OAuth metadata found for ' . $issuer . ' — does this server support OAuth at all? If it takes a personal access token, use "Token" instead.');
		}

		$methods = $as['code_challenge_methods_supported'] ?? null;
		if (is_array($methods) && !in_array('S256', $methods, true)) {
			throw new BadRequestException('the authorization server does not support PKCE with S256, which OAuth 2.1 requires');
		}

		// opened in the user's browser — anything but http(s) here would be
		// a javascript: url waiting to happen
		$authorize = (string)$as['authorization_endpoint'];
		if (!preg_match('#^https?://#i', $authorize)) {
			throw new BadRequestException('the authorization endpoint is not an http(s) url');
		}
		$token = $this->guard->validate((string)$as['token_endpoint'], false);
		$registration = is_string($as['registration_endpoint'] ?? null)
			? $this->guard->validate($as['registration_endpoint'], false)
			: null;

		$scope = $challenge['scope'] ?? '';
		if ($scope === '' && is_array($prm['scopes_supported'] ?? null)) {
			$scope = implode(' ', array_filter($prm['scopes_supported'], 'is_string'));
		}

		return [
			'issuer' => $issuer,
			'authorization_endpoint' => $authorize,
			'token_endpoint' => $token,
			'registration_endpoint' => $registration,
			'auth_methods' => is_array($as['token_endpoint_auth_methods_supported'] ?? null)
				? array_values(array_filter($as['token_endpoint_auth_methods_supported'], 'is_string'))
				: null,
			'resource' => $resource,
			'scope' => $scope,
		];
	}

	/**
	 * Asks the server without credentials and reads what its 401 says.
	 *
	 * @return array<string, string> the WWW-Authenticate parameters, lowercased keys
	 */
	private function probeChallenge(string $serverUrl): array {
		$probe = (string)json_encode([
			'jsonrpc' => '2.0',
			'id' => 0,
			'method' => 'initialize',
			'params' => [
				'protocolVersion' => self::PROTOCOL_VERSION,
				'capabilities' => new \stdClass(),
				'clientInfo' => ['name' => 'llmchat', 'version' => '1'],
			],
		]);

		$response = $this->postRpc($serverUrl, $probe, null, null, 'initialize', self::METADATA_TIMEOUT);
		$status = $response->getStatusCode();
		$header = $response->getHeader('WWW-Authenticate');
		$this->closeBody($response);

		return $status === 401 ? $this->parseChallenge($header) : [];
	}

	/**
	 * `Bearer resource_metadata="https://…", scope="a b"` → key/value pairs.
	 *
	 * @return array<string, string>
	 */
	private function parseChallenge(string $header): array {
		$params = [];
		if (preg_match_all('/([a-zA-Z_][a-zA-Z0-9_-]*)\s*=\s*(?:"((?:[^"\\\\]|\\\\.)*)"|([^\s,"]+))/', $header, $matches, PREG_SET_ORDER)) {
			foreach ($matches as $match) {
				$params[strtolower($match[1])] = isset($match[3]) && $match[3] !== ''
					? $match[3]
					: stripslashes($match[2]);
			}
		}

		return $params;
	}

	/**
	 * RFC 7591. Registered as a public client with PKCE when the server
	 * allows it — the secret would sit right here on the server and could be
	 * kept, but "none" is what every MCP authorization server supports.
	 *
	 * @param array<string, mixed> $meta
	 * @return array{client_id: string, client_secret?: string, token_endpoint_auth_method: string}|null
	 */
	private function register(array $meta, string $redirectUri): ?array {
		$supported = $meta['auth_methods'] ?? null;
		$method = 'none';
		if (is_array($supported) && !in_array('none', $supported, true)) {
			if (in_array('client_secret_basic', $supported, true)) {
				$method = 'client_secret_basic';
			} elseif (in_array('client_secret_post', $supported, true)) {
				$method = 'client_secret_post';
			}
		}

		$body = [
			'client_name' => self::CLIENT_NAME,
			'redirect_uris' => [$redirectUri],
			'grant_types' => ['authorization_code', 'refresh_token'],
			'response_types' => ['code'],
			'token_endpoint_auth_method' => $method,
		];
		if (($meta['scope'] ?? '') !== '') {
			$body['scope'] = $meta['scope'];
		}

		try {
			$response = $this->clientService->newClient()->post((string)$meta['registration_endpoint'], [
				'body' => json_encode($body),
				'headers' => ['Content-Type' => 'application/json', 'Accept' => 'application/json'],
				'timeout' => self::METADATA_TIMEOUT,
				'http_errors' => false,
				'stream' => true,
			]);
		} catch (\Exception $e) {
			$this->logger->info('llmchat mcp client registration failed', ['exception' => $e]);
			return null;
		}

		$status = $response->getStatusCode();
		$doc = json_decode($this->readCapped($response->getBody(), self::MAX_METADATA_BYTES), true);
		if ($status >= 300 || !is_array($doc) || !is_string($doc['client_id'] ?? null) || $doc['client_id'] === '') {
			$this->logger->info('llmchat mcp client registration refused', ['status' => $status]);
			return null;
		}

		$result = [
			'client_id' => $doc['client_id'],
			'token_endpoint_auth_method' => is_string($doc['token_endpoint_auth_method'] ?? null)
				? $doc['token_endpoint_auth_method']
				: $method,
		];
		if (is_string($doc['client_secret'] ?? null) && $doc['client_secret'] !== '') {
			$result['client_secret'] = $doc['client_secret'];
		}

		return $result;
	}

	/**
	 * One POST to the token endpoint, with client authentication the way the
	 * client was registered.
	 *
	 * @param array<string, mixed> $meta
	 * @param array<string, string> $params
	 * @return array<string, mixed> the token response
	 * @throws OAuthException
	 * @throws BadRequestException
	 */
	private function tokenRequest(McpServer $server, array $meta, array $params): array {
		$endpoint = $this->guard->validate((string)($meta['token_endpoint'] ?? ''), false);

		$params['client_id'] = (string)$server->getClientId();
		if (($meta['resource'] ?? '') !== '') {
			$params['resource'] = (string)$meta['resource'];
		}

		$headers = [
			'Content-Type' => 'application/x-www-form-urlencoded',
			'Accept' => 'application/json',
		];

		$secret = $this->decrypt($server->getClientSecret());
		if ($secret !== '') {
			$method = $meta['token_endpoint_auth_method'] ?? null;
			if ($method === null) {
				// manually entered client: basic is the RFC default, post
				// only if that is all the server takes
				$supported = $meta['auth_methods'] ?? null;
				$method = is_array($supported) && !in_array('client_secret_basic', $supported, true)
					&& in_array('client_secret_post', $supported, true)
					? 'client_secret_post'
					: 'client_secret_basic';
			}

			if ($method === 'client_secret_post') {
				$params['client_secret'] = $secret;
			} else {
				$headers['Authorization'] = 'Basic ' . base64_encode(
					rawurlencode((string)$server->getClientId()) . ':' . rawurlencode($secret)
				);
			}
		}

		try {
			$response = $this->clientService->newClient()->post($endpoint, [
				'body' => http_build_query($params, '', '&'),
				'headers' => $headers,
				'timeout' => self::METADATA_TIMEOUT,
				'http_errors' => false,
				'stream' => true,
			]);
		} catch (LocalServerException) {
			throw new BadRequestException('the token endpoint is on an address that is not allowed');
		} catch (\Exception $e) {
			$this->logger->info('llmchat mcp token request failed', ['exception' => $e]);
			throw new BadRequestException('the token endpoint could not be reached: ' . $this->safeMessage($e));
		}

		$status = $response->getStatusCode();
		$doc = json_decode($this->readCapped($response->getBody(), self::MAX_METADATA_BYTES), true);

		if ($status !== 200 || !is_array($doc) || !is_string($doc['access_token'] ?? null)) {
			$code = is_array($doc) && is_string($doc['error'] ?? null) ? $doc['error'] : '';
			$description = is_array($doc) && is_string($doc['error_description'] ?? null)
				? ' — ' . mb_substr($doc['error_description'], 0, 200)
				: '';

			throw new OAuthException(
				'the token endpoint refused (HTTP ' . $status . ($code !== '' ? ', ' . $code : '') . ')' . $description,
				$code,
			);
		}

		return $doc;
	}

	/**
	 * @param array<string, mixed> $tokens
	 */
	private function storeTokens(McpServer $server, array $tokens): void {
		$server->setAccessToken($this->encrypt((string)$tokens['access_token']));

		// OAuth 2.1 rotates refresh tokens for public clients: a new one
		// replaces the old, which is dead from now on. No new one means the
		// old one is still good.
		if (is_string($tokens['refresh_token'] ?? null) && $tokens['refresh_token'] !== '') {
			$server->setRefreshToken($this->encrypt($tokens['refresh_token']));
		}

		$expiresIn = $tokens['expires_in'] ?? null;
		$server->setTokenExpiresAt(is_numeric($expiresIn) ? time() + (int)$expiresIn : null);
		$server->setLastError(null);
		$server->setUpdatedAt($this->now());
		$this->mapper->update($server);
	}

	/**
	 * Swaps the refresh token for a new access token.
	 *
	 * Two chat requests can hit an expired token at the same moment, and
	 * with rotation only the first refresh succeeds — the second presents a
	 * token that was just retired. So a failure re-reads the row first: if
	 * somebody else refreshed in the meantime, that result is just as good.
	 */
	private function refresh(McpServer $server): bool {
		$refreshToken = $this->decrypt($server->getRefreshToken());
		$meta = $server->getMetaArray();
		if ($refreshToken === '' || ($meta['token_endpoint'] ?? '') === '') {
			return false;
		}

		try {
			$tokens = $this->tokenRequest($server, $meta, [
				'grant_type' => 'refresh_token',
				'refresh_token' => $refreshToken,
			]);
		} catch (OAuthException|BadRequestException $e) {
			$fresh = $this->find($server->getId(), $server->getUserId());
			if ($fresh->getRefreshToken() !== $server->getRefreshToken() && $fresh->hasToken()) {
				$server->setAccessToken($fresh->getAccessToken());
				$server->setRefreshToken($fresh->getRefreshToken());
				$server->setTokenExpiresAt($fresh->getTokenExpiresAt());

				return true;
			}

			if ($e instanceof OAuthException && $e->getErrorCode() === 'invalid_grant') {
				// the grant is dead — say so in the settings instead of
				// presenting the same corpse on every request
				$server->setAccessToken(null);
				$server->setRefreshToken(null);
				$server->setTokenExpiresAt(null);
				$server->setUpdatedAt($this->now());
				$this->mapper->update($server);
			}

			$this->logger->info('llmchat mcp token refresh failed', ['exception' => $e]);

			return false;
		}

		$this->storeTokens($server, $tokens);

		return true;
	}

	/**
	 * @throws McpAuthRequiredException
	 */
	private function accessTokenFor(McpServer $server): ?string {
		switch ($server->getAuthType()) {
			case 'bearer':
				$token = $this->decrypt($server->getAccessToken());
				if ($token === '') {
					throw new McpAuthRequiredException('no token is stored for "' . $server->getName() . '"');
				}

				return $token;
			case 'oauth':
				if (!$server->hasToken()) {
					throw new McpAuthRequiredException('"' . $server->getName() . '" is not signed in');
				}

				$expires = $server->getTokenExpiresAt();
				if ($expires !== null && $expires - self::REFRESH_SKEW < time() && !$this->refresh($server)) {
					throw new McpAuthRequiredException('the sign-in for "' . $server->getName() . '" has expired');
				}

				return $this->decrypt($server->getAccessToken());
			default:
				return null;
		}
	}

	private function rejectedMessage(McpServer $server): string {
		return match ($server->getAuthType()) {
			'bearer' => 'the server rejected the stored token for "' . $server->getName() . '"',
			'oauth' => 'the sign-in for "' . $server->getName() . '" is no longer valid',
			default => '"' . $server->getName() . '" requires authentication — set it to OAuth or Token in the settings',
		};
	}

	private function findByState(string $userId, string $state): ?McpServer {
		if ($state === '') {
			return null;
		}

		foreach ($this->findAll($userId) as $server) {
			$pending = $this->decodePending($server);
			if ($pending !== null && hash_equals((string)($pending['state'] ?? ''), $state)) {
				return $server;
			}
		}

		return null;
	}

	/**
	 * @return array<string, mixed>|null
	 */
	private function decodePending(McpServer $server): ?array {
		$raw = $this->decrypt($server->getOauthPending());
		if ($raw === '') {
			return null;
		}

		$decoded = json_decode($raw, true);

		return is_array($decoded) ? $decoded : null;
	}

	/**
	 * @return array{ok: bool, server_id: int|null, name: string|null, message: string}
	 */
	private function callbackResult(bool $ok, ?McpServer $server, string $message): array {
		return [
			'ok' => $ok,
			'server_id' => $server?->getId(),
			'name' => $server?->getName(),
			'message' => $message,
		];
	}

	/**
	 * @param array<string, mixed> $meta
	 */
	private function saveMeta(McpServer $server, array $meta): void {
		$server->setOauthMeta((string)json_encode($meta, JSON_UNESCAPED_SLASHES));
		$server->setUpdatedAt($this->now());
		$this->mapper->update($server);
	}

	private function resetOAuth(McpServer $server, bool $dropAccessToken): void {
		// a registration made by us is tied to the old setup; one the user
		// typed in is theirs to change
		if (($server->getMetaArray()['client_source'] ?? '') === 'dcr') {
			$server->setClientId(null);
			$server->setClientSecret(null);
		}

		$server->setRefreshToken(null);
		$server->setTokenExpiresAt(null);
		$server->setOauthMeta(null);
		$server->setOauthPending(null);
		$server->setLastError(null);
		if ($dropAccessToken) {
			$server->setAccessToken(null);
		}
	}

	private function redirectUri(): string {
		return $this->urlGenerator->linkToRouteAbsolute('llmchat.mcp.oauth_callback');
	}

	/**
	 * RFC 9728 §3.1 / RFC 8414 §3.1: the well-known segment goes between
	 * host and path, not at the end of the path.
	 *
	 * @return list<string>
	 */
	private function wellKnownUrls(string $url, string $name): array {
		$origin = $this->origin($url);
		$path = rtrim((string)parse_url($url, PHP_URL_PATH), '/');

		return $path !== ''
			? [$origin . '/.well-known/' . $name . $path, $origin . '/.well-known/' . $name]
			: [$origin . '/.well-known/' . $name];
	}

	/**
	 * @return list<string>
	 */
	private function authServerMetadataUrls(string $issuer): array {
		$origin = $this->origin($issuer);
		$path = rtrim((string)parse_url($issuer, PHP_URL_PATH), '/');

		if ($path === '') {
			return [
				$origin . '/.well-known/oauth-authorization-server',
				$origin . '/.well-known/openid-configuration',
			];
		}

		return [
			$origin . '/.well-known/oauth-authorization-server' . $path,
			$origin . '/.well-known/openid-configuration' . $path,
			$origin . $path . '/.well-known/openid-configuration',
		];
	}

	/**
	 * @return array<string, mixed>|null
	 */
	private function fetchJson(string $url): ?array {
		try {
			$url = $this->guard->validate($url, false);
			$response = $this->clientService->newClient()->get($url, [
				'headers' => ['Accept' => 'application/json', 'MCP-Protocol-Version' => self::PROTOCOL_VERSION],
				'timeout' => self::METADATA_TIMEOUT,
				'http_errors' => false,
				'stream' => true,
			]);
		} catch (\Exception $e) {
			$this->logger->debug('llmchat mcp metadata fetch failed', ['url' => $url, 'exception' => $e]);
			return null;
		}

		if ($response->getStatusCode() !== 200) {
			$this->closeBody($response);
			return null;
		}

		$doc = json_decode($this->readCapped($response->getBody(), self::MAX_METADATA_BYTES), true);

		return is_array($doc) ? $doc : null;
	}

	// ------------------------------------------------------ rpc internals ----

	/**
	 * @return array{0: string, 1: int|string|null} method and request id
	 * @throws BadRequestException
	 */
	private function checkPayload(string $payload): array {
		if ($payload === '' || strlen($payload) > self::MAX_REQUEST_BYTES) {
			throw new BadRequestException('invalid MCP message');
		}

		$message = json_decode($payload, false);
		if (!$message instanceof \stdClass
			|| ($message->jsonrpc ?? null) !== '2.0'
			|| !is_string($message->method ?? null)) {
			throw new BadRequestException('invalid MCP message');
		}

		if (!in_array($message->method, self::ALLOWED_METHODS, true)) {
			throw new BadRequestException('MCP method not supported: ' . mb_substr($message->method, 0, 64));
		}

		$id = $message->id ?? null;
		if ($id !== null && !is_int($id) && !is_string($id)) {
			throw new BadRequestException('invalid MCP message id');
		}

		return [$message->method, $id];
	}

	/**
	 * Streamable HTTP: POST, accept both JSON and an SSE stream, carry the
	 * session id and the negotiated protocol version once there is one.
	 */
	private function postRpc(
		string $url,
		string $body,
		?string $token,
		?string $sessionId,
		string $method,
		int $timeout = self::RPC_TIMEOUT,
	): IResponse {
		$headers = [
			'Content-Type' => 'application/json',
			'Accept' => 'application/json, text/event-stream',
		];
		if ($method !== 'initialize') {
			$headers['MCP-Protocol-Version'] = self::PROTOCOL_VERSION;
		}
		if ($sessionId !== null) {
			$headers['Mcp-Session-Id'] = $sessionId;
		}
		if ($token !== null && $token !== '') {
			$headers['Authorization'] = 'Bearer ' . $token;
		}

		try {
			return $this->clientService->newClient()->post($url, [
				'body' => $body,
				'headers' => $headers,
				'timeout' => $timeout,
				'http_errors' => false,
				// streamed: an SSE answer may carry progress events first,
				// and the size cap has to apply while reading
				'stream' => true,
			]);
		} catch (LocalServerException) {
			// no detail on purpose: do not leak which internal hosts exist
			throw new BadRequestException('this address is not allowed');
		} catch (\Exception $e) {
			$this->logger->info('llmchat mcp request failed', ['exception' => $e]);
			throw new BadRequestException('the MCP server could not be reached: ' . $this->safeMessage($e));
		}
	}

	/**
	 * @param int|string|null $requestId
	 * @throws BadRequestException
	 */
	private function readMessage(IResponse $response, $requestId): mixed {
		$contentType = strtolower($response->getHeader('Content-Type'));

		if (str_starts_with($contentType, 'text/event-stream')) {
			return $this->readSse($response->getBody(), $requestId);
		}

		$raw = $this->readCapped($response->getBody(), self::MAX_RESPONSE_BYTES);
		if (trim($raw) === '') {
			return null;
		}

		$decoded = json_decode($raw, false);
		if (is_array($decoded)) {
			// a batch; we never send one, but take the answer out of it
			foreach ($decoded as $entry) {
				if ($this->answers($entry, $requestId)) {
					return $entry;
				}
			}

			return null;
		}

		if (!$decoded instanceof \stdClass) {
			throw new BadRequestException('the MCP server did not answer with JSON');
		}

		return $decoded;
	}

	/**
	 * Reads an SSE stream until the event that answers our request, then
	 * stops. Anything else on the stream — progress, log messages, requests
	 * from the server for sampling or elicitation — is out of scope and
	 * skipped.
	 *
	 * @param resource|string|null $body
	 * @param int|string|null $requestId
	 * @throws BadRequestException
	 */
	private function readSse($body, $requestId): ?\stdClass {
		if (is_string($body)) {
			$stream = fopen('php://memory', 'r+');
			if ($stream === false) {
				return null;
			}
			fwrite($stream, $body);
			rewind($stream);
			$body = $stream;
		}
		if (!is_resource($body)) {
			return null;
		}

		$deadline = time() + self::RPC_TIMEOUT;
		$buffer = '';
		$total = 0;

		try {
			while (!feof($body) && time() < $deadline) {
				$chunk = fread($body, 8192);
				if ($chunk === false) {
					break;
				}
				if ($chunk === '') {
					usleep(20000);
					continue;
				}

				$total += strlen($chunk);
				if ($total > self::MAX_RESPONSE_BYTES) {
					throw new BadRequestException('the MCP server answer is too large');
				}

				$buffer .= str_replace("\r\n", "\n", $chunk);
				while (($pos = strpos($buffer, "\n\n")) !== false) {
					$event = substr($buffer, 0, $pos);
					$buffer = substr($buffer, $pos + 2);

					$message = $this->parseSseEvent($event);
					if ($this->answers($message, $requestId)) {
						return $message;
					}
				}
			}

			// a final event without the blank line after it
			$message = $this->parseSseEvent($buffer);

			return $this->answers($message, $requestId) ? $message : null;
		} finally {
			fclose($body);
		}
	}

	private function parseSseEvent(string $event): ?\stdClass {
		$data = [];
		foreach (explode("\n", $event) as $line) {
			if (str_starts_with($line, 'data:')) {
				$value = substr($line, 5);
				$data[] = str_starts_with($value, ' ') ? substr($value, 1) : $value;
			}
		}

		if ($data === []) {
			return null;
		}

		$decoded = json_decode(implode("\n", $data), false);

		return $decoded instanceof \stdClass ? $decoded : null;
	}

	/**
	 * @param int|string|null $requestId
	 */
	private function answers(mixed $message, $requestId): bool {
		if (!$message instanceof \stdClass || !property_exists($message, 'id')) {
			return false;
		}
		if (!property_exists($message, 'result') && !property_exists($message, 'error')) {
			return false;
		}

		// loose on purpose: an id we sent as 1 may come back as "1"
		return $requestId === null || $message->id == $requestId;
	}

	private function errorExcerpt(string $body): string {
		$decoded = json_decode($body, true);
		if (is_array($decoded)) {
			$message = $decoded['error']['message'] ?? $decoded['error_description'] ?? $decoded['message'] ?? $decoded['error'] ?? null;
			if (is_string($message)) {
				return mb_substr($message, 0, 200);
			}
		}

		$text = trim(preg_replace('/\s+/', ' ', strip_tags($body)) ?? '');

		return mb_substr($text, 0, 200);
	}

	private function recordError(McpServer $server, string $message): void {
		$message = mb_substr($message, 0, 500);
		if ($server->getLastError() === $message) {
			return;
		}

		$server->setLastError($message);
		$this->mapper->update($server);
	}

	/**
	 * Visible ASCII only, per the spec — and never a header injection.
	 */
	private function cleanSessionId(?string $sessionId): ?string {
		if ($sessionId === null || $sessionId === '') {
			return null;
		}

		return preg_match('/^[\x21-\x7E]{1,256}$/', $sessionId) === 1 ? $sessionId : null;
	}

	// ------------------------------------------------------------ helpers ----

	/**
	 * @param resource|string|null $body
	 */
	private function readCapped($body, int $max): string {
		if (is_string($body)) {
			return substr($body, 0, $max);
		}
		if (!is_resource($body)) {
			return '';
		}

		$data = '';
		while (!feof($body) && strlen($data) < $max) {
			$chunk = fread($body, 64 * 1024);
			if ($chunk === false || $chunk === '') {
				break;
			}
			$data .= $chunk;
		}
		fclose($body);

		return substr($data, 0, $max);
	}

	private function closeBody(IResponse $response): void {
		$body = $response->getBody();
		if (is_resource($body)) {
			fclose($body);
		}
	}

	private function origin(string $url): string {
		$parts = parse_url($url);
		$origin = strtolower($parts['scheme'] ?? 'https') . '://' . strtolower($parts['host'] ?? '');
		if (isset($parts['port'])) {
			$origin .= ':' . $parts['port'];
		}

		return $origin;
	}

	private function sameOrigin(string $a, string $b): bool {
		return $this->origin($a) === $this->origin($b);
	}

	private function normalizeUrl(string $url): string {
		$url = UrlHelper::normalizeBaseUrl($url);
		if (strlen($url) > 1024) {
			throw new BadRequestException('url is too long');
		}

		// fail at save time rather than on the first chat
		return $this->guard->validate($url, false, 'this Nextcloud instance cannot be used as an MCP server here');
	}

	private function normalizeAuthType(string $type): string {
		return in_array($type, self::AUTH_TYPES, true) ? $type : 'none';
	}

	private function nullableClientId(mixed $value): ?string {
		if ($value === null) {
			return null;
		}
		$value = trim((string)$value);

		return $value === '' ? null : mb_substr($value, 0, 512);
	}

	private function requireName(string $name): string {
		$name = trim($name);
		if ($name === '') {
			throw new BadRequestException('name must not be empty');
		}

		return mb_substr($name, 0, 128);
	}

	/**
	 * Short, lowercase, alphanumeric, unique per user: it ends up inside
	 * every function name the model sees (`mcp_{slug}_{tool}`), and those
	 * are capped at 64 characters by the OpenAI API.
	 */
	private function uniqueSlug(string $userId, string $name): string {
		$base = substr((string)preg_replace('/[^a-z0-9]+/', '', strtolower($name)), 0, 12);
		if ($base === '') {
			$base = 'server';
		}

		$taken = array_map(static fn (McpServer $s) => $s->getSlug(), $this->findAll($userId));
		$slug = $base;
		for ($i = 2; in_array($slug, $taken, true); $i++) {
			$slug = $base . $i;
		}

		return $slug;
	}

	private function encrypt(string $plain): ?string {
		return $plain === '' ? null : $this->crypto->encrypt($plain);
	}

	private function decrypt(?string $encrypted): string {
		if ($encrypted === null || $encrypted === '') {
			return '';
		}

		try {
			return $this->crypto->decrypt($encrypted);
		} catch (\Throwable $e) {
			$this->logger->warning('could not decrypt mcp credential', ['exception' => $e]);
			return '';
		}
	}

	private function safeMessage(\Exception $e): string {
		$message = strtok($e->getMessage(), "\n");

		return $message === false ? 'unknown error' : mb_substr($message, 0, 200);
	}

	private function now(): string {
		return (new \DateTimeImmutable())->format(\DateTimeInterface::ATOM);
	}
}
