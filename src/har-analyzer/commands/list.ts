import type { Command } from "commander";
import { SessionManager } from "@app/har-analyzer/core/session-manager";
import { filterEntries } from "@app/har-analyzer/core/query-engine";
import { truncatePath } from "@app/har-analyzer/core/formatter";
import { formatTable } from "@app/utils/table";
import { formatBytes, formatDuration } from "@app/utils/format";
import type { EntryFilter } from "@app/har-analyzer/types";

interface ListOptions {
	domain?: string;
	url?: string;
	status?: string;
	method?: string;
	type?: string;
	minTime?: string;
	minSize?: string;
	limit: string;
}

export function registerListCommand(program: Command): void {
	program
		.command("list")
		.description("List HAR entries with optional filters")
		.option("--domain <glob>", "Filter by domain glob pattern")
		.option("--url <glob>", "Filter by URL glob pattern")
		.option("--status <codes>", "Filter by status codes (e.g. 200, 4xx, !3xx)")
		.option("--method <methods>", "Filter by HTTP methods (comma-separated)")
		.option("--type <mime>", "Filter by MIME type glob")
		.option("--min-time <ms>", "Minimum response time in ms")
		.option("--min-size <bytes>", "Minimum response size in bytes")
		.option("--limit <n>", "Maximum entries to show", "50")
		.action(async (options: ListOptions) => {
			const sm = new SessionManager();
			const session = await sm.loadSession();

			if (!session) {
				console.error("No session loaded. Use `load <file>` first.");
				process.exit(1);
			}

			const filter: EntryFilter = {
				domain: options.domain,
				url: options.url,
				status: options.status,
				method: options.method,
				type: options.type,
				minTime: options.minTime ? Number(options.minTime) : undefined,
				minSize: options.minSize ? Number(options.minSize) : undefined,
				limit: Number(options.limit),
			};

			const entries = filterEntries(session.entries, filter);

			if (entries.length === 0) {
				console.log("No entries match the filter criteria.");
				return;
			}

			const headers = ["#", "Method", "Path", "Status", "Size", "Time"];
			const rows = entries.map((entry) => [
				`e${entry.index}`,
				entry.method,
				truncatePath(entry.path, 40),
				String(entry.status),
				formatBytes(entry.responseSize),
				formatDuration(entry.timeMs, "ms", "tiered"),
			]);

			console.log(formatTable(rows, headers, { alignRight: [4, 5] }));
			console.log(`\n${entries.length} entries shown`);
		});
}
