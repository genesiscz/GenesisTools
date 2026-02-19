/**
 * LLM-assisted debugging instrumentation snippet.
 *
 * This file is **self-contained** — copy it into any TypeScript/JS project.
 * It has zero external dependencies (only node: builtins).
 *
 * Usage:
 *   import { dbg } from './llm-log';
 *   dbg.session('my-feature');
 *   dbg.info('request received', { url: req.url });
 *   dbg.dump('response', data);
 *   dbg.timerStart('db-query');
 *   // ... do work ...
 *   dbg.timerEnd('db-query');
 *   dbg.snapshot('state', { user, cart, flags });
 *
 * Logs are written as JSONL to:
 *   ~/.genesis-tools/debugging-master/sessions/<session>.jsonl
 *
 * Each line includes timestamp, caller file:line, and optional hypothesis tag.
 */

import { appendFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

interface LogOpts {
	h?: string;
}

interface LogEntry {
	ts: number;
	type: string;
	file: string;
	line: number;
	label: string;
	data?: unknown;
	h?: string;
	[key: string]: unknown;
}

const SESSIONS_DIR = join(homedir(), ".genesis-tools", "debugging-master", "sessions");
const timers: Record<string, number> = {};
let currentSession = "default";
let sessionPath = join(SESSIONS_DIR, `${currentSession}.jsonl`);
let dirEnsured = false;

function ensureDir(): void {
	if (dirEnsured) return;
	if (!existsSync(SESSIONS_DIR)) {
		mkdirSync(SESSIONS_DIR, { recursive: true });
	}
	dirEnsured = true;
}

function getCallerLocation(): { file: string; line: number } {
	const stack = new Error().stack;
	if (!stack) return { file: "unknown", line: 0 };

	const lines = stack.split("\n");
	for (let i = 1; i < lines.length; i++) {
		const frame = lines[i];
		if (frame.includes("llm-log")) continue;
		const match = frame.match(/(?:at\s+.*?\s+\(|at\s+)(.+?):(\d+):\d+\)?/);
		if (match) {
			return { file: match[1], line: parseInt(match[2], 10) };
		}
	}
	return { file: "unknown", line: 0 };
}

function write(entry: LogEntry): void {
	ensureDir();
	appendFileSync(sessionPath, JSON.stringify(entry) + "\n");
}

function buildEntry(type: string, label: string, data?: unknown, opts?: LogOpts): LogEntry {
	const { file, line } = getCallerLocation();
	const entry: LogEntry = { ts: Date.now(), type, file, line, label };
	if (data !== undefined) entry.data = data;
	if (opts?.h) entry.h = opts.h;
	return entry;
}

export const dbg = {
	session(name: string): void {
		currentSession = name;
		sessionPath = join(SESSIONS_DIR, `${currentSession}.jsonl`);
		dirEnsured = false;
	},

	dump(label: string, data: unknown, opts?: LogOpts): void {
		write(buildEntry("dump", label, data, opts));
	},

	info(msg: string, data?: unknown, opts?: LogOpts): void {
		write(buildEntry("info", msg, data, opts));
	},

	warn(msg: string, data?: unknown, opts?: LogOpts): void {
		write(buildEntry("warn", msg, data, opts));
	},

	error(msg: string, err?: Error | unknown, opts?: LogOpts): void {
		const entry = buildEntry("error", msg, undefined, opts);
		if (err instanceof Error) {
			entry.data = {
				message: err.message,
				name: err.name,
				stack: err.stack,
			};
		} else if (err !== undefined) {
			entry.data = err;
		}
		write(entry);
	},

	timerStart(label: string): void {
		timers[label] = Date.now();
		write(buildEntry("timer_start", label));
	},

	timerEnd(label: string): void {
		const start = timers[label];
		const entry = buildEntry("timer_end", label);
		if (start !== undefined) {
			entry.duration_ms = Date.now() - start;
			delete timers[label];
		}
		write(entry);
	},

	checkpoint(label: string): void {
		write(buildEntry("checkpoint", label));
	},

	assert(condition: boolean, label: string, ctx?: unknown): void {
		if (condition) return;
		write(buildEntry("assert_fail", label, ctx));
	},

	snapshot(label: string, vars: Record<string, unknown>, opts?: LogOpts): void {
		write(buildEntry("snapshot", label, vars, opts));
	},

	trace(label: string, data?: unknown, opts?: LogOpts): void {
		write(buildEntry("trace", label, data, opts));
	},
};
