import type { AgentSnapshot, CollectOptions } from "../types";
import { defaultClaudeRoot, readClaudeSnapshots } from "./claude";
import { defaultTaskDir, readTaskSnapshots } from "./task";
import { defaultWorkflowRoot, readWorkflowSnapshots } from "./workflows";

export { defaultClaudeRoot, defaultTaskDir, defaultWorkflowRoot };

export async function collectSnapshots(opts: CollectOptions): Promise<AgentSnapshot[]> {
    const { sources, now, stallTimeoutMs, activeWindowMs, roots } = opts;
    let results: AgentSnapshot[] = [];

    if (sources.includes("task")) {
        results.push(...(await readTaskSnapshots({ dir: roots?.task, now, stallTimeoutMs, activeWindowMs })));
    }

    if (sources.includes("claude")) {
        results.push(...(await readClaudeSnapshots({ root: roots?.claude, now, stallTimeoutMs, activeWindowMs })));
    }

    if (sources.includes("workflows")) {
        results.push(...(await readWorkflowSnapshots({ root: roots?.workflow, now, stallTimeoutMs, activeWindowMs })));
    }

    if (activeWindowMs !== undefined && activeWindowMs > 0) {
        results = results.filter((s) => s.ageMs <= activeWindowMs);
    }

    results.sort((a, b) => b.lastOutputAt - a.lastOutputAt);
    return results;
}
