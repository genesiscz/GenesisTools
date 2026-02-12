import type { Command } from "commander";
import { SessionManager } from "@app/har-analyzer/core/session-manager";
import { filterEntries } from "@app/har-analyzer/core/query-engine";
import { truncatePath } from "@app/har-analyzer/core/formatter";
import { formatDuration } from "@app/utils/format";
import type { EntryFilter, IndexedEntry } from "@app/har-analyzer/types";

const BAR_WIDTH = 40;

interface WaterfallOptions {
	domain?: string;
	limit: string;
}

function buildBar(startOffset: number, duration: number, totalSpan: number): string {
	if (totalSpan <= 0) return "";

	const startPos = Math.round((startOffset / totalSpan) * BAR_WIDTH);
	const barLen = Math.max(1, Math.round((duration / totalSpan) * BAR_WIDTH));
	const clampedStart = Math.min(startPos, BAR_WIDTH - 1);
	const clampedLen = Math.min(barLen, BAR_WIDTH - clampedStart);

	return " ".repeat(clampedStart) + "█".repeat(clampedLen) + " ".repeat(BAR_WIDTH - clampedStart - clampedLen);
}

function getStartMs(entry: IndexedEntry): number {
	return new Date(entry.startedDateTime).getTime();
}

export function registerWaterfallCommand(program: Command): void {
	program
		.command("waterfall")
		.description("Show request timing waterfall chart")
		.option("--domain <glob>", "Filter by domain glob pattern")
		.option("--limit <n>", "Maximum entries to show", "30")
		.action(async (options: WaterfallOptions) => {
			const sm = new SessionManager();
			const session = await sm.loadSession();

			if (!session) {
				console.error("No session loaded. Use `load <file>` first.");
				process.exit(1);
			}

			const filter: EntryFilter = {
				domain: options.domain,
				limit: Number(options.limit),
			};

			const entries = filterEntries(session.entries, filter);

			if (entries.length === 0) {
				console.log("No entries match the filter criteria.");
				return;
			}

			const firstStart = getStartMs(entries[0]);
			const lastEnd = entries.reduce((max, e) => {
				const end = getStartMs(e) + e.timeMs;
				return end > max ? end : max;
			}, 0);
			const totalSpan = lastEnd - firstStart;

			const lines: string[] = [];
			lines.push(`Waterfall (${entries.length} entries, span: ${formatDuration(totalSpan)})`);
			lines.push("");

			// Header
			const idCol = "#".padEnd(6);
			const methodCol = "Method".padEnd(6);
			const pathCol = "Path".padEnd(25);
			const barHeader = "Timeline".padEnd(BAR_WIDTH);
			const timeCol = "Time";
			lines.push(`${idCol}  ${methodCol}  ${pathCol}  |${barHeader}|  ${timeCol}`);
			lines.push("─".repeat(6 + 2 + 6 + 2 + 25 + 2 + 1 + BAR_WIDTH + 1 + 2 + 8));

			for (const entry of entries) {
				const offset = getStartMs(entry) - firstStart;
				const bar = buildBar(offset, entry.timeMs, totalSpan);
				const id = `e${entry.index}`.padEnd(6);
				const method = entry.method.padEnd(6).slice(0, 6);
				const path = truncatePath(entry.path, 25).padEnd(25);
				const time = formatDuration(entry.timeMs).padStart(8);

				lines.push(`${id}  ${method}  ${path}  |${bar}|  ${time}`);
			}

			console.log(lines.join("\n"));
		});
}
