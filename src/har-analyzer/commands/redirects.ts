import { printFormatted, truncatePath } from "@app/har-analyzer/core/formatter";
import { SessionManager } from "@app/har-analyzer/core/session-manager";
import type { IndexedEntry, OutputOptions } from "@app/har-analyzer/types";
import type { Command } from "commander";

function urlMatches(fullUrl: string, target: string): boolean {
    if (fullUrl === target) return true;
    try {
        const a = new URL(fullUrl);
        const b = new URL(target, fullUrl); // resolve relative target against fullUrl
        return a.origin === b.origin && a.pathname === b.pathname;
    } catch {
        return fullUrl.endsWith(target);
    }
}

interface RedirectChain {
    entries: IndexedEntry[];
    finalStatus: number;
}

function buildRedirectChains(entries: IndexedEntry[]): RedirectChain[] {
    const chains: RedirectChain[] = [];
    const visited = new Set<number>();

    for (const entry of entries) {
        // Skip if already part of a chain or not a redirect
        if (visited.has(entry.index) || !entry.isRedirect) continue;

        // Check if this entry is the target of another redirect (i.e., not a chain start)
        const isTarget = entries.some((e) => e.isRedirect && e.redirectURL && urlMatches(entry.url, e.redirectURL));
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
    visited: Set<number>
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
            lines.push(
                `  ${id}  ${method} ${path}  -> ${entry.status} -> ${nextEntry ? `e${nextEntry.index}` : ""}  ${nextPath}`
            );
        }
    }

    return lines.join("\n");
}

export function registerRedirectsCommand(program: Command): void {
    program
        .command("redirects")
        .description("Show redirect chains")
        .action(async () => {
            const parentOpts = program.opts<OutputOptions>();
            const sm = new SessionManager();
            const session = await sm.requireSession(parentOpts.session);

            const chains = buildRedirectChains(session.entries);

            if (chains.length === 0) {
                console.log("No redirect chains found.");
                return;
            }

            const output =
                chains.map((chain, i) => formatChain(chain, i + 1)).join("\n\n") +
                `\n\n${chains.length} redirect chain${chains.length !== 1 ? "s" : ""} found`;
            await printFormatted(output, parentOpts.format);
        });
}
