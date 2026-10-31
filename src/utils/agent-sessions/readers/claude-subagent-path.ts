/** Whether a path is a Claude sub-agent's transcript. Its own file, so a hook (`claude-model.ts`) loads only `node:path`. */
import { basename, sep } from "node:path";

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
