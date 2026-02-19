import chalk from "chalk";
import { formatDuration, formatBytes } from "@app/utils/format";
import { suggestCommand } from "@app/utils/cli/executor";
import { formatSchema } from "@app/utils/json-schema";
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

	const line = `  ${idx}  ${time}  ${level} ${label}`;
	if (!suffix) return line;
	return `${line.padEnd(60)} ${suffix}`;
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

	// Header
	lines.push(
		`Session: ${sessionName} (${stats.entryCount} entries, ${formatDuration(stats.spanMs, "ms")} span)`
	);
	lines.push("");
	lines.push(formatSummary(stats));
	lines.push("");

	// Entries with file headers on change
	let currentFile = "";
	for (const entry of entries) {
		const file = entry.file ?? "unknown";
		if (file !== currentFile) {
			currentFile = file;
			lines.push(`File: ${file}`);
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
		return `\nTip: Expand a ref → ${TOOL} expand ${refEntry.refId}`;
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
