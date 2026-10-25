#!/usr/bin/env bun
/**
 * One fresh process that reads Claude sessions from their end through the real door, `readSessionBackward`, as the
 * decision Stop hook does (8 MB cap, `until` = an entry older than a cut). Prints one JSON object on stdout. Driven
 * by `read-backward.ts`; run alone to look at one sample.
 *
 *   bun read-backward-child.ts <checkout> <cut ISO time> <transcript...>
 *
 * The module is imported from `<checkout>`, so another worktree's copy (an older commit) runs its own code: Bun
 * resolves each file's path aliases through the tsconfig nearest to it.
 */
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";

const [checkout, cutIso, ...transcripts] = process.argv.slice(2);

if (!checkout || !cutIso || transcripts.length === 0) {
    process.stderr.write("usage: read-backward-child.ts <checkout> <cut ISO time> <transcript...>\n");
    process.exit(2);
}

const { readSessionBackward } = await import(join(checkout, "src/utils/agent-sessions/session-backward.ts"));
const cut = Date.parse(cutIso);
/** The hook's predicate: stop at the first entry older than the cut. */
const olderThanCut = (entry: { timestamp?: string }) => {
    const at = entry.timestamp ? Date.parse(entry.timestamp) : Number.NaN;
    return Number.isFinite(at) && at < cut;
};
const SHAPES = {
    // The hook's read: back to the cut, or the 8 MB cap.
    hook: { maxBytes: 8 * 1024 * 1024, until: olderThanCut },
    // The worst case for the per-entry loop: no entry accepted, so every entry of the newest 16 MB is tested.
    full: { maxBytes: 16 * 1024 * 1024, until: () => false },
};
const WARM_PASSES = 5;
const metrics: Record<string, number> = {};

for (const [shape, options] of Object.entries(SHAPES)) {
    const warm: number[] = [];

    for (let pass = 0; pass <= WARM_PASSES; pass++) {
        let entries = 0;
        let found = 0;
        const started = process.cpuUsage();

        for (const transcriptPath of transcripts) {
            const read = await readSessionBackward({ kind: "claude", transcriptPath, ...options });
            entries += read.entries.length;
            found += read.found ? 1 : 0;
        }

        const cpu = process.cpuUsage(started);
        const cpuMs = (cpu.user + cpu.system) / 1000;

        if (pass === 0) {
            metrics[`${shape}.cold.cpuMs`] = cpuMs;
            // The check: both arms must read the same entries and stop at the same places.
            metrics[`${shape}.entries`] = entries;
            metrics[`${shape}.found`] = found;
        } else {
            warm.push(cpuMs);
        }
    }

    warm.sort((a, b) => a - b);
    metrics[`${shape}.warm.cpuMs`] = warm[Math.floor(warm.length / 2)] ?? Number.NaN;
}

process.stdout.write(`${SafeJSON.stringify(metrics, { strict: true })}\n`);
