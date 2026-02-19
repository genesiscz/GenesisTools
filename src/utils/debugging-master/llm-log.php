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
 * Logs are written as JSONL to:
 *   ~/.genesis-tools/debugging-master/sessions/<session>.jsonl
 *
 * Each line includes timestamp, caller file:line, and optional hypothesis tag.
 */

class LlmLog
{
	/** @var array<string, float> */
	private static array $timers = [];
	private static string $currentSession = 'default';
	private static string $sessionPath = '';
	private static bool $dirEnsured = false;

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

	private static function getCallerLocation(): array
	{
		$trace = debug_backtrace(DEBUG_BACKTRACE_IGNORE_ARGS, 3);
		// Frame 0 = this method, Frame 1 = LlmLog method, Frame 2 = caller
		$frame = $trace[2] ?? $trace[1] ?? [];
		return [
			'file' => $frame['file'] ?? 'unknown',
			'line' => $frame['line'] ?? 0,
		];
	}

	/** @param array<string, mixed> $entry */
	private static function write(array $entry): void
	{
		self::ensureDir();
		file_put_contents(
			self::getSessionPath(),
			json_encode($entry, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) . "\n",
			FILE_APPEND | LOCK_EX
		);
	}

	private static function buildEntry(string $type, string $label, mixed $data = null, ?string $h = null): array
	{
		$caller = self::getCallerLocation();
		$entry = [
			'ts' => (int)(microtime(true) * 1000),
			'type' => $type,
			'file' => $caller['file'],
			'line' => $caller['line'],
			'label' => $label,
		];
		if ($data !== null) $entry['data'] = $data;
		if ($h !== null) $entry['h'] = $h;
		return $entry;
	}

	public static function session(string $name): void
	{
		self::$currentSession = $name;
		self::$sessionPath = self::sessionsDir() . '/' . $name . '.jsonl';
		self::$dirEnsured = false;
	}

	public static function dump(string $label, mixed $data, ?string $h = null): void
	{
		self::write(self::buildEntry('dump', $label, $data, $h));
	}

	public static function info(string $msg, mixed $data = null, ?string $h = null): void
	{
		self::write(self::buildEntry('info', $msg, $data, $h));
	}

	public static function warn(string $msg, mixed $data = null, ?string $h = null): void
	{
		self::write(self::buildEntry('warn', $msg, $data, $h));
	}

	public static function error(string $msg, ?\Throwable $err = null, ?string $h = null): void
	{
		$data = null;
		if ($err !== null) {
			$data = [
				'message' => $err->getMessage(),
				'class' => get_class($err),
				'code' => $err->getCode(),
				'trace' => $err->getTraceAsString(),
			];
		}
		self::write(self::buildEntry('error', $msg, $data, $h));
	}

	public static function timerStart(string $label): void
	{
		self::$timers[$label] = microtime(true) * 1000;
		self::write(self::buildEntry('timer_start', $label));
	}

	public static function timerEnd(string $label): void
	{
		$entry = self::buildEntry('timer_end', $label);
		if (isset(self::$timers[$label])) {
			$entry['duration_ms'] = (int)(microtime(true) * 1000 - self::$timers[$label]);
			unset(self::$timers[$label]);
		}
		self::write($entry);
	}

	public static function checkpoint(string $label): void
	{
		self::write(self::buildEntry('checkpoint', $label));
	}

	public static function assert(bool $condition, string $label, mixed $ctx = null): void
	{
		if ($condition) return;
		self::write(self::buildEntry('assert_fail', $label, $ctx));
	}

	public static function snapshot(string $label, array $vars, ?string $h = null): void
	{
		self::write(self::buildEntry('snapshot', $label, $vars, $h));
	}

	public static function trace(string $label, mixed $data = null, ?string $h = null): void
	{
		self::write(self::buildEntry('trace', $label, $data, $h));
	}
}
