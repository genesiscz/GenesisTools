#!/usr/bin/env bun
/**
 * One fresh process that runs the read-only part of the Claude sub-agent listing refresh the widget watch runs on a
 * burst of sub-agent transcript writes (`getSessionListing({ subagentsOnly: true, refresh: true })`): the discovery
 * (`agentsOnly`) and the candidate pass that takes each file's mtime for the window. One cold pass, then `passes`
 * warm ones (the resident watch keeps its folder-listing cache). Prints one JSON object on stdout. Driven by
 * `agents-listing.ts`; run alone to look at one sample.
 *
 *   bun agents-listing-child.ts <checkout> [passes]
 *
 * The modules are imported from `<checkout>`, so another worktree's copy (an older commit) runs its own code.
 */
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";

const [checkout, passesArg] = process.argv.slice(2);

if (!checkout) {
    process.stderr.write("usage: agents-listing-child.ts <checkout> [passes]\n");
    process.exit(2);
}

const passes = Number(passesArg ?? "8");
const { resolveHistoryProvider } = await import(join(checkout, "src/utils/agent-sessions/provider.ts"));
const { historyCandidates } = await import(join(checkout, "src/utils/agent-sessions/search-candidates.ts"));
const provider = resolveHistoryProvider("claude");
const roots: string[] = provider.reader.roots();
const metrics: Record<string, number> = {};
const discoverWarm: number[] = [];
const candidatesWarm: number[] = [];

function cpuMs(started: NodeJS.CpuUsage): number {
    const used = process.cpuUsage(started);
    return (used.user + used.system) / 1000;
}

const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;

for (let pass = 0; pass <= passes; pass++) {
    let started = process.cpuUsage();
    const found = await provider.reader.discover(roots, { agentsOnly: true });
    const discoverMs = cpuMs(started);
    started = process.cpuUsage();
    const candidates = await historyCandidates({ sources: found.sources, filters: {} });
    const candidatesMs = cpuMs(started);

    if (pass === 0) {
        metrics["discover.coldMs"] = discoverMs;
        metrics["candidates.coldMs"] = candidatesMs;
        metrics.sources = found.sources.length;
        // The check: both arms must find the same files with the same window inputs.
        const fingerprint = found.sources
            .map(
                (source: { filePath: string; metadataPaths?: string[] }) =>
                    `${source.filePath}|${(source.metadataPaths ?? []).join(",")}`
            )
            .sort()
            .join("\n");
        metrics.sourcesHash = Number(BigInt(Bun.hash(fingerprint)) % 1_000_000_007n);
        metrics.completeRoots = found.completeRoots.length;
        metrics.issues = found.issues.length;
        metrics.candidates = candidates.length;
    } else {
        discoverWarm.push(discoverMs);
        candidatesWarm.push(candidatesMs);
    }
}

metrics["discover.warmMs"] = median(discoverWarm);
metrics["candidates.warmMs"] = median(candidatesWarm);
process.stdout.write(`${SafeJSON.stringify(metrics, { strict: true })}\n`);
