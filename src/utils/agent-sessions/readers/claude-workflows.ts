/**
 * `NativeSessionReader.workflows` for Claude: the Workflow tool's runs of one session.
 *
 * Layout (Claude Code 2.1.x, read from session 1d7131fa on 2026-11-10; the paths are in `claude-paths.ts`):
 *
 *   <session>/workflows/<runId>.json               the run record, written when the run ENDS
 *   <session>/workflows/scripts/<name>-<runId>.js  the saved script (every agent's prompt template)
 *   <session>/subagents/workflows/<runId>/journal.jsonl
 *   <session>/subagents/workflows/<runId>/agent-<id>.jsonl (+ .meta.json)
 *
 * Three sources name a run's agents and they do not agree, so the reader joins them by agent id:
 *   - the run record's progress rows of one agent each: label, phase, model, state, attempt, start, prompt preview;
 *   - the journal: one row per agent start and one row per finished agent, which holds its final structured answer;
 *   - the folder: the transcripts that exist, and each meta file (its description is the label).
 * In session 1d7131fa the records named 122 agents, the journals 123 starts and 107 results. A killed run has
 * transcripts and few results; a run stopped before its end has transcripts and no record.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { isDir } from "@genesiscz/utils/ai/transcripts/resolve-core";
import { concurrentMap } from "@genesiscz/utils/async";
import { readLines } from "@genesiscz/utils/fs/read-lines";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { isObject } from "@genesiscz/utils/object";
import { nonEmptyString as text } from "@genesiscz/utils/string";
import type {
    SessionWorkflowReader,
    WorkflowAgent,
    WorkflowAgentGrep,
    WorkflowAgentSource,
    WorkflowGrepHit,
    WorkflowGrepOptions,
    WorkflowJournalRows,
    WorkflowRun,
    WorkflowSupersession,
} from "../workflow-types";
import { parseRow } from "./analysis-lines";
import {
    type ClaudeSubagentFile,
    claudeSubagentFiles,
    claudeSubagentTranscripts,
    claudeWorkflowRecordsDir,
    claudeWorkflowRunDirs,
} from "./claude-paths";

const PARALLEL_TRANSCRIPTS = 8;
const JOURNAL = "journal.jsonl";

type Row = Record<string, unknown>;

function finite(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isoFromEpochMs(value: unknown): string | null {
    const ms = finite(value);
    return ms === null ? null : new Date(ms).toISOString();
}

function readJsonFile(path: string): Row | null {
    try {
        return parseRow(readFileSync(path, "utf8"), path);
    } catch (error) {
        logger.debug({ error, path }, "[claude-workflows] unreadable file");
        return null;
    }
}

/** A missing folder is the normal case for a run that left only a record, so it lists nothing. */
function listNames(dir: string): string[] {
    return isDir(dir) ? readdirSync(dir).sort() : [];
}

/** The run ids that have a record: `<runId>.json` beside the `scripts/` folder. */
function listRecordRunIds(recordsDir: string): string[] {
    return listNames(recordsDir)
        .filter((name) => name.endsWith(".json"))
        .map((name) => name.slice(0, -".json".length));
}

interface AgentDraft {
    agentId: string;
    label: string | null;
    phase: string | null;
    model: string | null;
    state: string | null;
    attempt: number | null;
    startedAt: string | null;
    promptPreview: string | null;
    hasResult: boolean;
    resultBytes: number;
    journal: WorkflowJournalRows | null;
    sources: Set<WorkflowAgentSource>;
}

function draftFor(drafts: Map<string, AgentDraft>, agentId: string): AgentDraft {
    const known = drafts.get(agentId);

    if (known) {
        return known;
    }

    const draft: AgentDraft = {
        agentId,
        label: null,
        phase: null,
        model: null,
        state: null,
        attempt: null,
        startedAt: null,
        promptPreview: null,
        hasResult: false,
        resultBytes: 0,
        journal: null,
        sources: new Set(),
    };
    drafts.set(agentId, draft);
    return draft;
}

/** The record wins for every field it names; an empty string in it does not hide a journal or disk value. */
function readRecordAgents(record: Row | null, drafts: Map<string, AgentDraft>): void {
    const progress = record?.workflowProgress;

    if (!Array.isArray(progress)) {
        return;
    }

    for (const row of progress) {
        if (!isObject(row) || row.type !== "workflow_agent") {
            continue;
        }

        const agentId = text(row.agentId);

        if (!agentId) {
            continue;
        }

        const draft = draftFor(drafts, agentId);
        draft.sources.add("record");
        draft.label = text(row.label) ?? draft.label;
        draft.phase = text(row.phaseTitle) ?? draft.phase;
        draft.model = text(row.model) ?? draft.model;
        draft.state = text(row.state) ?? draft.state;
        draft.attempt = finite(row.attempt) ?? draft.attempt;
        draft.startedAt = isoFromEpochMs(row.startedAt) ?? draft.startedAt;
        draft.promptPreview = text(row.promptPreview) ?? draft.promptPreview;
    }
}

/** The journal's rows with their 1-based line: a line is the evidence a caller cites. */
function journalRows(journalPath: string): Array<{ line: number; row: Row }> {
    if (!existsSync(journalPath)) {
        return [];
    }

    const rows: Array<{ line: number; row: Row }> = [];

    readFileSync(journalPath, "utf8")
        .split("\n")
        .forEach((raw, index) => {
            const row = raw.trim() ? parseRow(raw, journalPath) : null;

            if (row) {
                rows.push({ line: index + 1, row });
            }
        });

    return rows;
}

function readJournalAgents(journalPath: string, drafts: Map<string, AgentDraft>): void {
    for (const { line, row } of journalRows(journalPath)) {
        const agentId = text(row.agentId);

        if (!agentId) {
            continue;
        }

        const draft = draftFor(drafts, agentId);
        draft.sources.add("journal");
        draft.journal ??= { key: null, startedLine: null, resultLine: null };
        draft.journal.key ??= text(row.key);

        if (row.type === "started") {
            draft.label = draft.label ?? text(row.label);
            draft.phase = draft.phase ?? text(row.phase);
            draft.journal.startedLine ??= line;
        }

        if (row.type === "result") {
            draft.hasResult = true;
            draft.resultBytes = Buffer.byteLength(SafeJSON.stringify(row.result ?? null) ?? "");
            draft.journal.resultLine = line;
        }
    }
}

/**
 * For each agent with no result: the agent the run started later for the same step key. The later attempt that
 * recorded a result wins; with none, the last attempt. In session 1d7131fa a step was started twice (journal L2 and
 * L3 of one run) and only the second agent returned, so the first one reads as replaced, not as lost work.
 */
function supersessions(drafts: Iterable<AgentDraft>): Map<string, WorkflowSupersession> {
    const attempts = new Map<string, Array<{ agentId: string; startedLine: number; hasResult: boolean }>>();

    for (const draft of drafts) {
        const key = draft.journal?.key;
        const startedLine = draft.journal?.startedLine;

        if (key && startedLine) {
            attempts.set(key, [
                ...(attempts.get(key) ?? []),
                { agentId: draft.agentId, startedLine, hasResult: draft.hasResult },
            ]);
        }
    }

    const replaced = new Map<string, WorkflowSupersession>();

    for (const step of attempts.values()) {
        step.sort((a, b) => a.startedLine - b.startedLine);
        step.forEach((attempt, index) => {
            const later = step.slice(index + 1);
            const winner = later.find((candidate) => candidate.hasResult) ?? later.at(-1);

            if (winner && !attempt.hasResult) {
                replaced.set(attempt.agentId, winner);
            }
        });
    }

    return replaced;
}

function readDiskAgents(files: readonly ClaudeSubagentFile[], drafts: Map<string, AgentDraft>): void {
    for (const file of files) {
        const draft = draftFor(drafts, file.agentId);
        draft.sources.add("disk");
        const meta = existsSync(file.meta) ? readJsonFile(file.meta) : null;
        draft.label = draft.label ?? text(meta?.description);
        draft.phase = draft.phase ?? text(meta?.workflowPhase);
    }
}

/** The record names its script by absolute path; a moved session keeps the file under `scripts/`. */
function savedScript(recordsDir: string, runId: string, recorded: string | null): string | null {
    if (recorded && existsSync(recorded)) {
        return recorded;
    }

    const scriptsDir = join(recordsDir, "scripts");
    const hit = listNames(scriptsDir).find((name) => name.endsWith(`${runId}.js`));
    return hit ? join(scriptsDir, hit) : null;
}

function sizeOf(path: string): number {
    try {
        return statSync(path).size;
    } catch (error) {
        logger.debug({ error, path }, "[claude-workflows] transcript size unavailable");
        return 0;
    }
}

function readRun(input: {
    runId: string;
    recordsDir: string;
    runDir: string | null;
    files: ClaudeSubagentFile[];
}): WorkflowRun {
    const { runId, recordsDir, runDir, files } = input;
    const recordFile = join(recordsDir, `${runId}.json`);
    const record = existsSync(recordFile) ? readJsonFile(recordFile) : null;
    const journalFile = runDir ? join(runDir, JOURNAL) : null;
    const drafts = new Map<string, AgentDraft>();

    readRecordAgents(record, drafts);

    if (journalFile) {
        readJournalAgents(journalFile, drafts);
    }

    readDiskAgents(files, drafts);

    const replaced = supersessions(drafts.values());
    const agents: WorkflowAgent[] = [...drafts.values()].map((draft) => {
        const onDisk = draft.sources.has("disk") && runDir !== null;
        const transcript = onDisk ? claudeSubagentFiles(runDir, draft.agentId).transcript : null;

        return {
            agentId: draft.agentId,
            label: draft.label,
            phase: draft.phase,
            model: draft.model,
            state: draft.state,
            attempt: draft.attempt,
            startedAt: draft.startedAt,
            transcript,
            bytes: transcript ? sizeOf(transcript) : 0,
            hasResult: draft.hasResult,
            resultBytes: draft.resultBytes,
            promptPreview: draft.promptPreview,
            sources: [...draft.sources],
            journal: draft.journal,
            supersededBy: replaced.get(draft.agentId) ?? null,
        };
    });
    const recordedPhases = Array.isArray(record?.phases)
        ? record.phases.filter(isObject).flatMap((phase) => text(phase.title) ?? [])
        : null;
    const error = record?.error;

    return {
        runId,
        name: text(record?.workflowName),
        summary: text(record?.summary),
        status: text(record?.status),
        error:
            error === null || error === undefined
                ? null
                : typeof error === "string"
                  ? error
                  : (SafeJSON.stringify(error) ?? null),
        startedAt: isoFromEpochMs(record?.startTime),
        durationMs: finite(record?.durationMs),
        defaultModel: text(record?.defaultModel),
        phases: recordedPhases ?? [...new Set(agents.flatMap((agent) => agent.phase ?? []))],
        scriptPath: savedScript(recordsDir, runId, text(record?.scriptPath)),
        recordPath: record ? recordFile : null,
        journalPath: journalFile && existsSync(journalFile) ? journalFile : null,
        transcriptDir: runDir,
        reported: {
            agents: finite(record?.agentCount),
            tokens: finite(record?.totalTokens),
            toolCalls: finite(record?.totalToolCalls),
        },
        agents,
    };
}

/** Every run of a session: the union of the run records and the run folders, oldest first. */
export function claudeWorkflowRuns(sessionTranscript: string): WorkflowRun[] {
    const recordsDir = claudeWorkflowRecordsDir(sessionTranscript);
    const runDirs = new Map<string, string>();

    for (const folder of claudeWorkflowRunDirs(sessionTranscript)) {
        if (folder.runId !== null && isDir(folder.dir)) {
            runDirs.set(folder.runId, folder.dir);
        }
    }

    const filesByRun = new Map<string, ClaudeSubagentFile[]>();

    for (const file of claudeSubagentTranscripts(sessionTranscript)) {
        if (file.runId !== null) {
            filesByRun.set(file.runId, [...(filesByRun.get(file.runId) ?? []), file]);
        }
    }

    const runIds = [...new Set([...listRecordRunIds(recordsDir), ...runDirs.keys()])].sort();
    const runs = runIds.map((runId) =>
        readRun({ runId, recordsDir, runDir: runDirs.get(runId) ?? null, files: filesByRun.get(runId) ?? [] })
    );

    // Unknown start times sort last: a run with no record was stopped before it could write one.
    return runs.sort(
        (a, b) => (a.startedAt ?? "9").localeCompare(b.startedAt ?? "9") || a.runId.localeCompare(b.runId)
    );
}

function claudeWorkflowResults(run: WorkflowRun): Map<string, unknown> {
    const results = new Map<string, unknown>();

    for (const { row } of run.journalPath ? journalRows(run.journalPath) : []) {
        const agentId = text(row.agentId);

        if (row.type === "result" && agentId) {
            results.set(agentId, row.result ?? null);
        }
    }

    return results;
}

function whereOf(row: Row): WorkflowGrepHit["where"] {
    if (row.type === "assistant") {
        return "assistant";
    }

    if (row.type !== "user") {
        return "other";
    }

    const content = isObject(row.message) ? row.message.content : null;
    const shown = Array.isArray(content) && content.some((block) => isObject(block) && block.type === "tool_result");
    return shown ? "tool-result" : "prompt";
}

async function grepAgent(
    run: WorkflowRun,
    agent: WorkflowAgent,
    pattern: RegExp,
    options: Required<Pick<WorkflowGrepOptions, "maxHits" | "context">> & Pick<WorkflowGrepOptions, "before">
): Promise<WorkflowAgentGrep | null> {
    if (!agent.transcript) {
        return null;
    }

    const hits: WorkflowGrepHit[] = [];
    let matchingLines = 0;
    let lineNumber = 0;

    for await (const line of readLines(agent.transcript)) {
        lineNumber++;
        pattern.lastIndex = 0;
        const match = pattern.exec(line);

        if (!match) {
            continue;
        }

        const row = parseRow(line, agent.transcript) ?? {};
        const timestamp = text(row.timestamp);

        if (options.before && timestamp && timestamp >= options.before) {
            continue;
        }

        matchingLines++;

        // A transcript line is a whole tool result and can be megabytes, so a hit is a bounded excerpt.
        if (hits.length < options.maxHits) {
            const start = Math.max(0, match.index - options.context);
            const end = Math.min(line.length, match.index + match[0].length + options.context);
            hits.push({ line: lineNumber, timestamp, where: whereOf(row), excerpt: line.slice(start, end) });
        }
    }

    return matchingLines > 0 ? { runId: run.runId, runName: run.name, agent, matchingLines, hits } : null;
}

async function claudeWorkflowGrep(
    runs: readonly WorkflowRun[],
    pattern: RegExp,
    options: WorkflowGrepOptions = {}
): Promise<WorkflowAgentGrep[]> {
    const jobs = runs.flatMap((run) => run.agents.map((agent) => ({ run, agent })));
    const found = await concurrentMap({
        items: jobs,
        fn: ({ run, agent }) =>
            grepAgent(run, agent, pattern, {
                maxHits: options.maxHits ?? 3,
                context: options.context ?? 100,
                before: options.before,
            }),
        concurrency: PARALLEL_TRANSCRIPTS,
        onError: ({ agent }, error) =>
            logger.warn({ error, transcript: agent.transcript }, "[claude-workflows] grep could not read a transcript"),
    });

    return jobs.flatMap((job) => found.get(job) ?? []);
}

export const claudeWorkflows: SessionWorkflowReader = {
    support: { supported: true },
    runs: async (sessionTranscript) => ({ supported: true, items: claudeWorkflowRuns(sessionTranscript) }),
    results: claudeWorkflowResults,
    grep: claudeWorkflowGrep,
};
