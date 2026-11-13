import { resolveHistoryProvider } from "@genesiscz/utils/agent-sessions/provider";
import {
    pickWorkflowAgent,
    pickWorkflowRun,
    type WorkflowAgent,
    type WorkflowAgentGrep,
    type WorkflowGrepOptions,
    type WorkflowRun,
    workflowAgentTranscripts,
    workflowRunTotals,
} from "@genesiscz/utils/agent-sessions/workflow-types";
import type { ResolvedTranscript } from "@genesiscz/utils/ai/transcripts/resolve";
import { listSubagents, type SessionSubagent } from "@genesiscz/utils/ai/transcripts/subagents";
import {
    sessionWorkflowRuns,
    summarizeWorkflowRun,
    sumWorkflowUsage,
    type WorkflowAgentUsage,
    type WorkflowRunUsage,
    workflowAgentUsage,
    workflowReaderSupport,
} from "@genesiscz/utils/ai/transcripts/workflows";
import { concurrentMap } from "@genesiscz/utils/async";
import { formatLocalDateTimeStamp } from "@genesiscz/utils/date";
import { formatBytes, formatCost, formatDuration, formatTokens } from "@genesiscz/utils/format";
import { logger, out } from "@genesiscz/utils/logger";
import { formatTable } from "@genesiscz/utils/table";

const SCHEMA = "sessions.workflows@1";

/** A harness with no reader: the answer is the reason, never "0 runs". */
function noReaderLine(provider: string, reason: string): string {
    return `${provider}: no workflow reader. ${reason}`;
}

/** An instant as the machine's local time. The JSON forms keep the UTC instant. A text that is no instant stays. */
function local(iso: string | null): string {
    return iso === null ? "" : Number.isFinite(Date.parse(iso)) ? formatLocalDateTimeStamp(iso) : iso;
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

type AgentUsage = Map<WorkflowAgent, WorkflowAgentUsage | null>;

/** The agents that have a transcript of their own or of a revival: the ones whose calls usage reads. */
function readable(run: WorkflowRun): WorkflowAgent[] {
    return run.agents.filter((agent) => workflowAgentTranscripts(agent).length > 0);
}

/**
 * The calls, tokens and list-price cost of each agent of these runs that has a transcript, its revivals' included.
 * All runs share one bound of eight agents read at once, so `--usage` over every run of a session reads no more at
 * once than over one run.
 */
async function usageOf(session: ResolvedTranscript, runs: readonly WorkflowRun[]): Promise<AgentUsage> {
    return concurrentMap({
        items: runs.flatMap(readable),
        fn: (agent) => workflowAgentUsage(session.provider, workflowAgentTranscripts(agent)),
        concurrency: 8,
        onError: (agent, error) =>
            logger.warn({ error, transcript: agent.transcript }, "[ai sessions workflows] usage unreadable"),
    });
}

function runUsage(run: WorkflowRun, usage: AgentUsage): WorkflowRunUsage {
    return sumWorkflowUsage(readable(run).map((agent) => usage.get(agent)));
}

function usageCells(usage: WorkflowAgentUsage | WorkflowRunUsage | null | undefined): string[] {
    if (!usage) {
        return ["", "", ""];
    }

    const tokens = usage.input + usage.cacheRead + usage.cacheWrite + usage.output;
    const cost = usage.costUsd === null ? "unpriced" : formatCost(usage.costUsd);
    // A total that lacks unread agents says so in the cell, so it never reads as the whole run.
    const unread = "unread" in usage && usage.unread > 0 ? ` (+${usage.unread} unread)` : "";
    return [String(usage.calls), formatTokens(tokens), `${cost}${unread}`];
}

/** An agent's usage cells: "unread" when it has a transcript whose calls could not be read (the log says why). */
function agentUsageCells(agent: WorkflowAgent, usage: AgentUsage): string[] {
    const found = usage.get(agent);
    return found || workflowAgentTranscripts(agent).length === 0 ? usageCells(found) : ["unread", "", ""];
}

/** The line under a usage total that lacks agents: how many, and where the reason is. */
function unreadNote(unread: number): string | null {
    return unread > 0
        ? `${unread} agent transcript(s) could not be read; their calls, tokens and cost are missing from the totals (the day log names each one and why)`
        : null;
}

/** What an agent's journal rows and its run's retries say, in one word, for the RESULT column. */
function resultCell(agent: WorkflowAgent): string {
    if (agent.hasResult) {
        return formatBytes(agent.resultBytes);
    }

    return agent.supersededBy ? `retried as ${agent.supersededBy.agentId}` : "none";
}

/**
 * One row per agent of a run. TRANSCRIPT is what the agent's own file says now (`running`, `done`, `stopped`), the
 * same reading a sub-agent listing shows; RECORD is the state the run record wrote when the run ended.
 */
function agentTable(run: WorkflowRun, live: ReadonlyMap<string, SessionSubagent>, usage: AgentUsage | null): string {
    return formatTable(
        run.agents.map((agent) => [
            agent.label ?? "",
            agent.phase ?? "",
            agent.model ?? "",
            agent.state ?? "",
            agent.transcript ? (live.get(agent.agentId)?.state ?? "") : "no file",
            resultCell(agent),
            formatBytes(agent.bytes),
            agent.sources.join("+"),
            ...(usage ? [...agentUsageCells(agent, usage), String(live.get(agent.agentId)?.toolCalls ?? "")] : []),
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
            ...(usage ? ["CALLS", "TOKENS", "COST", "TOOLS"] : []),
            "AGENT",
        ],
        { maxColWidth: 40 }
    );
}

/** The session's sub-agent rows of these runs, by agent id: where each agent's transcript stands now. */
function liveAgents(
    session: ResolvedTranscript,
    runs: readonly WorkflowRun[],
    scan: boolean
): Map<string, SessionSubagent> {
    const ids = runs.flatMap((run) => run.agents.map((agent) => agent.agentId));
    return new Map(listSubagents(session, { ids, scan }).subagents.map((agent) => [agent.id, agent]));
}

export interface WorkflowListRequest {
    json?: boolean;
    /** Each run with its agents: the whole run in `--json`, a table under each run otherwise. */
    agents?: boolean;
    /** Read every agent transcript of every run for its calls, tokens and list-price cost. */
    usage?: boolean;
}

export async function printWorkflowList(session: ResolvedTranscript, options: WorkflowListRequest): Promise<void> {
    const runs = await runsOf(session, { json: options.json, strict: false });

    if (!runs) {
        return;
    }

    const usage = options.usage ? await usageOf(session, runs) : null;

    if (options.json) {
        out.result({
            schema: SCHEMA,
            sessionId: session.sessionId,
            provider: session.provider,
            reader: { supported: true },
            runs: options.agents ? runs : runs.map(summarizeWorkflowRun),
            ...(usage
                ? {
                      usage: Object.fromEntries(runs.map((run) => [run.runId, runUsage(run, usage)])),
                  }
                : {}),
        });
        return;
    }

    const summaries = runs.map(summarizeWorkflowRun);
    const agents = summaries.reduce((sum, run) => sum + run.agents, 0);
    const results = summaries.reduce((sum, run) => sum + run.results, 0);
    out.println(`${summaries.length} workflow runs in ${session.sessionId}: ${agents} agents, ${results} results`);

    if (summaries.length === 0) {
        return;
    }

    out.println(
        formatTable(
            runs.map((run, index) => {
                const summary = summaries[index];
                return [
                    run.runId,
                    run.name ?? "(no record)",
                    run.status ?? "no record",
                    local(run.startedAt),
                    run.durationMs === null ? "" : formatDuration(run.durationMs),
                    String(summary?.agents ?? 0),
                    String(summary?.transcripts ?? 0),
                    String(summary?.results ?? 0),
                    ...(usage ? usageCells(runUsage(run, usage)) : []),
                    run.phases.join(", "),
                ];
            }),
            [
                "RUN",
                "NAME",
                "STATUS",
                "STARTED (local)",
                "DURATION",
                "AGENTS",
                "FILES",
                "RESULTS",
                ...(usage ? ["CALLS", "TOKENS", "COST"] : []),
                "PHASES",
            ],
            { alignRight: usage ? [5, 6, 7, 8, 9, 10] : [5, 6, 7], maxColWidth: 44 }
        )
    );

    const unread = usage ? unreadNote(runs.reduce((sum, run) => sum + runUsage(run, usage).unread, 0)) : null;

    if (unread) {
        out.println(unread);
    }

    const noRecord = runs.filter((run) => run.recordPath === null);

    if (noRecord.length > 0) {
        out.println(
            `${noRecord.length} runs have transcripts and no run record (stopped before the record was written): ${noRecord.map((run) => run.runId).join(", ")}`
        );
    }

    if (options.agents) {
        const live = liveAgents(session, runs, options.usage === true);

        for (const run of runs) {
            out.println(`\n${run.runId}  ${run.name ?? "(no record)"}  ${run.status ?? "no record"}`);
            out.println(agentTable(run, live, usage));
        }
    }
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
    const usage = options.usage ? await usageOf(session, [run]) : null;

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
        ["started", run.startedAt === null ? null : `${local(run.startedAt)} local`],
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

    if (usage) {
        const total = runUsage(run, usage);
        const [calls, tokens, cost] = usageCells(total);
        out.println(`  ${"usage".padEnd(12)}${calls} calls, ${tokens} tokens, ${cost}`);
        const unread = unreadNote(total.unread);

        if (unread) {
            out.println(`  ${"".padEnd(12)}${unread}`);
        }
    }

    out.println(agentTable(run, liveAgents(session, [run], options.usage === true), usage));
    const unrecorded = run.agents.filter((agent) => !agent.sources.includes("record"));

    if (run.recordPath && unrecorded.length > 0) {
        out.println(
            `${unrecorded.length} agents started and are absent from the run record (a retry, or an agent the run dropped): ${unrecorded.map((agent) => agent.label ?? agent.agentId).join(", ")}`
        );
    }
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
        out.println(`  ${agent.agent.transcript}`);

        for (const hit of agent.hits) {
            // A revival's line numbers count in its own file, so its hits name it.
            const file = hit.transcript === agent.agent.transcript ? "" : `${hit.transcript} `;
            const at = hit.timestamp === null ? "no time" : local(hit.timestamp);
            // `assistant`: the agent wrote it. `tool-result`: it was shown it. `prompt`: it was told it.
            out.println(`  ${file}L${hit.line} ${at} [${hit.where}] ${hit.excerpt}`);
        }
    }
}

/**
 * The final structured answer of one agent of a run (by id or label), or of every agent of the run when no agent is
 * named. Always JSON: a result is the agent's structured answer.
 */
export async function printWorkflowResult(
    session: ResolvedTranscript,
    wantedRun: string,
    wantedAgent: string | undefined
): Promise<void> {
    const runs = await runsOf(session, { strict: true });

    if (!runs) {
        return;
    }

    const run = pickWorkflowRun(runs, wantedRun);
    const results = resolveHistoryProvider(session.provider).reader.workflows.results(run);

    if (wantedAgent === undefined) {
        out.result({
            schema: SCHEMA,
            runId: run.runId,
            results: run.agents.map((agent) => ({
                agentId: agent.agentId,
                label: agent.label,
                phase: agent.phase,
                hasResult: results.has(agent.agentId),
                result: results.get(agent.agentId) ?? null,
            })),
        });
        return;
    }

    const agent = pickWorkflowAgent(run, wantedAgent);

    if (!results.has(agent.agentId)) {
        const retry = agent.supersededBy ? `; the run retried the step as ${agent.supersededBy.agentId}` : "";
        throw new Error(
            `${agent.agentId} (${agent.label ?? "no label"}) returned no result in ${run.runId}: the journal has none for it${run.status ? ` (run status: ${run.status})` : ""}${retry}`
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
