import chalk from "chalk";
import { formatDuration, formatBytes } from "@app/utils/format";
import { suggestCommand } from "@app/utils/cli/executor";
import type { IndexedLogEntry, SessionStats, OutputFormat } from "@app/debugging-master/types";

const TOOL = "tools debugging-master";

/**
 * Format a single entry as a compact L1 line.
 */
export function formatEntryLine(entry: IndexedLogEntry, pretty: boolean): string {
	const idx = `#${entry.index}`.padStart(4);
	const time = new Date(entry.ts).toLocaleTimeString("en-GB", {
		hour12: false,
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		fractionalSecondDigits: 3,
	});
	const level = entry.level.padEnd(11);
	const label = entry.label ?? entry.msg ?? "";

	let suffix = "";
	if (entry.refId) {
		suffix = `[ref:${entry.refId}] ${formatBytes(JSON.stringify(entry.data ?? entry.vars ?? entry.stack ?? "").length)}`;
	}
	if (entry.level === "timer-end" && entry.durationMs != null) {
		suffix = formatDuration(entry.durationMs, "ms");
	}
	if (entry.level === "assert") {
		suffix = entry.passed ? "PASS" : "FAIL";
	}

	if (pretty) {
		const coloredIdx = chalk.dim(idx);
		const coloredTime = chalk.dim(time);
		const coloredLevel = colorizeLevel(entry.level, level, entry.passed);
		const coloredSuffix = colorizeSuffix(entry, suffix);
		const line = `  ${coloredIdx}  ${coloredTime}  ${coloredLevel} ${label}`;
		if (!coloredSuffix) return line;
		return `${line.padEnd(60)} ${coloredSuffix}`;
	}

	const line = `  ${idx}  ${time}  ${level} ${label}`;
	if (!suffix) return line;
	return `${line.padEnd(60)} ${suffix}`;
}

function colorizeLevel(type: string, text: string, passed?: boolean): string {
	switch (type) {
		case "dump": return chalk.cyan(text);
		case "info": return chalk.blue(text);
		case "warn": return chalk.yellow(text);
		case "error": return chalk.red(text);
		case "timer-start":
		case "timer-end": return chalk.magenta(text);
		case "checkpoint": return chalk.green(text);
		case "assert": return passed ? chalk.green(text) : chalk.red(text);
		case "snapshot": return chalk.cyan(text);
		case "trace": return chalk.gray(text);
		case "raw": return chalk.dim(text);
		default: return text;
	}
}

function colorizeSuffix(entry: IndexedLogEntry, suffix: string): string {
	if (!suffix) return "";
	if (entry.level === "assert") {
		return entry.passed ? chalk.green(suffix) : chalk.red(suffix);
	}
	if (entry.level === "timer-end" && entry.durationMs != null) {
		return chalk.magenta(suffix);
	}
	if (entry.refId) {
		return chalk.dim(suffix);
	}
	return suffix;
}

/**
 * Format the summary section.
 */
export function formatSummary(stats: SessionStats): string {
	const parts: string[] = [];
	const lc = stats.levelCounts;

	const levelOrder = ["dump", "info", "warn", "error", "checkpoint", "trace", "snapshot", "assert", "raw"];
	for (const level of levelOrder) {
		const count = lc[level];
		if (!count) continue;
		let text = `${count} ${level}`;
		if (level === "assert") {
			text += ` (${stats.assertsFailed} failed)`;
		}
		parts.push(text);
	}

	if (stats.timerPairs.length > 0) {
		parts.push(
			`${stats.timerPairs.length} timer-pair (avg ${formatDuration(stats.avgTimerMs, "ms")})`
		);
	}

	return `Summary:\n  ${parts.join("  ")}`;
}

/**
 * Format full L1 output with timeline-preserving file headers.
 */
export function formatL1(
	sessionName: string,
	entries: IndexedLogEntry[],
	stats: SessionStats,
	pretty: boolean,
): string {
	const lines: string[] = [];

	const header = `Session: ${sessionName} (${stats.entryCount} entries, ${formatDuration(stats.spanMs, "ms")} span)`;
	lines.push(pretty ? chalk.bold(header) : header);
	lines.push("");
	lines.push(formatSummary(stats));
	lines.push("");

	let currentFile = "";
	for (const entry of entries) {
		const file = entry.file ?? "unknown";
		if (file !== currentFile) {
			currentFile = file;
			const fileHeader = `File: ${file}`;
			lines.push(pretty ? chalk.dim(fileHeader) : fileHeader);
		}
		lines.push(formatEntryLine(entry, pretty));
	}

	return lines.join("\n");
}

/**
 * Generate the tip line for the end of output.
 */
export function formatTip(entries: IndexedLogEntry[]): string {
	const refEntry = entries.find((e) => e.refId);
	if (refEntry) {
		const cmd = suggestCommand(TOOL, { add: ["expand", refEntry.refId] });
		return `\nTip: Expand a ref → ${cmd}`;
	}
	return "";
}

/**
 * Wrap output in the requested format.
 */
export function wrapOutput(content: string, format: OutputFormat, tip?: string): string {
	switch (format) {
		case "json":
			return JSON.stringify({ output: content });
		case "md":
			return content + (tip ?? "");
		case "ai":
		default:
			return content + (tip ?? "");
	}
}
