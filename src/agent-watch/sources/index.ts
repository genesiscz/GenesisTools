import type { AgentSnapshot, CollectOptions } from "../types";
import { defaultClaudeRoot, readClaudeSnapshots } from "./claude";
import { defaultTaskDir, readTaskSnapshots } from "./task";
import { defaultWorkflowRoot, readWorkflowSnapshots } from "./workflows";

export { defaultTaskDir, defaultClaudeRoot, defaultWorkflowRoot };

export async function collectSnapshots(opts: CollectOptions): Promise<AgentSnapshot[]> {
    const { sources, now, stallTimeoutMs, roots } = opts;
    const results: AgentSnapshot[] = [];

    if (sources.includes("task")) {
        results.push(...(await readTaskSnapshots({ dir: roots?.task, now, stallTimeoutMs })));
    }

    if (sources.includes("claude")) {
        results.push(...(await readClaudeSnapshots({ root: roots?.claude, now, stallTimeoutMs })));
    }

    if (sources.includes("workflows")) {
        results.push(...(await readWorkflowSnapshots({ root: roots?.workflow, now, stallTimeoutMs })));
    }

    results.sort((a, b) => b.lastOutputAt - a.lastOutputAt);
    return results;
}
