/**
 * Where a Claude session keeps its sub-agent transcripts. Its own file, so a hook (`claude-model.ts`, the Claude
 * driver's hook facts) loads only `node:path`: nothing here reads a folder itself, a caller passes the lister.
 */
import { basename, dirname, join, sep } from "node:path";

/** The folder name a Claude session keeps its sub-agents in (`<project>/<session>/subagents/`). */
export const SUBAGENTS = "subagents";

/**
 * A path with a segment named exactly `subagents`, or whose file name starts with `agent-`. The segment test is the
 * same as `path.split(sep).includes("subagents")` without building the array: a discovery walk asks it for every one
 * of about 12,500 sub-agent transcripts, and the split was a tenth of a warm walk (2026-10-27).
 */
export function isClaudeSubagentPath(path: string): boolean {
    return hasSubagentsSegment(path) || basename(path).startsWith("agent-");
}

function hasSubagentsSegment(path: string): boolean {
    return (
        path === "subagents" ||
        path.startsWith(`subagents${sep}`) ||
        path.endsWith(`${sep}subagents`) ||
        path.includes(`${sep}subagents${sep}`)
    );
}

/** The folder of a session's sub-agents, from the session's transcript path. */
export function claudeSubagentsDir(sessionTranscript: string): string {
    return join(dirname(sessionTranscript), basename(sessionTranscript, ".jsonl"), SUBAGENTS);
}

/** A sub-agent's transcript and its metadata file in a session's sub-agent folder. */
export function claudeSubagentFiles(subagentsDir: string, agentId: string): { transcript: string; meta: string } {
    return {
        transcript: join(subagentsDir, `agent-${agentId}.jsonl`),
        meta: join(subagentsDir, `agent-${agentId}.meta.json`),
    };
}

/**
 * The folder name the Workflow tool uses twice: `<session>/subagents/workflows/<runId>/` holds a run's agent
 * transcripts and its journal, and `<session>/workflows/` holds the run records and the saved scripts.
 */
export const WORKFLOWS = "workflows";

/** A folder's entry names, sorted; empty when the folder does not exist. */
export type ListDir = (dir: string) => string[];

/** A folder that holds sub-agent transcripts of one session. */
export interface ClaudeSubagentFolder {
    /** Null for `subagents/` itself; the run id for `subagents/workflows/<runId>/`. */
    runId: string | null;
    dir: string;
}

/**
 * The folders that hold a session's sub-agent transcripts: `subagents/` itself, then one folder per Workflow tool run
 * (`subagents/workflows/<runId>/`). This is the ONE walk of that layout: the sub-agent listing, the by-id lookup, the
 * hook's caller transcript and the workflow reader all ask here.
 */
export function claudeSubagentFolders(sessionTranscript: string, listDir: ListDir): ClaudeSubagentFolder[] {
    const direct = claudeSubagentsDir(sessionTranscript);
    const runs = join(direct, WORKFLOWS);
    return [{ runId: null, dir: direct }, ...listDir(runs).map((runId) => ({ runId, dir: join(runs, runId) }))];
}

/** The run id of a workflow agent's transcript (`…/subagents/workflows/<runId>/agent-<id>.jsonl`), else null. */
export function claudeWorkflowRunOf(subagentTranscript: string): string | null {
    const runDir = dirname(subagentTranscript);
    const workflowsDir = dirname(runDir);
    return basename(workflowsDir) === WORKFLOWS && basename(dirname(workflowsDir)) === SUBAGENTS
        ? basename(runDir)
        : null;
}

/** One sub-agent transcript of a session, with the Workflow tool run that started it when one did. */
export interface ClaudeSubagentFile extends ClaudeSubagentFolder {
    agentId: string;
    transcript: string;
    /** The `agent-<id>.meta.json` beside the transcript. The file may not exist. */
    meta: string;
}

/** Every place the transcript of one agent id can be in a session. The caller checks which one exists. */
export function claudeSubagentCandidates(
    sessionTranscript: string,
    agentId: string,
    listDir: ListDir
): ClaudeSubagentFile[] {
    return claudeSubagentFolders(sessionTranscript, listDir).map((folder) => ({
        agentId,
        ...folder,
        ...claudeSubagentFiles(folder.dir, agentId),
    }));
}
