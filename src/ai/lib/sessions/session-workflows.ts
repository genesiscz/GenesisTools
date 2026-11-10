import { resolveHistoryProvider } from "@genesiscz/utils/agent-sessions/provider";
import {
    pickWorkflowRun,
    type WorkflowAgent,
    type WorkflowAgentGrep,
    type WorkflowGrepOptions,
    type WorkflowRun,
    workflowRunTotals,
} from "@genesiscz/utils/agent-sessions/workflow-types";
import type { ResolvedTranscript } from "@genesiscz/utils/ai/transcripts/resolve";
import { listSubagents } from "@genesiscz/utils/ai/transcripts/subagents";
import {
    sessionWorkflowRuns,
    summarizeWorkflowRun,
    type WorkflowAgentUsage,
    workflowAgentUsage,
    workflowReaderSupport,
} from "@genesiscz/utils/ai/transcripts/workflows";
import { concurrentMap } from "@genesiscz/utils/async";
import { formatBytes, formatCost, formatDuration, formatTokens } from "@genesiscz/utils/format";
import { logger, out } from "@genesiscz/utils/logger";
import { formatTable } from "@genesiscz/utils/table";

const SCHEMA = "sessions.workflows@1";

/** A harness with no reader: the answer is the reason, never "0 runs". */
function noReaderLine(provider: string, reason: string): string {
    return `${provider}: no workflow reader. ${reason}`;
}

/** `tools ai sessions workflows list` with no session: which providers have a workflow reader, and why not. */
export function printWorkflowReaders(options: { json?: boolean }): void {
    const readers = workflowReaderSupport();

    if (options.json) {
        out.result({ schema: SCHEMA, readers: readers.map(({ provider, support }) => ({ provider, ...support })) });
        return;
    }

    for (const { provider, support } of readers) {
        out.println(
            support.supported
                ? `${provider}: workflow reader. Name a session to list its runs.`
                : noReaderLine(provider, support.reason)
        );
    }
}

/**
 * The runs of a session, or null after it printed why there are none to read. `strict` makes a harness with no
 * reader a failure: `show`, `grep` and `result` cannot answer, while `list` answers with the reason.
 */
async function runsOf(
    session: ResolvedTranscript,
    options: { json?: boolean; strict: boolean }
): Promise<WorkflowRun[] | null> {
    const runs = await sessionWorkflowRuns(session);

    if (runs.supported) {
        return runs.items;
    }

    if (options.strict) {
        process.exitCode = 1;
        out.printlnErr(noReaderLine(session.provider, runs.reason));
        return null;
    }

    if (options.json) {
        out.result({
            schema: SCHEMA,
            sessionId: session.sessionId,
            provider: session.provider,
            reader: { supported: false, reason: runs.reason },
            runs: [],
        });
    } else {
        out.println(noReaderLine(session.provider, runs.reason));
    }

    return null;
}

export async function printWorkflowList(session: ResolvedTranscript, options: { json?: boolean }): Promise<void> {
    const runs = await runsOf(session, { json: options.json, strict: false });

    if (!runs) {
        return;
    }

    const summaries = runs.map(summarizeWorkflowRun);

    if (options.json) {
        out.result({
            schema: SCHEMA,
            sessionId: session.sessionId,
            provider: session.provider,
            reader: { supported: true },
            runs: summaries,
        });
        return;
    }

    const agents = summaries.reduce((sum, run) => sum + run.agents, 0);
    const results = summaries.reduce((sum, run) => sum + run.results, 0);
    out.println(`${summaries.length} workflow runs in ${session.sessionId}: ${agents} agents, ${results} results`);

    if (summaries.length === 0) {
        return;
    }

    out.println(
        formatTable(
            summaries.map((run) => [
                run.runId,
                run.name ?? "(no record)",
                run.status ?? "no record",
                run.startedAt ?? "",
                run.durationMs === null ? "" : formatDuration(run.durationMs),
                String(run.agents),
                String(run.transcripts),
                String(run.results),
                run.phases.join(", "),
            ]),
            ["RUN", "NAME", "STATUS", "STARTED (UTC)", "DURATION", "AGENTS", "FILES", "RESULTS", "PHASES"],
            { alignRight: [5, 6, 7], maxColWidth: 44 }
        )
    );
}

function usageCells(usage: WorkflowAgentUsage | null | undefined): string[] {
    if (!usage) {
        return ["", "", ""];
    }

    const tokens = usage.input + usage.cacheRead + usage.cacheWrite + usage.output;
    return [String(usage.calls), formatTokens(tokens), usage.costUsd === null ? "unpriced" : formatCost(usage.costUsd)];
}

async function usageOf(
    session: ResolvedTranscript,
    run: WorkflowRun
): Promise<Map<WorkflowAgent, WorkflowAgentUsage | null>> {
    return concurrentMap({
        items: run.agents.filter((agent) => agent.transcript !== null),
        fn: (agent) => workflowAgentUsage(session.provider, agent.transcript ?? ""),
        concurrency: 8,
        onError: (agent, error) =>
            logger.warn({ error, transcript: agent.transcript }, "[ai sessions workflows] usage unreadable"),
    });
}

export async function printWorkflowRun(
    session: ResolvedTranscript,
    wanted: string,
    options: { json?: boolean; usage?: boolean }
): Promise<void> {
    const runs = await runsOf(session, { strict: true });

    if (!runs) {
        return;
    }

    const run = pickWorkflowRun(runs, wanted);
    const usage = options.usage ? await usageOf(session, run) : null;
    // Whether each agent still works comes from its own transcript's tail, the same reading a sub-agent listing shows.
    const live = new Map(listSubagents(session).subagents.map((agent) => [agent.filePath, agent]));

    if (options.json) {
        out.result({
            schema: SCHEMA,
            sessionId: session.sessionId,
            run,
            ...(usage
                ? { usage: Object.fromEntries(run.agents.map((agent) => [agent.agentId, usage.get(agent) ?? null])) }
                : {}),
        });
        return;
    }

    const totals = workflowRunTotals(run);
    out.println(`${run.runId}  ${run.name ?? "(no record)"}  ${run.status ?? "no record"}`);

    for (const [key, value] of [
        ["summary", run.summary],
        // A killed run records a whole stack trace; its first line is the reason, and --json has the rest.
        ["error", run.error?.split("\n")[0] ?? null],
        ["started", run.startedAt],
        ["duration", run.durationMs === null ? null : formatDuration(run.durationMs)],
        ["model", run.defaultModel],
        ["phases", run.phases.join(", ") || null],
        ["script", run.scriptPath],
        ["record", run.recordPath],
        ["journal", run.journalPath],
        ["transcripts", run.transcriptDir],
    ] as const) {
        if (value) {
            out.println(`  ${key.padEnd(12)}${value}`);
        }
    }

    out.println(
        `  ${"agents".padEnd(12)}${totals.agents} (${totals.withTranscript} with a transcript, ${totals.withResult} with a result, ${formatBytes(totals.bytes)}); the run record says ${run.reported.agents ?? "nothing"}`
    );
    out.println(
        formatTable(
            run.agents.map((agent) => [
                agent.label ?? "",
                agent.phase ?? "",
                agent.model ?? "",
                agent.state ?? "",
                agent.transcript ? (live.get(agent.transcript)?.state ?? "") : "no file",
                agent.hasResult ? formatBytes(agent.resultBytes) : "none",
                formatBytes(agent.bytes),
                agent.sources.join("+"),
                ...(usage ? usageCells(usage.get(agent)) : []),
                agent.agentId,
            ]),
            [
                "LABEL",
                "PHASE",
                "MODEL",
                "RECORD",
                "TRANSCRIPT",
                "RESULT",
                "SIZE",
                "SOURCES",
                ...(usage ? ["CALLS", "TOKENS", "COST"] : []),
                "AGENT",
            ],
            { maxColWidth: 40 }
        )
    );
}

export interface WorkflowGrepRequest extends WorkflowGrepOptions {
    pattern: RegExp;
    /** A run id prefix or a workflow name; every run when absent. */
    run?: string;
    json?: boolean;
}

export async function printWorkflowGrep(session: ResolvedTranscript, request: WorkflowGrepRequest): Promise<void> {
    const runs = await runsOf(session, { strict: true });

    if (!runs) {
        return;
    }

    const scope = request.run ? [pickWorkflowRun(runs, request.run)] : runs;
    const found: WorkflowAgentGrep[] = await resolveHistoryProvider(session.provider).reader.workflows.grep(
        scope,
        request.pattern,
        { maxHits: request.maxHits, before: request.before, context: request.context }
    );

    if (request.json) {
        out.result({ schema: SCHEMA, sessionId: session.sessionId, pattern: request.pattern.source, agents: found });
        return;
    }

    const searched = scope.reduce((sum, run) => sum + workflowRunTotals(run).withTranscript, 0);
    out.println(
        `${found.length} of ${searched} workflow agents match /${request.pattern.source}/ in ${session.sessionId}`
    );

    for (const agent of found) {
        out.println(
            `\n${agent.runId}  ${agent.agent.label ?? agent.agent.agentId}  ${agent.agent.agentId}  ${agent.matchingLines} matching line(s)`
        );

        for (const hit of agent.hits) {
            // `assistant`: the agent wrote it. `tool-result`: it was shown it. `prompt`: it was told it.
            out.println(`  L${hit.line} ${hit.timestamp ?? "no time"} [${hit.where}] ${hit.excerpt}`);
        }
    }
}

/** The final structured answer of one agent of a run, by agent id or by its label. */
export async function printWorkflowResult(
    session: ResolvedTranscript,
    wantedRun: string,
    wantedAgent: string
): Promise<void> {
    const runs = await runsOf(session, { strict: true });

    if (!runs) {
        return;
    }

    const run = pickWorkflowRun(runs, wantedRun);
    const agent = run.agents.find((candidate) => candidate.agentId === wantedAgent || candidate.label === wantedAgent);

    if (!agent) {
        throw new Error(
            `no agent "${wantedAgent}" in ${run.runId}; it has: ${run.agents.map((candidate) => `${candidate.agentId} (${candidate.label ?? "no label"})`).join(", ")}`
        );
    }

    const results = resolveHistoryProvider(session.provider).reader.workflows.results(run);

    if (!results.has(agent.agentId)) {
        throw new Error(
            `${agent.agentId} (${agent.label ?? "no label"}) returned no result in ${run.runId}: the journal has none for it${run.status ? ` (run status: ${run.status})` : ""}`
        );
    }

    out.result({
        schema: SCHEMA,
        runId: run.runId,
        agentId: agent.agentId,
        label: agent.label,
        result: results.get(agent.agentId),
    });
}
