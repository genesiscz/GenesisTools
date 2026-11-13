import { readdirSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import { resolveProjectNameFromEncoded } from "@genesiscz/utils/claude/projects";
import { logger } from "@genesiscz/utils/logger";
import type { NativeSessionSource, SessionPathRole, SpawnLink } from "../types";
import {
    type ClaudeSubagentFile,
    type ClaudeSubagentFolder,
    claudeSubagentFiles,
    claudeSubagentFolders,
    claudeSubagentsDir,
    claudeWorkflowRunOf,
    isClaudeSubagentPath,
    type ListDir,
    SUBAGENTS,
    claudeSubagentCandidates as subagentCandidates,
    WORKFLOWS,
} from "./claude-subagent-path";

export type { ClaudeSubagentFile, ClaudeSubagentFolder, ListDir };
export { claudeSubagentFiles, claudeSubagentsDir, claudeWorkflowRunOf, isClaudeSubagentPath };

export function claudeNativeId(source: Pick<NativeSessionSource<string>, "root" | "filePath">): string {
    if (!isClaudeSubagentPath(source.filePath)) {
        return basename(source.filePath, ".jsonl");
    }

    return relative(source.root, source.filePath)
        .split(sep)
        .join("/")
        .replace(/\.jsonl$/, "");
}

export function claudeProjectDirectory(
    source: Pick<NativeSessionSource<string>, "root" | "filePath">
): string | undefined {
    const parts = relative(source.root, source.filePath).split(sep);

    if (parts.length > 1 && parts[0] && parts[0] !== "..") {
        return parts[0];
    }

    const rootName = basename(source.root);
    return rootName.startsWith("-") ? rootName : undefined;
}

export function claudeProjectName(options: {
    source: NativeSessionSource<string>;
    cwd?: string | null;
}): string | null {
    const directory = claudeProjectDirectory(options.source);

    if (directory) {
        return resolveProjectNameFromEncoded(directory);
    }

    const cwd = options.cwd ?? options.source.metadata?.cwd;
    return options.source.metadata?.project ?? (cwd ? basename(cwd) : null);
}

/**
 * The Claude session tree, in one place: `<project>/<session>.jsonl`, its sub-agents in
 * `<project>/<session>/subagents/agent-<id>.jsonl` with an `agent-<id>.meta.json` beside each, and a workflow's agents
 * deeper under `subagents/`. Every reader of the layout asks these, so a layout change is one edit here.
 */
const AGENT_FILE = /^agent-(.+)\.(jsonl|meta\.json)$/;

/** The agent id of a sub-agent transcript's file name (`agent-<id>.jsonl`), or null for any other file. */
export function claudeSubagentIdOf(fileName: string): string | null {
    const match = AGENT_FILE.exec(fileName);
    return match?.[2] === "jsonl" ? (match[1] ?? null) : null;
}

/**
 * The lead session transcript of a sub-agent transcript: one directly in a session's sub-agent folder, or one of a
 * Workflow tool run (`subagents/workflows/<runId>/`). Null for any other path.
 */
export function claudeSubagentLead(subagentTranscript: string): { sessionId: string; transcript: string } | null {
    const dir = dirname(subagentTranscript);
    const subagentsDir =
        basename(dir) === SUBAGENTS ? dir : claudeWorkflowRunOf(subagentTranscript) ? dirname(dirname(dir)) : null;

    if (!subagentsDir) {
        return null;
    }

    const leadDir = dirname(subagentsDir);
    const sessionId = basename(leadDir);
    return { sessionId, transcript: join(dirname(leadDir), `${sessionId}.jsonl`) };
}

function listDirSorted(dir: string): string[] {
    try {
        return readdirSync(dir).sort();
    } catch (error) {
        // Most sessions never spawn a sub-agent and run no workflow, so a missing folder is the normal case. Logging it
        // with its stack on every hub poll wrote hundreds of MB a day into the day log.
        const missing = error instanceof Error && "code" in error && error.code === "ENOENT";

        if (!missing) {
            logger.debug({ error, dir }, "[transcripts] sub-agent directory unreadable");
        }

        return [];
    }
}

/** The folder of everything a session keeps beside its transcript: `<project>/<session>/`. */
export function claudeSessionDir(sessionTranscript: string): string {
    return join(dirname(sessionTranscript), basename(sessionTranscript, ".jsonl"));
}

/** Where a session keeps its Workflow tool run records (`<runId>.json`) and saved scripts (`scripts/`). */
export function claudeWorkflowRecordsDir(sessionTranscript: string): string {
    return join(claudeSessionDir(sessionTranscript), WORKFLOWS);
}

/**
 * The entries of `<session>/subagents/workflows/`, one per Workflow tool run that wrote a transcript or a journal.
 */
export function claudeWorkflowRunDirs(
    sessionTranscript: string,
    listDir: ListDir = listDirSorted
): ClaudeSubagentFolder[] {
    return claudeSubagentFolders(sessionTranscript, listDir).filter((folder) => folder.runId !== null);
}

/**
 * Every sub-agent transcript of a Claude session, from the session's transcript path: the agents directly in
 * `<session>/subagents/` first, then the agents of each Workflow tool run. A lister that reads only the first folder
 * misses every workflow agent: session 1d7131fa had 123 of them beside 60 direct ones (2026-11-10).
 */
export function claudeSubagentTranscripts(
    sessionTranscript: string,
    listDir: ListDir = listDirSorted
): ClaudeSubagentFile[] {
    return claudeSubagentFolders(sessionTranscript, listDir).flatMap(({ runId, dir }) =>
        listDir(dir).flatMap((name) => {
            const agentId = claudeSubagentIdOf(name);
            return agentId ? [{ agentId, runId, dir, ...claudeSubagentFiles(dir, agentId) }] : [];
        })
    );
}

/**
 * Every place the transcript of one agent id can be in a session: directly in `subagents/`, or in one of the
 * session's run folders. The caller checks which one exists; no folder is listed beyond the run level.
 */
export function claudeSubagentCandidates(
    sessionTranscript: string,
    agentId: string,
    listDir: ListDir = listDirSorted
): ClaudeSubagentFile[] {
    return subagentCandidates(sessionTranscript, agentId, listDir);
}

/** A `.jsonl` discovery reads: not the project's `sessions-index.jsonl`, not a workflow's `journal.jsonl`. */
function isConversationFile(parts: readonly string[]): boolean {
    const name = parts.at(-1) ?? "";
    return (
        name.endsWith(".jsonl") &&
        name !== "sessions-index.jsonl" &&
        !(name === "journal.jsonl" && parts.includes("workflows"))
    );
}

/** `NativeSessionReader.classifyPath` for Claude: a path relative to a `projects` root. */
export function claudeClassifyPath(relativePath: string): SessionPathRole | null {
    const parts = relativePath.split(/[/\\]/);
    const name = parts.at(-1) ?? "";

    if (parts.length === 2) {
        if (name === "sessions-index.json") {
            return { owner: "session", file: "sidecar", sessionId: null, parentSessionId: null, nested: false };
        }

        return isConversationFile(parts)
            ? {
                  owner: "session",
                  file: "transcript",
                  sessionId: name.slice(0, -".jsonl".length),
                  parentSessionId: null,
                  nested: false,
              }
            : null;
    }

    if (parts.length < 4 || parts[2] !== SUBAGENTS) {
        return null;
    }

    const parentSessionId = parts[1] ?? null;
    const agent = AGENT_FILE.exec(name);

    if (parts.length === 4 && (name.endsWith(".jsonl") || name.endsWith(".json"))) {
        return {
            owner: "subagent",
            file: name.endsWith(".jsonl") ? "transcript" : "sidecar",
            sessionId: agent?.[1] ?? name.replace(/\.(jsonl|json)$/, ""),
            parentSessionId,
            nested: false,
        };
    }

    return parts.length > 4 && isConversationFile(parts)
        ? {
              owner: "subagent",
              file: "transcript",
              sessionId: agent?.[1] ?? name.slice(0, -".jsonl".length),
              parentSessionId,
              nested: true,
          }
        : null;
}

/**
 * `NativeSessionReader.readSpawnLink` for Claude: a sub-agent transcript's lead session, from the folder it sits in
 * (`claudeClassifyPath` under the source's root, `claudeSubagentLead` for a path outside it). A session's own
 * transcript has no spawner. Claude's layout keeps no depth or role, so the link carries the lead alone.
 */
export async function claudeReadSpawnLink(
    source: Pick<NativeSessionSource<string>, "root" | "filePath">
): Promise<SpawnLink | null> {
    const role = claudeClassifyPath(relative(source.root, source.filePath));

    if (role?.owner === "subagent" && role.file === "transcript" && role.parentSessionId) {
        return { parentSessionId: role.parentSessionId };
    }

    const lead = role ? null : claudeSubagentLead(source.filePath);
    return lead ? { parentSessionId: lead.sessionId } : null;
}
