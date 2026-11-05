#!/usr/bin/env bun
/**
 * Prints what every agent-context gatherer answers in this process, with its wall time, as one JSON object.
 * The baseline of the agent-context unification: run it from Claude, from a Codex worker and from a plain shell
 * (`env -i HOME=$HOME PATH=$PATH bun scripts/benchmarks/agent-context/probe.ts`) before the change and after it,
 * then compare the two files. `--out <file>` writes the JSON there instead of stdout.
 */
import { writeFileSync } from "node:fs";
import { captureCallerContext } from "@app/say/lib/caller";
import { agentSessionIds, assignedSessionId, resolveAgentHost } from "@genesiscz/utils/agent/host";
import { gatherHarnessPoster, getAgentRuntimeContext } from "@genesiscz/utils/agent/runtime";
import { agentFailureCaller } from "@genesiscz/utils/cli/failures/agent-caller";
import { SafeJSON } from "@genesiscz/utils/json";

interface Probe {
    name: string;
    ms: number;
    value?: unknown;
    error?: string;
}

async function probe(name: string, read: () => unknown): Promise<Probe> {
    const started = performance.now();

    try {
        const value = await read();
        return { name, ms: Math.round((performance.now() - started) * 100) / 100, value };
    } catch (err) {
        return { name, ms: Math.round((performance.now() - started) * 100) / 100, error: String(err) };
    }
}

const env = process.env;
const probes = [
    await probe("resolveAgentHost", () => resolveAgentHost(env)),
    await probe("agentSessionIds", () => agentSessionIds(env)),
    await probe("assignedSessionId", () => assignedSessionId(env)),
    await probe("getAgentRuntimeContext", () => getAgentRuntimeContext()),
    await probe("gatherHarnessPoster", () => gatherHarnessPoster()),
    await probe("agentFailureCaller", () => agentFailureCaller()),
    await probe("captureCallerContext (say)", () => captureCallerContext()),
];
const result = { at: new Date().toISOString(), pid: process.pid, ppid: process.ppid, probes };
const outAt = process.argv.indexOf("--out");
const text = SafeJSON.stringify(result, null, 2);

if (outAt > 0 && process.argv[outAt + 1]) {
    writeFileSync(process.argv[outAt + 1], `${text}\n`);
} else {
    process.stdout.write(`${text}\n`);
}
