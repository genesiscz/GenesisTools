import { basename, dirname, join, relative, sep } from "node:path";
import { resolveProjectNameFromEncoded } from "@genesiscz/utils/claude/projects";
import type { NativeSessionSource, SessionPathRole } from "../types";
import { isClaudeSubagentPath } from "./claude-subagent-path";

export { isClaudeSubagentPath };

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
const SUBAGENTS = "subagents";
const AGENT_FILE = /^agent-(.+)\.(jsonl|meta\.json)$/;

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

/** The agent id of a sub-agent transcript's file name (`agent-<id>.jsonl`), or null for any other file. */
export function claudeSubagentIdOf(fileName: string): string | null {
    const match = AGENT_FILE.exec(fileName);
    return match?.[2] === "jsonl" ? (match[1] ?? null) : null;
}

/** The lead session transcript of a sub-agent transcript directly in a session's sub-agent folder, else null. */
export function claudeSubagentLead(subagentTranscript: string): { sessionId: string; transcript: string } | null {
    const dir = dirname(subagentTranscript);

    if (basename(dir) !== SUBAGENTS) {
        return null;
    }

    const leadDir = dirname(dir);
    const sessionId = basename(leadDir);
    return { sessionId, transcript: join(dirname(leadDir), `${sessionId}.jsonl`) };
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
