import { basename, sep } from "node:path";
import type {
    AssistantMessageContent,
    ContentBlock,
    ConversationMessage,
    ImageBlock,
    SubagentMessage,
    TextBlock,
    ToolReferenceBlock,
    ToolResultBlock,
    ToolUseBlock,
} from "./types";

/** Type guard for messages that carry a timestamp field. */
export function hasTimestamp(msg: ConversationMessage): msg is ConversationMessage & { timestamp: string } {
    return "timestamp" in msg && typeof (msg as unknown as { timestamp: unknown }).timestamp === "string";
}

/** Type guard for messages that carry a sessionId field. */
export function hasSessionId(msg: ConversationMessage): msg is ConversationMessage & { sessionId: string } {
    return "sessionId" in msg && typeof (msg as unknown as { sessionId: unknown }).sessionId === "string";
}

/** Type guard for messages with gitBranch. */
export function hasGitBranch(msg: ConversationMessage): msg is ConversationMessage & { gitBranch: string } {
    return "gitBranch" in msg && typeof (msg as unknown as { gitBranch: unknown }).gitBranch === "string";
}

/** Type guard for messages with cwd. */
export function hasCwd(msg: ConversationMessage): msg is ConversationMessage & { cwd: string } {
    return "cwd" in msg && typeof (msg as unknown as { cwd: unknown }).cwd === "string";
}

/** Extract tool_use blocks from an assistant message content array. */
export function getToolUseBlocks(content: ContentBlock[]): ToolUseBlock[] {
    return content.filter((b): b is ToolUseBlock => b.type === "tool_use");
}

/** Extract tool_use blocks from a subagent assistant message. */
export function getSubagentToolUseBlocks(msg: SubagentMessage): ToolUseBlock[] {
    if (msg.role !== "assistant") {
        return [];
    }

    const content = (msg.message as AssistantMessageContent).content;

    if (!Array.isArray(content)) {
        return [];
    }

    return content.filter((b): b is ToolUseBlock => b.type === "tool_use");
}

/** Extract file path from a tool input object, checking common field names. */
export function extractFilePathFromInput(input: Record<string, unknown>): string | undefined {
    for (const field of ["file_path", "path", "filePath", "notebook_path"]) {
        if (field in input && typeof input[field] === "string") {
            return input[field] as string;
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
            parts.push((block as TextBlock).text);
        } else if (block.type === "tool_result") {
            const tr = block as ToolResultBlock;

            if (typeof tr.content === "string") {
                parts.push(tr.content);
            } else if (Array.isArray(tr.content)) {
                for (const inner of tr.content) {
                    if (inner.type === "text") {
                        parts.push((inner as TextBlock).text);
                    } else if (inner.type === "image") {
                        parts.push(`[Image: ${(inner as ImageBlock).source.media_type}]`);
                    } else if (inner.type === "tool_reference") {
                        parts.push(`[Tool Reference: ${(inner as ToolReferenceBlock).tool_name}]`);
                    }
                }
            }
        } else if (block.type === "image") {
            parts.push(`[Image: ${(block as ImageBlock).source.media_type}]`);
        } else if (block.type === "tool_reference") {
            parts.push(`[Tool Reference: ${(block as ToolReferenceBlock).tool_name}]`);
        }
    }

    return parts.join("\n");
}
