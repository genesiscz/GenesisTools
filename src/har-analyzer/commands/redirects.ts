import type { Command } from "commander";
import { SessionManager } from "@app/har-analyzer/core/session-manager";
import { truncatePath } from "@app/har-analyzer/core/formatter";
import type { IndexedEntry } from "@app/har-analyzer/types";

interface RedirectChain {
	entries: IndexedEntry[];
	finalStatus: number;
}

function buildRedirectChains(entries: IndexedEntry[]): RedirectChain[] {
	const chains: RedirectChain[] = [];
	const visited = new Set<number>();

	// Index entries by URL for quick lookup
	const entriesByUrl = new Map<string, IndexedEntry[]>();
	for (const entry of entries) {
		const existing = entriesByUrl.get(entry.url);
		if (existing) {
			existing.push(entry);
		} else {
			entriesByUrl.set(entry.url, [entry]);
		}
	}

	for (const entry of entries) {
		// Skip if already part of a chain or not a redirect
		if (visited.has(entry.index) || !entry.isRedirect) continue;

		// Check if this entry is the target of another redirect (i.e., not a chain start)
		const isTarget = entries.some(
			(e) => e.isRedirect && e.redirectURL && entry.url.endsWith(e.redirectURL),
		);
		if (isTarget) continue;

		// Build chain starting from this entry
		const chain: IndexedEntry[] = [entry];
		visited.add(entry.index);

		let current = entry;
		while (current.isRedirect && current.redirectURL) {
			const redirectTarget = current.redirectURL;
			// Find the next entry whose URL matches the redirect target
			const candidates = findNextEntry(entries, redirectTarget, current.index, visited);
			if (!candidates) break;

			chain.push(candidates);
			visited.add(candidates.index);
			current = candidates;
		}

		if (chain.length > 1) {
			chains.push({
				entries: chain,
				finalStatus: chain[chain.length - 1].status,
			});
		}
	}

	return chains;
}

function findNextEntry(
	entries: IndexedEntry[],
	redirectUrl: string,
	afterIndex: number,
	visited: Set<number>,
): IndexedEntry | null {
	// Try exact URL match first, then partial match on path
	for (const entry of entries) {
		if (entry.index <= afterIndex || visited.has(entry.index)) continue;

		if (entry.url === redirectUrl || entry.url.endsWith(redirectUrl)) {
			return entry;
		}
	}

	// Also try matching just the path portion
	for (const entry of entries) {
		if (entry.index <= afterIndex || visited.has(entry.index)) continue;

		try {
			const parsedUrl = new URL(entry.url);
			if (parsedUrl.pathname === redirectUrl || parsedUrl.pathname + parsedUrl.search === redirectUrl) {
				return entry;
			}
		} catch {
			// Skip entries with unparseable URLs
		}
	}

	return null;
}

function formatChain(chain: RedirectChain, chainIndex: number): string {
	const lines: string[] = [];
	const hops = chain.entries.length - 1;
	lines.push(`Chain ${chainIndex} (${hops} hop${hops !== 1 ? "s" : ""}):`);

	for (let i = 0; i < chain.entries.length; i++) {
		const entry = chain.entries[i];
		const id = `e${entry.index}`;
		const method = entry.method;
		const path = truncatePath(entry.path, 30);
		const isFinal = i === chain.entries.length - 1;

		if (isFinal) {
			lines.push(`  ${id}  ${method} ${path}  -> ${entry.status} (final)`);
		} else {
			const nextEntry = chain.entries[i + 1];
			const nextPath = truncatePath(nextEntry.path, 30);
			lines.push(`  ${id}  ${method} ${path}  -> ${entry.status} -> ${nextEntry ? `e${nextEntry.index}` : ""}  ${nextPath}`);
		}
	}

	return lines.join("\n");
}

export function registerRedirectsCommand(program: Command): void {
	program
		.command("redirects")
		.description("Show redirect chains")
		.action(async () => {
			const sm = new SessionManager();
			const session = await sm.loadSession();

			if (!session) {
				console.error("No session loaded. Use `load <file>` first.");
				process.exit(1);
			}

			const chains = buildRedirectChains(session.entries);

			if (chains.length === 0) {
				console.log("No redirect chains found.");
				return;
			}

			const output = chains.map((chain, i) => formatChain(chain, i + 1)).join("\n\n");
			console.log(output);
			console.log(`\n${chains.length} redirect chain${chains.length !== 1 ? "s" : ""} found`);
		});
}
