<?php
/**
 * LLM-assisted debugging instrumentation snippet — network mode.
 *
 * Self-contained — uses only ext-curl (curl_multi for parallel probe).
 * Fire-and-forget: every log call posts JSON to the dashboard with short
 * timeouts and never blocks the caller materially. Targets are probed in
 * parallel on the first call; first 200 wins and is reused thereafter.
 *
 * Edit HOSTS to point at the dashboard. The `tools debugging-master start`
 * command auto-substitutes `__LAN_IP__` with the detected local IP.
 *
 * Usage:
 *   require_once __DIR__ . '/llm-log.php';
 *   LlmLog::session('my-feature');
 *   LlmLog::info('request received', ['url' => $_SERVER['REQUEST_URI']]);
 */

class LlmLog
{
	// ─── Config ──────────────────────────────────────────────────────────
	private const HOSTS = ['__LAN_IP__', '127.0.0.1', 'localhost'];
	private const PORT = 7243;
	private const TIMEOUT_MS = 2000;
	// ─────────────────────────────────────────────────────────────────────

	/** @var array<string, float> */
	private static array $timers = [];
	private static string $currentSession = 'default';
	private static bool $captureStackByDefault = true;
	private static ?string $resolvedBase = null;
	private static bool $probed = false;
	private static bool $reportedUnreachable = false;

	private static function resolveBase(): ?string
	{
		if (self::$resolvedBase !== null) return self::$resolvedBase;
		if (self::$probed) return null;
		self::$probed = true;

		$candidates = array_values(array_filter(self::HOSTS, fn($h) => $h !== '' && !str_starts_with($h, '__')));
		$mh = curl_multi_init();
		/** @var array<int, array{ch: \CurlHandle, base: string}> $entries */
		$entries = [];
		foreach ($candidates as $host) {
			$base = "http://$host:" . self::PORT;
			$ch = curl_init("$base/health");
			curl_setopt_array($ch, [
				CURLOPT_NOBODY => true,
				CURLOPT_RETURNTRANSFER => true,
				CURLOPT_TIMEOUT_MS => self::TIMEOUT_MS,
				CURLOPT_CONNECTTIMEOUT_MS => self::TIMEOUT_MS,
				CURLOPT_NOSIGNAL => true,
			]);
			curl_multi_add_handle($mh, $ch);
			$entries[spl_object_id($ch)] = ['ch' => $ch, 'base' => $base];
		}

		$winner = null;
		$running = null;
		do {
			curl_multi_exec($mh, $running);
			while ($info = curl_multi_info_read($mh)) {
				$id = spl_object_id($info['handle']);
				if ($winner === null
					&& $info['result'] === CURLE_OK
					&& curl_getinfo($info['handle'], CURLINFO_HTTP_CODE) === 200
				) {
					$winner = $entries[$id]['base'] ?? null;
				}
			}
			if ($winner !== null) break;
			if ($running) curl_multi_select($mh, 0.1);
		} while ($running > 0);

		foreach ($entries as $e) {
			curl_multi_remove_handle($mh, $e['ch']);
		}
		curl_multi_close($mh);

		if ($winner === null) {
			fwrite(STDERR, "[dbg] ingest unreachable on " . implode(', ', $candidates) . ":" . self::PORT . "\n");
			return null;
		}
		return self::$resolvedBase = $winner;
	}

	private static function send(array $entry): void
	{
		$base = self::resolveBase();
		if ($base === null) return;
		$url = $base . '/log/' . rawurlencode(self::$currentSession);
		try {
			$json = json_encode($entry, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR);
		} catch (\Throwable $e) {
			$json = json_encode(['level' => 'error', 'msg' => 'serialize_failed: ' . $e->getMessage()]);
		}

		$ch = curl_init($url);
		curl_setopt_array($ch, [
			CURLOPT_POST => true,
			CURLOPT_POSTFIELDS => $json,
			CURLOPT_HTTPHEADER => ['Content-Type: application/json'],
			CURLOPT_TIMEOUT_MS => self::TIMEOUT_MS,
			CURLOPT_CONNECTTIMEOUT_MS => self::TIMEOUT_MS,
			CURLOPT_RETURNTRANSFER => true,
			CURLOPT_NOSIGNAL => true,
		]);
		curl_exec($ch);
		if (curl_errno($ch) && !self::$reportedUnreachable) {
			self::$reportedUnreachable = true;
			fwrite(STDERR, "[dbg] ingest failed: " . curl_error($ch) . "\n");
		}
	}

	private static function captureStack(): string
	{
		$trace = debug_backtrace(DEBUG_BACKTRACE_IGNORE_ARGS);
		$lines = [];
		foreach ($trace as $frame) {
			if (($frame['class'] ?? '') === self::class) continue;
			$file = $frame['file'] ?? 'unknown';
			$line = $frame['line'] ?? 0;
			$fn = (($frame['class'] ?? '') !== '' ? $frame['class'] . ($frame['type'] ?? '::') : '') . ($frame['function'] ?? '?');
			$lines[] = "  at $fn ($file:$line)";
		}
		return implode("\n", $lines);
	}

	/** @return array{file: string, line: int} */
	private static function getCallerLocation(): array
	{
		foreach (debug_backtrace(DEBUG_BACKTRACE_IGNORE_ARGS) as $frame) {
			if (($frame['class'] ?? '') === self::class) continue;
			return ['file' => $frame['file'] ?? 'unknown', 'line' => $frame['line'] ?? 0];
		}
		return ['file' => 'unknown', 'line' => 0];
	}

	/** @param string|array<string, mixed>|null $opts */
	private static function normalizeOpts(string|array|null $opts): array
	{
		if ($opts === null) return [];
		if (is_string($opts)) return ['h' => $opts];
		return $opts;
	}

	/**
	 * @param array<string, mixed> $entry
	 * @param array<string, mixed> $opts
	 */
	private static function emit(array $entry, array $opts = []): void
	{
		$caller = self::getCallerLocation();
		$entry['ts'] = (int)(microtime(true) * 1000);
		$entry['file'] = $caller['file'];
		$entry['line'] = $caller['line'];

		if (isset($opts['h']) && !isset($entry['h'])) {
			$entry['h'] = $opts['h'];
		}

		$wantStack = self::$captureStackByDefault;
		if (array_key_exists('stack', $opts)) {
			$wantStack = $opts['stack'] !== false;
		}
		if (!isset($entry['stack'])) {
			if (is_string($opts['stack'] ?? null)) {
				$entry['stack'] = $opts['stack'];
			} elseif ($wantStack) {
				$entry['stack'] = self::captureStack();
			}
		}

		self::send($entry);
	}

	public static function session(string $name): void
	{
		self::$currentSession = $name;
	}

	/** @param array{captureStackByDefault?: bool} $opts */
	public static function configure(array $opts): void
	{
		if (isset($opts['captureStackByDefault'])) {
			self::$captureStackByDefault = (bool)$opts['captureStackByDefault'];
		}
	}

	/** @param string|array<string, mixed>|null $opts */
	public static function dump(string $label, mixed $data, string|array|null $opts = null): void
	{
		self::emit(['level' => 'dump', 'label' => $label, 'data' => $data], self::normalizeOpts($opts));
	}

	/** @param string|array<string, mixed>|null $opts */
	public static function info(string $msg, mixed $data = null, string|array|null $opts = null): void
	{
		$entry = ['level' => 'info', 'msg' => $msg];
		if ($data !== null) $entry['data'] = $data;
		self::emit($entry, self::normalizeOpts($opts));
	}

	/** @param string|array<string, mixed>|null $opts */
	public static function warn(string $msg, mixed $data = null, string|array|null $opts = null): void
	{
		$entry = ['level' => 'warn', 'msg' => $msg];
		if ($data !== null) $entry['data'] = $data;
		self::emit($entry, self::normalizeOpts($opts));
	}

	/** @param string|array<string, mixed>|null $opts */
	public static function error(string $msg, ?\Throwable $err = null, string|array|null $opts = null): void
	{
		$entry = ['level' => 'error', 'msg' => $msg];
		if ($err !== null) {
			$entry['stack'] = $err->getTraceAsString();
			$entry['data'] = [
				'message' => $err->getMessage(),
				'class' => get_class($err),
				'code' => $err->getCode(),
			];
		}
		self::emit($entry, self::normalizeOpts($opts));
	}

	/** @param array<string, mixed>|null $opts */
	public static function timerStart(string $label, ?array $opts = null): void
	{
		self::$timers[$label] = microtime(true) * 1000;
		self::emit(['level' => 'timer-start', 'label' => $label], self::normalizeOpts($opts));
	}

	/** @param array<string, mixed>|null $opts */
	public static function timerEnd(string $label, ?array $opts = null): void
	{
		$entry = ['level' => 'timer-end', 'label' => $label];
		if (isset(self::$timers[$label])) {
			$entry['durationMs'] = (int)(microtime(true) * 1000 - self::$timers[$label]);
			unset(self::$timers[$label]);
		}
		self::emit($entry, self::normalizeOpts($opts));
	}

	/** @param array<string, mixed>|null $opts */
	public static function checkpoint(string $label, ?array $opts = null): void
	{
		self::emit(['level' => 'checkpoint', 'label' => $label], self::normalizeOpts($opts));
	}

	/** @param array<string, mixed>|null $opts */
	public static function assert(bool $condition, string $label, mixed $ctx = null, ?array $opts = null): void
	{
		$entry = ['level' => 'assert', 'label' => $label, 'passed' => $condition];
		if ($ctx !== null) $entry['ctx'] = $ctx;
		self::emit($entry, self::normalizeOpts($opts));
	}

	/** @param string|array<string, mixed>|null $opts */
	public static function snapshot(string $label, array $vars, string|array|null $opts = null): void
	{
		self::emit(['level' => 'snapshot', 'label' => $label, 'vars' => $vars], self::normalizeOpts($opts));
	}

	/** @param string|array<string, mixed>|null $opts */
	public static function trace(string $label, mixed $data = null, string|array|null $opts = null): void
	{
		$entry = ['level' => 'trace', 'label' => $label];
		if ($data !== null) $entry['data'] = $data;
		self::emit($entry, self::normalizeOpts($opts));
	}
}
