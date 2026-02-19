import type { Command } from "commander";
import { SessionManager } from "@app/debugging-master/core/session-manager";
import { indexEntries, computeTimerPairs, filterByLevel } from "@app/debugging-master/core/log-parser";
import { formatDuration } from "@app/utils/format";
import type { IndexedLogEntry, LogLevel } from "@app/debugging-master/types";

const COMPARABLE_LEVELS: LogLevel[] = ["checkpoint", "dump", "snapshot", "trace", "assert"];

function groupByLabel(entries: IndexedLogEntry[]): Map<string, IndexedLogEntry[]> {
	const map = new Map<string, IndexedLogEntry[]>();
	for (const e of entries) {
		const key = e.label ?? e.msg;
		if (!key) continue;
		if (!map.has(key)) map.set(key, []);
		map.get(key)!.push(e);
	}
	return map;
}

function formatTime(ts: number): string {
	return new Date(ts).toLocaleTimeString("en-GB", { hour12: false });
}

function percentChange(a: number, b: number): string {
	if (a === 0) return "N/A";
	const pct = ((b - a) / a) * 100;
	const sign = pct >= 0 ? "+" : "";
	return `${sign}${pct.toFixed(0)}%`;
}

function truncate(str: string, max: number): string {
	return str.length > max ? `${str.slice(0, max)}...` : str;
}

export function registerDiffCommand(program: Command): void {
	program
		.command("diff")
		.description("Compare two debugging sessions")
		.requiredOption("--against <session>", "Second session to compare against")
		.option("-l, --level <levels>", "Filter by level(s), comma-separated")
		.action(async (opts) => {
			const globalOpts = program.opts();
			const sm = new SessionManager();

			const name1 = await sm.resolveSession(globalOpts.session);
			const name2 = await sm.resolveSession(opts.against);

			const raw1 = await sm.readEntries(name1);
			const raw2 = await sm.readEntries(name2);

			let entries1 = indexEntries(raw1);
			let entries2 = indexEntries(raw2);

			if (opts.level) {
				const levels = opts.level.split(",").map((l: string) => l.trim());
				entries1 = filterByLevel(entries1, levels);
				entries2 = filterByLevel(entries2, levels);
			}

			console.log(`Comparing: ${name1} (${entries1.length} entries) vs ${name2} (${entries2.length} entries)`);

			const groups1 = groupByLabel(entries1);
			const groups2 = groupByLabel(entries2);
			const allLabels = new Set([...groups1.keys(), ...groups2.keys()]);

			for (const level of COMPARABLE_LEVELS) {
				const matches: string[] = [];

				for (const label of allLabels) {
					const e1 = groups1.get(label)?.find((e) => e.level === level);
					const e2 = groups2.get(label)?.find((e) => e.level === level);

					if (!e1 && !e2) continue;

					if (e1 && !e2) {
						matches.push(`  ${label.padEnd(20)} ${name1}: #${e1.index} ${formatTime(e1.ts)}  ${name2}: missing`);
					} else if (!e1 && e2) {
						matches.push(`  ${label.padEnd(20)} ${name1}: missing  ${name2}: #${e2.index} ${formatTime(e2.ts)}`);
					} else if (e1 && e2) {
						const d1 = JSON.stringify(e1.data ?? e1.vars ?? "");
						const d2 = JSON.stringify(e2.data ?? e2.vars ?? "");
						if (d1 === d2) {
							matches.push(`  ${label.padEnd(20)} Both present, data identical`);
						} else {
							matches.push(`  ${label.padEnd(20)} Both present, data differs:`);
							matches.push(`    ${name1}: ${truncate(d1, 80)}`);
							matches.push(`    ${name2}: ${truncate(d2, 80)}`);
						}
					}
				}

				if (matches.length > 0) {
					console.log(`\nMatching ${level}s:`);
					for (const m of matches) console.log(m);
				}
			}

			const timers1 = computeTimerPairs(entries1);
			const timers2 = computeTimerPairs(entries2);
			const timerLabels = new Set([...timers1.map((t) => t.label), ...timers2.map((t) => t.label)]);

			if (timerLabels.size > 0) {
				console.log("\nTimer comparison:");
				for (const label of timerLabels) {
					const t1 = timers1.find((t) => t.label === label);
					const t2 = timers2.find((t) => t.label === label);
					const d1 = t1 ? formatDuration(t1.durationMs, "ms") : "N/A";
					const d2 = t2 ? formatDuration(t2.durationMs, "ms") : "N/A";
					const pct = t1 && t2 ? `  (${percentChange(t1.durationMs, t2.durationMs)})` : "";
					console.log(`  ${label.padEnd(20)} ${name1}: ${d1}  ${name2}: ${d2}${pct}`);
				}
			}

			const labels1 = new Set(entries1.map((e) => e.label ?? e.msg).filter(Boolean));
			const labels2 = new Set(entries2.map((e) => e.label ?? e.msg).filter(Boolean));
			const only1 = entries1.filter((e) => {
				const key = e.label ?? e.msg;
				return key && !labels2.has(key);
			});
			const only2 = entries2.filter((e) => {
				const key = e.label ?? e.msg;
				return key && !labels1.has(key);
			});

			if (only1.length > 0 || only2.length > 0) {
				console.log("");
				if (only1.length > 0) {
					const byLevel: Record<string, number> = {};
					for (const e of only1) byLevel[e.level] = (byLevel[e.level] ?? 0) + 1;
					const summary = Object.entries(byLevel).map(([l, c]) => `${c} ${l}`).join(", ");
					console.log(`Only in ${name1}: ${only1.length} entries (${summary})`);
				}
				if (only2.length > 0) {
					const byLevel: Record<string, number> = {};
					for (const e of only2) byLevel[e.level] = (byLevel[e.level] ?? 0) + 1;
					const summary = Object.entries(byLevel).map(([l, c]) => `${c} ${l}`).join(", ");
					console.log(`Only in ${name2}: ${only2.length} entries (${summary})`);
				}
			}
		});
}
