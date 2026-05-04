<?php
/**
 * LLM-assisted debugging instrumentation snippet.
 *
 * This file is **self-contained** — copy it into any PHP project.
 * It has zero external dependencies (only PHP builtins).
 *
 * Usage:
 *   require_once __DIR__ . '/llm-log.php';
 *   LlmLog::session('my-feature');
 *   LlmLog::info('request received', ['url' => $_SERVER['REQUEST_URI']]);
 *   LlmLog::dump('response', $data);
 *   LlmLog::timerStart('db-query');
 *   // ... do work ...
 *   LlmLog::timerEnd('db-query');
 *   LlmLog::snapshot('state', ['user' => $user, 'cart' => $cart]);
 *
 * Every entry captures the full call stack by default (callers up the chain).
 * To opt out per-call:           LlmLog::info('msg', null, ['stack' => false])
 * To opt out globally (one-time): LlmLog::configure(['captureStackByDefault' => false])
 *
 * Every method accepts a final `$opts` argument — an associative array with
 * optional keys: `h` (string, hypothesis tag) and `stack` (false to skip,
 * string to override). For backwards compatibility, methods that previously
 * accepted `?string $h` still accept a string in that position.
 *
 * Logs are written as JSONL to:
 *   ~/.genesis-tools/debugging-master/sessions/<session>.jsonl
 */

class LlmLog
{
	/** @var array<string, float> */
	private static array $timers = [];
	private static string $currentSession = 'default';
	private static string $sessionPath = '';
	private static bool $dirEnsured = false;
	private static bool $captureStackByDefault = true;

	private static function sessionsDir(): string
	{
		return ($_SERVER['HOME'] ?? $_ENV['HOME'] ?? getenv('HOME') ?: '/tmp')
			. '/.genesis-tools/debugging-master/sessions';
	}

	private static function getSessionPath(): string
	{
		if (self::$sessionPath === '') {
			self::$sessionPath = self::sessionsDir() . '/' . self::$currentSession . '.jsonl';
		}
		return self::$sessionPath;
	}

	private static function ensureDir(): void
	{
		if (self::$dirEnsured) return;
		$dir = self::sessionsDir();
		if (!is_dir($dir)) {
			mkdir($dir, 0755, true);
		}
		self::$dirEnsured = true;
	}

	/** Render a full backtrace as a multiline string, skipping LlmLog internals. */
	private static function captureStack(): string
	{
		$trace = debug_backtrace(DEBUG_BACKTRACE_IGNORE_ARGS);
		$lines = [];
		foreach ($trace as $frame) {
			$cls = $frame['class'] ?? '';
			if ($cls === self::class) continue;
			$file = $frame['file'] ?? 'unknown';
			$line = $frame['line'] ?? 0;
			$fn = ($cls !== '' ? $cls . ($frame['type'] ?? '::') : '') . ($frame['function'] ?? '?');
			$lines[] = "  at $fn ($file:$line)";
		}
		return implode("\n", $lines);
	}

	/** @return array{file: string, line: int} */
	private static function getCallerLocation(): array
	{
		$trace = debug_backtrace(DEBUG_BACKTRACE_IGNORE_ARGS);
		// Walk past LlmLog frames to find the real caller.
		foreach ($trace as $frame) {
			$cls = $frame['class'] ?? '';
			if ($cls === self::class) continue;
			return [
				'file' => $frame['file'] ?? 'unknown',
				'line' => $frame['line'] ?? 0,
			];
		}
		return ['file' => 'unknown', 'line' => 0];
	}

	/**
	 * Normalize backwards-compatible $opts. Methods used to accept `?string $h`
	 * as the last arg; that's still allowed and is mapped to ['h' => <string>].
	 *
	 * @param string|array<string, mixed>|null $opts
	 * @return array<string, mixed>
	 */
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
	private static function write(array $entry, array $opts = []): void
	{
		self::ensureDir();
		$caller = self::getCallerLocation();
		$entry['ts'] = (int)(microtime(true) * 1000);
		$entry['file'] = $caller['file'];
		$entry['line'] = $caller['line'];

		if (isset($opts['h']) && !isset($entry['h'])) {
			$entry['h'] = $opts['h'];
		}

		$includeStack = self::$captureStackByDefault;
		if (array_key_exists('stack', $opts)) {
			$includeStack = $opts['stack'] !== false;
		}

		if (!isset($entry['stack'])) {
			if (is_string($opts['stack'] ?? null)) {
				$entry['stack'] = $opts['stack'];
			} elseif ($includeStack) {
				$entry['stack'] = self::captureStack();
			}
		}

		try {
			$json = json_encode($entry, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR);
		} catch (\Throwable $e) {
			$json = json_encode([
				'level' => $entry['level'] ?? 'unknown',
				'ts' => $entry['ts'] ?? 0,
				'error' => 'serialize_failed: ' . $e->getMessage(),
			]);
		}
		file_put_contents(
			self::getSessionPath(),
			$json . "\n",
			FILE_APPEND | LOCK_EX
		);
	}

	public static function session(string $name): void
	{
		self::$currentSession = $name;
		self::$sessionPath = self::sessionsDir() . '/' . $name . '.jsonl';
		self::$dirEnsured = false;
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
		self::write(['level' => 'dump', 'label' => $label, 'data' => $data], self::normalizeOpts($opts));
	}

	/** @param string|array<string, mixed>|null $opts */
	public static function info(string $msg, mixed $data = null, string|array|null $opts = null): void
	{
		$entry = ['level' => 'info', 'msg' => $msg];
		if ($data !== null) $entry['data'] = $data;
		self::write($entry, self::normalizeOpts($opts));
	}

	/** @param string|array<string, mixed>|null $opts */
	public static function warn(string $msg, mixed $data = null, string|array|null $opts = null): void
	{
		$entry = ['level' => 'warn', 'msg' => $msg];
		if ($data !== null) $entry['data'] = $data;
		self::write($entry, self::normalizeOpts($opts));
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
		self::write($entry, self::normalizeOpts($opts));
	}

	/** @param array<string, mixed>|null $opts */
	public static function timerStart(string $label, ?array $opts = null): void
	{
		self::$timers[$label] = microtime(true) * 1000;
		self::write(['level' => 'timer-start', 'label' => $label], self::normalizeOpts($opts));
	}

	/** @param array<string, mixed>|null $opts */
	public static function timerEnd(string $label, ?array $opts = null): void
	{
		$entry = ['level' => 'timer-end', 'label' => $label];
		if (isset(self::$timers[$label])) {
			$entry['durationMs'] = (int)(microtime(true) * 1000 - self::$timers[$label]);
			unset(self::$timers[$label]);
		}
		self::write($entry, self::normalizeOpts($opts));
	}

	/** @param array<string, mixed>|null $opts */
	public static function checkpoint(string $label, ?array $opts = null): void
	{
		self::write(['level' => 'checkpoint', 'label' => $label], self::normalizeOpts($opts));
	}

	/** @param array<string, mixed>|null $opts */
	public static function assert(bool $condition, string $label, mixed $ctx = null, ?array $opts = null): void
	{
		$entry = ['level' => 'assert', 'label' => $label, 'passed' => $condition];
		if ($ctx !== null) $entry['ctx'] = $ctx;
		self::write($entry, self::normalizeOpts($opts));
	}

	/** @param string|array<string, mixed>|null $opts */
	public static function snapshot(string $label, array $vars, string|array|null $opts = null): void
	{
		self::write(['level' => 'snapshot', 'label' => $label, 'vars' => $vars], self::normalizeOpts($opts));
	}

	/** @param string|array<string, mixed>|null $opts */
	public static function trace(string $label, mixed $data = null, string|array|null $opts = null): void
	{
		$entry = ['level' => 'trace', 'label' => $label];
		if ($data !== null) $entry['data'] = $data;
		self::write($entry, self::normalizeOpts($opts));
	}
}
