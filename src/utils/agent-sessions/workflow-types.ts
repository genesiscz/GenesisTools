/**
 * The multi-agent runs a session started (Claude Code's Workflow tool), as a REQUIRED member group of
 * `NativeSessionReader.workflows`, implemented by Claude, Codex and Grok (`.claude/rules/agent-transcripts.md`).
 *
 * A run's agents are not ordinary sub-agents: they have their own folder, a journal and a run record. A lister that
 * walks only a session's direct sub-agents never sees them, which is how a session with 123 workflow agents read as
 * "40 sub-agents" on 2026-11-10. A harness with no such tool answers `{ supported: false, reason }`, never an empty
 * list, so a cross-provider listing can tell "no run happened" from "this harness has no reader".
 */
import type { SessionFacts } from "./analysis-types";

/**
 * Where a reader learned that an agent exists. The three sources disagree in real data: the run record lists agents
 * by the END of the run, the journal lists every start, and the folder holds what was written. An agent missing from
 * one of them is a finding, so all three are kept.
 */
export type WorkflowAgentSource = "record" | "journal" | "disk";

/** An agent's rows in its run's journal, by 1-based line, so a reader can open the row that proves a claim. */
export interface WorkflowJournalRows {
    /** The step the agent ran. A retry of a step is another agent with the same key. */
    key: string | null;
    startedLine: number | null;
    resultLine: number | null;
}

/** The agent a run started later for the same step, when the earlier one returned no result. */
export interface WorkflowSupersession {
    agentId: string;
    /** 1-based journal line of the later agent's start. */
    startedLine: number;
    hasResult: boolean;
}

export interface WorkflowAgent {
    agentId: string;
    label: string | null;
    phase: string | null;
    /** The model the run record names for this agent. */
    model: string | null;
    /** The run record's state for this agent (`done`, `running`), not a liveness reading. */
    state: string | null;
    attempt: number | null;
    /** ISO instant in UTC, from the run record. */
    startedAt: string | null;
    /** Absolute path of the agent's transcript, or null when no file exists. Never a guessed path. */
    transcript: string | null;
    bytes: number;
    /** The journal holds a result row for this agent: its final structured answer. */
    hasResult: boolean;
    resultBytes: number;
    promptPreview: string | null;
    sources: WorkflowAgentSource[];
    /** The agent's rows in the run's journal; null when the journal never named it. */
    journal: WorkflowJournalRows | null;
    /**
     * The retry that replaced this attempt: the run started the same step again and this agent has no result. Null
     * for an agent with a result, and for the last attempt of a step.
     */
    supersededBy: WorkflowSupersession | null;
}

export interface WorkflowRun {
    runId: string;
    name: string | null;
    summary: string | null;
    /** The run record's status (`completed`, `killed`); null for a run that left no record. */
    status: string | null;
    error: string | null;
    /** ISO instant in UTC. */
    startedAt: string | null;
    durationMs: number | null;
    defaultModel: string | null;
    phases: string[];
    /** The saved script: the exact prompt template every agent of the run got. */
    scriptPath: string | null;
    /** The run record file, or null when the run left only transcripts. */
    recordPath: string | null;
    journalPath: string | null;
    transcriptDir: string | null;
    /** The harness's own totals from the run record. They are far below the transcript totals and are not recomputed. */
    reported: { agents: number | null; tokens: number | null; toolCalls: number | null };
    agents: WorkflowAgent[];
}

export interface WorkflowGrepHit {
    /** 1-based line of the agent's transcript. */
    line: number;
    timestamp: string | null;
    /**
     * `assistant`: the agent wrote it. `tool-result`: the agent was shown it. `prompt`: it was in a user or harness
     * message. The difference decides "the agent knew" against "the agent saw".
     */
    where: "assistant" | "tool-result" | "prompt" | "other";
    excerpt: string;
}

export interface WorkflowAgentGrep {
    runId: string;
    runName: string | null;
    agent: WorkflowAgent;
    matchingLines: number;
    hits: WorkflowGrepHit[];
}

export interface WorkflowGrepOptions {
    /** Keep at most this many excerpts per agent; every matching line is still counted. Default 3. */
    maxHits?: number;
    /** Skip rows at or after this ISO instant. */
    before?: string;
    /** Characters of context on each side of the match. Default 100. */
    context?: number;
}

/** Whether a harness has a multi-agent run tool that its reader maps, and the reason when it has none. */
export type WorkflowReaderSupport = { supported: true } | { supported: false; reason: string };

export interface SessionWorkflowReader {
    /** Answered without reading a file, so a cross-provider listing can name the harnesses that have no reader. */
    readonly support: WorkflowReaderSupport;
    /**
     * Every run of the session whose transcript this is, oldest first, with its agents joined by agent id from the
     * run record, the journal and the transcript folder. A harness with no workflow tool answers `supported: false`.
     */
    runs(sessionTranscript: string): Promise<SessionFacts<WorkflowRun>>;
    /** The final structured answer of each agent of a run that returned one, by agent id. */
    results(run: WorkflowRun): Map<string, unknown>;
    /** The agents of these runs that have a matching transcript row, and whether each wrote it or was shown it. */
    grep(runs: readonly WorkflowRun[], pattern: RegExp, options?: WorkflowGrepOptions): Promise<WorkflowAgentGrep[]>;
}

/** `workflows` for a harness that has no multi-agent run tool: it says so, with the reason. */
export function noWorkflowReader(reason: string): SessionWorkflowReader {
    return {
        support: { supported: false, reason },
        runs: async () => ({ supported: false, reason }),
        results: () => new Map(),
        grep: async () => [],
    };
}

export interface WorkflowRunTotals {
    agents: number;
    withTranscript: number;
    withResult: number;
    bytes: number;
}

export function workflowRunTotals(run: WorkflowRun): WorkflowRunTotals {
    const totals: WorkflowRunTotals = { agents: 0, withTranscript: 0, withResult: 0, bytes: 0 };

    for (const agent of run.agents) {
        totals.agents++;
        totals.bytes += agent.bytes;

        if (agent.transcript) {
            totals.withTranscript++;
        }

        if (agent.hasResult) {
            totals.withResult++;
        }
    }

    return totals;
}

/** A run id prefix, or a workflow name (exact, then substring). Throws when it names no run or several. */
export function pickWorkflowRun(runs: readonly WorkflowRun[], wanted: string): WorkflowRun {
    const needle = wanted.toLowerCase();
    const byId = runs.filter((run) => run.runId.toLowerCase().startsWith(needle));
    const byName = runs.filter((run) => run.name?.toLowerCase() === needle);
    const bySubstring = runs.filter((run) => run.name?.toLowerCase().includes(needle));
    const matches = byId.length ? byId : byName.length ? byName : bySubstring;
    const [only] = matches;

    if (only && matches.length === 1) {
        return only;
    }

    if (matches.length === 0) {
        const known = runs.map((run) => `${run.runId} (${run.name ?? "no name"})`).join(", ");
        throw new Error(`no workflow run matches "${wanted}"; this session has: ${known || "none"}`);
    }

    throw new Error(`"${wanted}" matches ${matches.length} runs: ${matches.map((run) => run.runId).join(", ")}`);
}

/**
 * One agent of a run by its id (exact, then a prefix) or its label (exact, then a part of it, without case). Throws
 * when it names no agent or several, with the agents it could have meant.
 */
export function pickWorkflowAgent(run: WorkflowRun, wanted: string): WorkflowAgent {
    const needle = wanted.toLowerCase();
    const label = (agent: WorkflowAgent): string => agent.label?.toLowerCase() ?? "";
    const matches = [
        (agent: WorkflowAgent) => agent.agentId === wanted,
        (agent: WorkflowAgent) => agent.agentId.toLowerCase().startsWith(needle),
        (agent: WorkflowAgent) => label(agent) === needle,
        (agent: WorkflowAgent) => label(agent).includes(needle),
    ]
        .map((test) => run.agents.filter(test))
        .find((found) => found.length > 0);
    const [only] = matches ?? [];
    const names = (agents: readonly WorkflowAgent[]): string =>
        agents.map((agent) => `${agent.agentId} (${agent.label ?? "no label"})`).join(", ");

    if (only && matches?.length === 1) {
        return only;
    }

    if (!matches) {
        throw new Error(`no agent "${wanted}" in ${run.runId}; it has: ${names(run.agents) || "none"}`);
    }

    throw new Error(`"${wanted}" matches ${matches.length} agents of ${run.runId}: ${names(matches)}`);
}
