import { Command } from "commander";
import { SessionManager } from "@app/debugging-master/core/session-manager";
import {
	indexEntries,
	filterByLevel,
	filterByHypothesis,
	lastN,
	mergeTimerEntries,
	computeStats,
} from "@app/debugging-master/core/log-parser";
import { formatL1, formatTip, wrapOutput } from "@app/debugging-master/core/formatter";
import { REF_THRESHOLD } from "@app/utils/references";
import type { OutputFormat, IndexedLogEntry } from "@app/debugging-master/types";

function assignRefIds(entries: IndexedLogEntry[]): void {
	const prefixes: Record<string, string> = {
		dump: "d",
		error: "e",
		snapshot: "s",
		trace: "t",
	};

	for (const entry of entries) {
		const prefix = prefixes[entry.level];
		if (!prefix) continue;

		const dataStr = JSON.stringify(entry.data ?? entry.vars ?? entry.stack ?? "");
		if (dataStr.length <= REF_THRESHOLD) continue;

		entry.refId = `${prefix}${entry.index}`;
	}
}

export function registerGetCommand(program: Command): void {
	program
		.command("get")
		.description("Read debug log entries")
		.option("-l, --level <levels>", "Filter by level(s), comma-separated")
		.option("--last <n>", "Show only last N entries", parseInt)
		.option("--h <tag>", "Filter by hypothesis tag")
		.action(async (opts) => {
			const globalOpts = program.opts();
			const sessionManager = new SessionManager();
			const sessionName = await sessionManager.resolveSession(globalOpts.session);

			const raw = await sessionManager.readEntries(sessionName);
			let entries = indexEntries(raw);

			if (opts.level) {
				const levels = opts.level.split(",").map((l: string) => l.trim());
				if (levels.includes("timer")) {
					entries = mergeTimerEntries(entries);
				} else {
					entries = filterByLevel(entries, levels);
				}
			}

			if (opts.h) {
				entries = filterByHypothesis(entries, opts.h);
			}

			if (opts.last) {
				entries = lastN(entries, opts.last);
			}

			assignRefIds(entries);

			const stats = computeStats(entries);
			const pretty = globalOpts.pretty ?? false;
			const format: OutputFormat = globalOpts.format ?? "ai";

			const content = formatL1(sessionName, entries, stats, pretty);
			const tip = formatTip(entries);
			console.log(wrapOutput(content, format, tip));
		});
}
