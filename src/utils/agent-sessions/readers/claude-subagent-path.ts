/** Whether a path is a Claude sub-agent's transcript. Its own file, so a hook (`claude-model.ts`) loads only `node:path`. */
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
