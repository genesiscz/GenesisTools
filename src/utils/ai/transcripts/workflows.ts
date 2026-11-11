/**
 * A session's multi-agent runs for a listing. Provider-neutral: every fact comes from the session's reader
 * (`NativeSessionReader.workflows`), so this file names no transcript format and no folder.
 */
import { callCostUsd } from "@genesiscz/utils/agent-sessions/analysis/cost";
import { factsOf, type SessionFacts } from "@genesiscz/utils/agent-sessions/analysis-types";
import { resolveHistoryProvider } from "@genesiscz/utils/agent-sessions/provider";
import {
    type WorkflowReaderSupport,
    type WorkflowRun,
    workflowRunTotals,
} from "@genesiscz/utils/agent-sessions/workflow-types";
import { ACCOUNT_PROVIDER_ALIASES, type AccountProviderAlias } from "@genesiscz/utils/ai/providers/alias-list";
import type { ResolvedTranscript } from "./resolve";
import { type ListSubagentsOptions, listSubagents, type SessionSubagents } from "./subagents";

/** One run as a listing shows it. `tools ai sessions workflows show` has the whole run. */
export interface WorkflowRunSummary {
    runId: string;
    name: string | null;
    /** The run record's status (`completed`, `killed`); null when the run left no record. */
    status: string | null;
    /** ISO instant in UTC. */
    startedAt: string | null;
    durationMs: number | null;
    /** Agents named by the run record, the journal or the transcript folder, each once. */
    agents: number;
    /** Agents whose transcript exists. */
    transcripts: number;
    /** Agents whose final answer the journal holds. */
    results: number;
    phases: string[];
}

export function summarizeWorkflowRun(run: WorkflowRun): WorkflowRunSummary {
    const totals = workflowRunTotals(run);

    return {
        runId: run.runId,
        name: run.name,
        status: run.status,
        startedAt: run.startedAt,
        durationMs: run.durationMs,
        agents: totals.agents,
        transcripts: totals.withTranscript,
        results: totals.withResult,
        phases: run.phases,
    };
}

/** The runs of one session, or the reason its harness has no reader for them. */
export function sessionWorkflowRuns(resolved: ResolvedTranscript): Promise<SessionFacts<WorkflowRun>> {
    return resolveHistoryProvider(resolved.provider).reader.workflows.runs(resolved.filePath);
}

/** A session's sub-agents with its workflow runs: what `tools ai sessions subagents <id> --json` prints. */
export interface SessionAgents extends SessionSubagents {
    workflowRuns: WorkflowRunSummary[];
    /** `supported: false` with the reason for a harness that has no workflow reader: its empty run list is not "none ran". */
    workflowReader: WorkflowReaderSupport;
}

/**
 * Every agent of a session: the agents it and its agents started, the agents of its workflow runs (each row names its
 * run in `workflow`), and a summary of each run.
 */
export async function listSessionAgents(
    resolved: ResolvedTranscript,
    options: ListSubagentsOptions = {}
): Promise<SessionAgents> {
    const runs = await sessionWorkflowRuns(resolved);

    return {
        ...listSubagents(resolved, options),
        workflowRuns: factsOf(runs).map(summarizeWorkflowRun),
        workflowReader: runs.supported ? { supported: true } : { supported: false, reason: runs.reason },
    };
}

/** Which providers have a workflow reader, and why the others have none. No file is read. */
export function workflowReaderSupport(): Array<{ provider: AccountProviderAlias; support: WorkflowReaderSupport }> {
    return ACCOUNT_PROVIDER_ALIASES.map((provider) => ({
        provider,
        support: resolveHistoryProvider(provider).reader.workflows.support,
    }));
}

/** What one workflow agent's transcript cost: its model calls, each once, priced like any session's. */
export interface WorkflowAgentUsage {
    calls: number;
    input: number;
    cacheRead: number;
    cacheWrite: number;
    output: number;
    /** List-price dollars; null when no call had a known rate. */
    costUsd: number | null;
    models: string[];
    firstAt: string | null;
    lastAt: string | null;
}

/** What a run's agents cost together. `costUsd` is null when no call of the run had a known rate. */
export interface WorkflowRunUsage {
    calls: number;
    input: number;
    cacheRead: number;
    cacheWrite: number;
    output: number;
    costUsd: number | null;
    /** Agents with a transcript whose calls could not be read: they are missing from the sums. */
    unread: number;
}

export function sumWorkflowUsage(agents: Iterable<WorkflowAgentUsage | null | undefined>): WorkflowRunUsage {
    const total: WorkflowRunUsage = {
        calls: 0,
        input: 0,
        cacheRead: 0,
        cacheWrite: 0,
        output: 0,
        costUsd: null,
        unread: 0,
    };

    for (const usage of agents) {
        if (!usage) {
            total.unread++;
            continue;
        }

        total.calls += usage.calls;
        total.input += usage.input;
        total.cacheRead += usage.cacheRead;
        total.cacheWrite += usage.cacheWrite;
        total.output += usage.output;

        if (usage.costUsd !== null) {
            total.costUsd = (total.costUsd ?? 0) + usage.costUsd;
        }
    }

    return total;
}

/** Null when the provider's reader cannot trace the calls of a transcript. */
export async function workflowAgentUsage(
    provider: ResolvedTranscript["provider"],
    transcript: string
): Promise<WorkflowAgentUsage | null> {
    const trace = await resolveHistoryProvider(provider).reader.analysis.callTrace(transcript);

    if (!trace.supported) {
        return null;
    }

    const usage: WorkflowAgentUsage = {
        calls: 0,
        input: 0,
        cacheRead: 0,
        cacheWrite: 0,
        output: 0,
        costUsd: null,
        models: [],
        firstAt: trace.items[0]?.t ?? null,
        lastAt: trace.items.at(-1)?.t ?? null,
    };

    for (const call of trace.items) {
        usage.calls++;
        usage.input += call.input;
        usage.cacheRead += call.cacheRead;
        usage.cacheWrite += call.cacheWrite;
        usage.output += call.output;
        const usd = callCostUsd(call, { agent: provider });

        if (usd !== null) {
            usage.costUsd = (usage.costUsd ?? 0) + usd;
        }

        if (!usage.models.includes(call.model)) {
            usage.models.push(call.model);
        }
    }

    return usage;
}
