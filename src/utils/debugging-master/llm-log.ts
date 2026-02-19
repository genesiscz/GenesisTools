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

function write(entry: Record<string, unknown>): void {
	ensureDir();
	const { file, line } = getCallerLocation();
	const full = { ...entry, ts: Date.now(), file, line };
	appendFileSync(sessionPath, JSON.stringify(full) + "\n");
}

export const dbg = {
	session(name: string): void {
		currentSession = name;
		sessionPath = join(SESSIONS_DIR, `${currentSession}.jsonl`);
		dirEnsured = false;
	},

	dump(label: string, data: unknown, opts?: LogOpts): void {
		write({ level: "dump", label, data, ...opts && { h: opts.h } });
	},

	info(msg: string, data?: unknown, opts?: LogOpts): void {
		write({ level: "info", msg, ...(data !== undefined && { data }), ...opts && { h: opts.h } });
	},

	warn(msg: string, data?: unknown, opts?: LogOpts): void {
		write({ level: "warn", msg, ...(data !== undefined && { data }), ...opts && { h: opts.h } });
	},

	error(msg: string, err?: Error | unknown, opts?: LogOpts): void {
		const entry: Record<string, unknown> = { level: "error", msg };
		if (err instanceof Error) {
			entry.stack = err.stack;
			entry.data = { message: err.message, name: err.name };
		} else if (err !== undefined) {
			entry.data = err;
		}
		if (opts?.h) entry.h = opts.h;
		write(entry);
	},

	timerStart(label: string): void {
		timers[label] = Date.now();
		write({ level: "timer-start", label });
	},

	timerEnd(label: string): void {
		const start = timers[label];
		const durationMs = start !== undefined ? Date.now() - start : -1;
		if (start !== undefined) delete timers[label];
		write({ level: "timer-end", label, durationMs });
	},

	checkpoint(label: string): void {
		write({ level: "checkpoint", label });
	},

	assert(condition: boolean, label: string, ctx?: unknown): void {
		write({ level: "assert", label, passed: condition, ...(ctx !== undefined && { ctx }) });
	},

	snapshot(label: string, vars: Record<string, unknown>, opts?: LogOpts): void {
		write({ level: "snapshot", label, vars, ...opts && { h: opts.h } });
	},

	trace(label: string, data?: unknown, opts?: LogOpts): void {
		write({ level: "trace", label, ...(data !== undefined && { data }), ...opts && { h: opts.h } });
	},
};
