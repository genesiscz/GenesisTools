import type { Command } from "commander";
import { SessionManager } from "@app/har-analyzer/core/session-manager";
import { loadHarFile } from "@app/har-analyzer/core/parser";
import type { HarFile, HarHeader, HarSession } from "@app/har-analyzer/types";

type HeaderScope = "request" | "response" | "both";

interface HeadersOptions {
	scope: HeaderScope;
}

interface HeaderInfo {
	name: string;
	values: Set<string>;
	entryIndices: number[];
}

function collectHeaders(
	har: HarFile,
	session: HarSession,
	scope: HeaderScope,
): Map<string, HeaderInfo> {
	const headerMap = new Map<string, HeaderInfo>();

	function processHeaders(headers: HarHeader[], entryIndex: number): void {
		for (const h of headers) {
			const key = h.name.toLowerCase();
			const existing = headerMap.get(key);
			if (existing) {
				existing.values.add(h.value);
				existing.entryIndices.push(entryIndex);
			} else {
				headerMap.set(key, {
					name: h.name,
					values: new Set([h.value]),
					entryIndices: [entryIndex],
				});
			}
		}
	}

	for (const entry of session.entries) {
		const harEntry = har.log.entries[entry.index];

		if (scope === "request" || scope === "both") {
			processHeaders(harEntry.request.headers, entry.index);
		}

		if (scope === "response" || scope === "both") {
			processHeaders(harEntry.response.headers, entry.index);
		}
	}

	return headerMap;
}

function formatHeaderValue(info: HeaderInfo): string {
	if (info.values.size === 1) {
		const value = [...info.values][0];
		if (value.length > 80) {
			return value.slice(0, 77) + "...";
		}
		return value;
	}
	return `(${info.values.size} distinct values)`;
}

function formatEntryRefs(indices: number[]): string {
	const unique = [...new Set(indices)];
	if (unique.length <= 6) {
		return `[${unique.map((i) => `e${i}`).join(",")}]`;
	}
	const shown = unique.slice(0, 5).map((i) => `e${i}`).join(",");
	return `[${shown},+${unique.length - 5} more]`;
}

export function registerHeadersCommand(program: Command): void {
	program
		.command("headers")
		.description("Show deduplicated header analysis")
		.option("--scope <scope>", "Scope: request, response, both", "both")
		.action(async (options: HeadersOptions) => {
			const sm = new SessionManager();
			const session = await sm.loadSession();

			if (!session) {
				console.error("No session loaded. Use `load <file>` first.");
				process.exit(1);
			}

			const har = await loadHarFile(session.sourceFile);
			const headerMap = collectHeaders(har, session, options.scope);

			const totalEntries = session.entries.length;
			const threshold = totalEntries * 0.5;

			const common: HeaderInfo[] = [];
			const uncommon: HeaderInfo[] = [];

			for (const info of headerMap.values()) {
				const uniqueEntries = new Set(info.entryIndices).size;
				if (uniqueEntries > threshold) {
					common.push(info);
				} else {
					uncommon.push(info);
				}
			}

			// Sort alphabetically within each group
			common.sort((a, b) => a.name.localeCompare(b.name));
			uncommon.sort((a, b) => a.name.localeCompare(b.name));

			const lines: string[] = [];

			lines.push(`Header Analysis (scope: ${options.scope}, ${totalEntries} entries)`);
			lines.push("");

			if (common.length > 0) {
				lines.push(`Common Headers (present in >50% of entries):`);
				lines.push("─".repeat(60));
				for (const info of common) {
					const value = formatHeaderValue(info);
					lines.push(`  ${info.name}: ${value}`);
				}
				lines.push("");
			}

			if (uncommon.length > 0) {
				lines.push(`Uncommon Headers:`);
				lines.push("─".repeat(60));
				for (const info of uncommon) {
					const value = formatHeaderValue(info);
					const refs = formatEntryRefs(info.entryIndices);
					lines.push(`  ${info.name}: ${value}  ${refs}`);
				}
				lines.push("");
			}

			lines.push(`${headerMap.size} unique header names (${common.length} common, ${uncommon.length} uncommon)`);

			console.log(lines.join("\n"));
		});
}
