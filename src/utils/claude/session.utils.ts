import { basename, sep } from "node:path";
import type {
    AgentCompletionStats,
    AgentProgressData,
    ContentBlock,
    ConversationMessage,
    ProgressMessage,
    SubagentMessage,
    ToolUseBlock,
} from "./types";

function hasStringField<K extends string>(obj: object, key: K): obj is Record<K, string> {
    return key in obj && typeof (obj as Record<K, unknown>)[key] === "string";
}

/** Type guard for messages that carry a timestamp field. */
export function hasTimestamp(msg: ConversationMessage): msg is ConversationMessage & { timestamp: string } {
    return hasStringField(msg, "timestamp");
}

/** Type guard for messages that carry a sessionId field. */
export function hasSessionId(msg: ConversationMessage): msg is ConversationMessage & { sessionId: string } {
    return hasStringField(msg, "sessionId");
}

/** Type guard for messages with gitBranch. */
export function hasGitBranch(msg: ConversationMessage): msg is ConversationMessage & { gitBranch: string } {
    return hasStringField(msg, "gitBranch");
}

/** Type guard for messages with cwd. */
export function hasCwd(msg: ConversationMessage): msg is ConversationMessage & { cwd: string } {
    return hasStringField(msg, "cwd");
}

/** Extract tool_use blocks from an assistant message content array. */
export function getToolUseBlocks(content: ContentBlock[]): ToolUseBlock[] {
    return content.filter((b): b is ToolUseBlock => b.type === "tool_use");
}

/** Extract tool_use blocks from a subagent assistant message. */
export function getSubagentToolUseBlocks(msg: SubagentMessage): ToolUseBlock[] {
    if (msg.message.role !== "assistant") {
        return [];
    }

    const content = msg.message.content;

    if (!Array.isArray(content)) {
        return [];
    }

    return content.filter((b): b is ToolUseBlock => b.type === "tool_use");
}

/** Extract file path from a tool input object, checking common field names. */
export function extractFilePathFromInput(input: Record<string, unknown>): string | undefined {
    for (const field of ["file_path", "path", "filePath", "notebook_path"]) {
        const value = input[field];

        if (typeof value === "string") {
            return value;
        }
    }

    return undefined;
}

/** Check whether a JSONL file is from a subagent. */
export function isSubagentFile(filePath: string): boolean {
    return filePath.includes(`${sep}subagents${sep}`) || basename(filePath).startsWith("agent-");
}

/**
 * Read just the first N and last N lines from a JSONL file for fast metadata extraction.
 */
export async function readHeadTailLines(filePath: string, headCount: number, tailCount: number): Promise<string[]> {
    const text = await Bun.file(filePath).text();
    const allLines = text.split("\n").filter((l) => l.trim());

    if (allLines.length <= headCount + tailCount) {
        return allLines;
    }

    const head = allLines.slice(0, headCount);
    const tail = allLines.slice(-tailCount);
    return [...head, ...tail];
}

/** Extract readable text from a single user message content field. */
export function extractUserText(content: string | ContentBlock[]): string {
    if (typeof content === "string") {
        return content;
    }

    const parts: string[] = [];

    for (const block of content) {
        if (block.type === "text") {
            parts.push(block.text);
        } else if (block.type === "tool_result") {
            if (typeof block.content === "string") {
                parts.push(block.content);
            } else if (Array.isArray(block.content)) {
                for (const inner of block.content) {
                    if (inner.type === "text") {
                        parts.push(inner.text);
                    } else if (inner.type === "image") {
                        parts.push(`[Image: ${inner.source.media_type}]`);
                    } else if (inner.type === "tool_reference") {
                        parts.push(`[Tool Reference: ${inner.tool_name}]`);
                    }
                }
            }
        } else if (block.type === "image") {
            parts.push(`[Image: ${block.source.media_type}]`);
        } else if (block.type === "tool_reference") {
            parts.push(`[Tool Reference: ${block.tool_name}]`);
        }
    }

    return parts.join("\n");
}

/**
 * Convert an agent_progress ProgressMessage to a SubagentMessage.
 * Returns null if the progress message is not agent_progress or has no inner message.
 *
 * Modern Claude Code records agent work as progress events with data.type === "agent_progress"
 * instead of the legacy "subagent" message type. This normalizes the new format into the
 * SubagentMessage shape so all downstream code works unchanged.
 */
export function agentProgressToSubagent(msg: ProgressMessage): SubagentMessage | null {
    if (msg.data.type !== "agent_progress") {
        return null;
    }

    const data = msg.data as AgentProgressData;

    if (!data.message?.message) {
        return null;
    }

    return {
        type: "subagent",
        role: data.message.type,
        message: data.message.message,
        agentId: data.agentId,
        ...(msg.timestamp ? { timestamp: msg.timestamp } : {}),
    } as SubagentMessage;
}

const AGENT_STATS_RE =
    /agentId:\s*(\S+)[\s\S]*?<usage>\s*total_tokens:\s*(\d+)\s*\ntool_uses:\s*(\d+)\s*\nduration_ms:\s*(\d+)\s*<\/usage>/;

/**
 * Parse agent completion stats from a tool_result text block.
 * Returns null if the text doesn't match the expected agent result format.
 *
 * Format: `agentId: <id> (...)\n<usage>total_tokens: N\ntool_uses: N\nduration_ms: N</usage>`
 */
export function parseAgentCompletionStats(text: string): AgentCompletionStats | null {
    const match = AGENT_STATS_RE.exec(text);

    if (!match) {
        return null;
    }

    return {
        agentId: match[1],
        totalTokens: Number.parseInt(match[2], 10),
        toolUses: Number.parseInt(match[3], 10),
        durationMs: Number.parseInt(match[4], 10),
    };
}
