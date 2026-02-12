import type { Command } from "commander";
import { SessionManager } from "@app/har-analyzer/core/session-manager";
import { loadHarFile } from "@app/har-analyzer/core/parser";
import { filterEntries } from "@app/har-analyzer/core/query-engine";
import { truncatePath } from "@app/har-analyzer/core/formatter";
import { RefStoreManager } from "@app/har-analyzer/core/ref-store";
import { formatDuration } from "@app/utils/format";
import { isInterestingMimeType } from "@app/har-analyzer/types";
import type { IndexedEntry } from "@app/har-analyzer/types";

export function registerErrorsCommand(program: Command): void {
	program
		.command("errors")
		.description("Show 4xx/5xx entries with details")
		.action(async () => {
			const sm = new SessionManager();
			const session = await sm.loadSession();

			if (!session) {
				console.error("No session loaded. Use `load <file>` first.");
				process.exit(1);
			}

			const errorEntries = filterEntries(session.entries, {}).filter((e) => e.isError);

			if (errorEntries.length === 0) {
				console.log("No error responses found.");
				return;
			}

			const clientErrors: IndexedEntry[] = [];
			const serverErrors: IndexedEntry[] = [];

			for (const entry of errorEntries) {
				if (entry.status >= 400 && entry.status < 500) {
					clientErrors.push(entry);
				} else if (entry.status >= 500) {
					serverErrors.push(entry);
				}
			}

			const har = await loadHarFile(session.sourceFile);
			const refStore = new RefStoreManager(session.sourceHash);

			const lines: string[] = [];

			if (clientErrors.length > 0) {
				lines.push(`── 4xx Client Errors (${clientErrors.length}) ──`);
				lines.push("");

				for (const entry of clientErrors) {
					const line = await formatErrorEntry(entry, har.log.entries[entry.index], refStore);
					lines.push(line);
				}

				lines.push("");
			}

			if (serverErrors.length > 0) {
				lines.push(`── 5xx Server Errors (${serverErrors.length}) ──`);
				lines.push("");

				for (const entry of serverErrors) {
					const line = await formatErrorEntry(entry, har.log.entries[entry.index], refStore);
					lines.push(line);
				}

				lines.push("");
			}

			lines.push(`Total: ${errorEntries.length} errors (${clientErrors.length} client, ${serverErrors.length} server)`);

			console.log(lines.join("\n"));
		});
}

interface HarEntryRaw {
	response: {
		content: {
			text?: string;
			mimeType: string;
		};
	};
}

async function formatErrorEntry(
	entry: IndexedEntry,
	rawEntry: HarEntryRaw,
	refStore: RefStoreManager,
): Promise<string> {
	const parts: string[] = [];
	const id = `e${entry.index}`;
	const path = truncatePath(entry.path, 50);
	const time = formatDuration(entry.timeMs);

	parts.push(`  ${id}  ${entry.status} ${entry.statusText}  ${entry.method}  ${path}  ${time}`);

	const bodyText = rawEntry.response.content.text;
	if (bodyText && isInterestingMimeType(entry.mimeType)) {
		const preview = await refStore.formatValue(
			bodyText.slice(0, 120),
			`e${entry.index}-err-body`,
		);
		parts.push(`       Body: ${preview}`);
	}

	return parts.join("\n");
}
