#!/usr/bin/env bun
/**
 * One fresh process that runs each provider's session discovery the way the session listing calls it
 * (`excludeAgents: true`, the reader's own roots), twice: the first pass is what a cold CLI process pays,
 * the second what the resident hub server pays with its folder-listing cache warm. Prints one JSON object
 * on stdout. Driven by `session-listing.ts`; run alone to look at one sample.
 */
import { resolveHistoryProvider } from "@genesiscz/utils/agent-sessions/provider";
import { SafeJSON } from "@genesiscz/utils/json";

const PROVIDERS = ["claude", "grok", "codex"] as const;
const metrics: Record<string, number> = {};

for (const pass of ["cold", "warm"] as const) {
    for (const name of PROVIDERS) {
        const provider = resolveHistoryProvider(name);
        const roots = provider.reader.roots();
        const cpuStarted = process.cpuUsage();
        const wallStarted = performance.now();
        const found = await provider.reader.discover(roots, { excludeAgents: true });
        const cpu = process.cpuUsage(cpuStarted);
        metrics[`${name}.${pass}.cpuMs`] = (cpu.user + cpu.system) / 1000;
        metrics[`${name}.${pass}.wallMs`] = performance.now() - wallStarted;
        metrics[`${name}.sources`] = found.sources.length;
    }
}

process.stdout.write(`${SafeJSON.stringify(metrics, { strict: true })}\n`);
