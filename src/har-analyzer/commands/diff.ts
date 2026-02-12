import type { Command } from "commander";
import { SessionManager } from "@app/har-analyzer/core/session-manager";
import { loadHarFile } from "@app/har-analyzer/core/parser";
import { formatBytes, formatDuration } from "@app/utils/format";
import type { HarEntry, HarHeader } from "@app/har-analyzer/types";
import { RefStoreManager } from "@app/har-analyzer/core/ref-store";
import { isInterestingMimeType } from "@app/har-analyzer/types";

function parseEntryIndex(entry: string): number {
	const cleaned = entry.startsWith("e") ? entry.slice(1) : entry;
	const index = Number.parseInt(cleaned, 10);
	if (Number.isNaN(index)) {
		throw new Error(`Invalid entry reference: "${entry}". Use format like "e14" or "14".`);
	}
	return index;
}

function headerMap(headers: HarHeader[]): Map<string, string> {
	const map = new Map<string, string>();
	for (const h of headers) {
		map.set(h.name.toLowerCase(), h.value);
	}
	return map;
}

export function registerDiffCommand(program: Command): void {
	program
		.command("diff <entry1> <entry2>")
		.description("Compare two entries side-by-side")
		.action(async (entry1Str: string, entry2Str: string) => {
			const idx1 = parseEntryIndex(entry1Str);
			const idx2 = parseEntryIndex(entry2Str);

			const sm = new SessionManager();
			const session = await sm.loadSession();

			if (!session) {
				console.error("No session loaded. Use `load <file>` first.");
				process.exit(1);
			}

			for (const idx of [idx1, idx2]) {
				if (idx < 0 || idx >= session.entries.length) {
					console.error(`Entry e${idx} not found. Session has ${session.entries.length} entries (0-${session.entries.length - 1}).`);
					process.exit(1);
				}
			}

			const harFile = await loadHarFile(session.sourceFile);
			const e1 = harFile.log.entries[idx1];
			const e2 = harFile.log.entries[idx2];
			const ie1 = session.entries[idx1];
			const ie2 = session.entries[idx2];
			const refStore = new RefStoreManager(session.sourceHash);

			const lines: string[] = [];
			lines.push(`Diff: e${idx1} vs e${idx2}`);
			lines.push("");

			// Basic properties
			const label1 = `e${idx1}`;
			const label2 = `e${idx2}`;
			const colW = 30;

			lines.push(`  ${"Property".padEnd(16)} ${label1.padEnd(colW)} ${label2}`);
			lines.push(`  ${"─".repeat(16)} ${"─".repeat(colW)} ${"─".repeat(colW)}`);

			const props: Array<[string, string, string]> = [
				["Method", e1.request.method, e2.request.method],
				["URL", ie1.path, ie2.path],
				["Status", `${e1.response.status} ${e1.response.statusText}`, `${e2.response.status} ${e2.response.statusText}`],
				["Time", formatDuration(e1.time), formatDuration(e2.time)],
				["Req Size", formatBytes(ie1.requestSize), formatBytes(ie2.requestSize)],
				["Res Size", formatBytes(ie1.responseSize), formatBytes(ie2.responseSize)],
				["MIME Type", ie1.mimeType, ie2.mimeType],
			];

			for (const [label, v1, v2] of props) {
				const marker = v1 !== v2 ? "* " : "  ";
				const val1 = v1.length > colW ? `${v1.slice(0, colW - 3)}...` : v1;
				const val2 = v2.length > colW ? `${v2.slice(0, colW - 3)}...` : v2;
				lines.push(`${marker}${label.padEnd(16)} ${val1.padEnd(colW)} ${val2}`);
			}

			lines.push("");

			// Header diff (show only differences)
			const diffHeaders = diffHeaderSets(e1, e2);
			if (diffHeaders.length > 0) {
				lines.push("Headers (different only):");
				for (const dh of diffHeaders) {
					const v1 = truncVal(dh.val1 ?? "(absent)", colW);
					const v2 = truncVal(dh.val2 ?? "(absent)", colW);
					lines.push(`  ${dh.scope} ${dh.name.padEnd(20)} ${v1.padEnd(colW)} ${v2}`);
				}
				lines.push("");
			}

			// Body comparison
			lines.push("Body:");
			await appendBodyLine(lines, `  ${label1}:`, e1, idx1, refStore);
			await appendBodyLine(lines, `  ${label2}:`, e2, idx2, refStore);

			console.log(lines.join("\n"));
		});
}

function truncVal(val: string, max: number): string {
	return val.length > max ? `${val.slice(0, max - 3)}...` : val;
}

interface HeaderDiff {
	scope: string; // "Rq" or "Rs"
	name: string;
	val1: string | null;
	val2: string | null;
}

function diffHeaderSets(e1: HarEntry, e2: HarEntry): HeaderDiff[] {
	const diffs: HeaderDiff[] = [];

	const check = (scope: string, h1: HarHeader[], h2: HarHeader[]) => {
		const map1 = headerMap(h1);
		const map2 = headerMap(h2);
		const allKeys = new Set([...map1.keys(), ...map2.keys()]);

		for (const key of allKeys) {
			const v1 = map1.get(key) ?? null;
			const v2 = map2.get(key) ?? null;
			if (v1 !== v2) {
				diffs.push({ scope, name: key, val1: v1, val2: v2 });
			}
		}
	};

	check("Rq", e1.request.headers, e2.request.headers);
	check("Rs", e1.response.headers, e2.response.headers);

	return diffs;
}

async function appendBodyLine(
	lines: string[],
	prefix: string,
	entry: HarEntry,
	idx: number,
	refStore: RefStoreManager,
): Promise<void> {
	const content = entry.response.content;
	if (content.encoding === "base64") {
		lines.push(`${prefix} [binary: ${content.mimeType}, ${formatBytes(content.size)}]`);
	} else if (content.text && isInterestingMimeType(content.mimeType)) {
		const formatted = await refStore.formatValue(content.text, `e${idx}.rs.body`);
		lines.push(`${prefix} ${formatted}`);
	} else if (content.text) {
		lines.push(`${prefix} [skipped: ${content.mimeType}, ${formatBytes(content.size)}]`);
	} else {
		lines.push(`${prefix} (empty)`);
	}
}
