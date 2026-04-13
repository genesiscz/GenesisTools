/**
 * Claude Code JSONL -> AgentMessage adapter.
 *
 * Converts ConversationMessage objects from Claude Code session files
 * into the agent-agnostic AgentMessage model for rendering.
 */

import { extractProjectName } from "@app/utils/claude/projects";
import type {
    AssistantMessage,
    ContentBlock,
    ConversationMessage,
    ImageBlock,
    SubagentMessage,
    SystemMessage,
    TextBlock,
    ToolResultBlock,
    Usage,
    UserMessage,
} from "@app/utils/claude/types";

import type {
    AgentContentBlock,
    AgentMessage,
    AgentNotificationBlock,
    AgentRole,
    AgentSessionInfo,
    AgentTextBlock,
    AgentThinkingBlock,
    AgentToolCallBlock,
    AgentToolResultBlock,
    AgentUsage,
} from "../types";

// ─── System-reminder / task-notification parsing ────────────────────────────

const SYSTEM_REMINDER_RE = /<system-reminder>[\s\S]*?<\/system-reminder>/g;

const TASK_NOTIFICATION_RE = /<task-notification>[\s\S]*?<\/task-notification>/g;

interface TaskNotification {
    taskId: string;
    status: string;
    summary: string;
}

function parseTaskNotification(xml: string): TaskNotification | null {
    const taskId = xml.match(/<task-id>([^<]+)<\/task-id>/)?.[1];
    const status = xml.match(/<status>([^<]+)<\/status>/)?.[1];
    const summary = xml.match(/<summary>([^<]+)<\/summary>/)?.[1];

    if (!taskId || !status || !summary) {
        return null;
    }

    return { taskId, status, summary };
}

function stripSystemReminders(text: string): string {
    return text.replace(SYSTEM_REMINDER_RE, "").trim();
}

function extractTaskNotifications(text: string): AgentNotificationBlock[] {
    const blocks: AgentNotificationBlock[] = [];
    const matches = text.matchAll(TASK_NOTIFICATION_RE);

    for (const match of matches) {
        const parsed = parseTaskNotification(match[0]);

        if (parsed) {
            blocks.push({
                type: "agent_notification",
                agentId: parsed.taskId,
                status: parsed.status,
                summary: parsed.summary,
            });
        }
    }

    return blocks;
}

function stripTaskNotifications(text: string): string {
    return text.replace(TASK_NOTIFICATION_RE, "").trim();
}

// ─── Usage mapping ──────────────────────────────────────────────────────────

function mapUsage(usage: Usage): AgentUsage {
    return {
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        cacheReadTokens: usage.cache_read_input_tokens,
        cacheWriteTokens: usage.cache_creation_input_tokens,
    };
}

// ─── Content block converters ───────────────────────────────────────────────

function mapToolResultContent(block: ToolResultBlock): string {
    if (typeof block.content === "string") {
        return block.content;
    }

    if (Array.isArray(block.content)) {
        return block.content
            .filter((b): b is TextBlock => b.type === "text")
            .map((b) => b.text)
            .join("\n");
    }

    return "";
}

function convertAssistantBlocks(blocks: ContentBlock[]): AgentContentBlock[] {
    const result: AgentContentBlock[] = [];

    for (const block of blocks) {
        switch (block.type) {
            case "text": {
                const text = block.text.trim();

                if (text) {
                    result.push({ type: "text", text } satisfies AgentTextBlock);
                }

                break;
            }

            case "thinking": {
                const thinking = block.thinking.trim();

                if (thinking) {
                    result.push({
                        type: "thinking",
                        text: thinking,
                        signature: block.signature,
                    } satisfies AgentThinkingBlock);
                }

                break;
            }

            case "tool_use": {
                result.push({
                    type: "tool_call",
                    id: block.id,
                    name: block.name,
                    input: block.input,
                } satisfies AgentToolCallBlock);
                break;
            }

            // tool_result blocks in assistant messages are unusual but possible
            case "tool_result": {
                result.push({
                    type: "tool_result",
                    toolCallId: block.tool_use_id,
                    content: mapToolResultContent(block),
                    isError: block.is_error,
                } satisfies AgentToolResultBlock);
                break;
            }

            case "image": {
                const imgBlock = block as ImageBlock;
                result.push({
                    type: "image",
                    mediaType: imgBlock.source.media_type,
                    data: imgBlock.source.data,
                });
                break;
            }

            case "tool_reference": {
                // Not renderable as an agent block -- skip
                break;
            }
        }
    }

    return result;
}

function convertUserBlocks(content: string | ContentBlock[]): AgentContentBlock[] {
    if (typeof content === "string") {
        return convertUserText(content);
    }

    const result: AgentContentBlock[] = [];

    for (const block of content) {
        switch (block.type) {
            case "text": {
                result.push(...convertUserText(block.text));
                break;
            }

            case "tool_result": {
                result.push({
                    type: "tool_result",
                    toolCallId: block.tool_use_id,
                    content: mapToolResultContent(block),
                    isError: block.is_error,
                } satisfies AgentToolResultBlock);
                break;
            }

            case "image": {
                const imgBlock = block as ImageBlock;
                result.push({
                    type: "image",
                    mediaType: imgBlock.source.media_type,
                    data: imgBlock.source.data,
                });
                break;
            }

            default:
                break;
        }
    }

    return result;
}

/**
 * Convert user text: strip system-reminders, extract task-notifications,
 * and emit the remaining cleaned text (if any).
 */
function convertUserText(raw: string): AgentContentBlock[] {
    const blocks: AgentContentBlock[] = [];
    const notifications = extractTaskNotifications(raw);

    blocks.push(...notifications);

    const cleaned = stripTaskNotifications(stripSystemReminders(raw));

    if (cleaned) {
        blocks.push({ type: "text", text: cleaned } satisfies AgentTextBlock);
    }

    return blocks;
}

// ─── Message converters ─────────────────────────────────────────────────────

function convertUserMessage(msg: UserMessage): AgentMessage | null {
    if (msg.isMeta) {
        return null;
    }

    const blocks = convertUserBlocks(msg.message.content);

    if (blocks.length === 0) {
        return null;
    }

    return {
        role: "user",
        blocks,
        timestamp: parseTimestamp(msg.timestamp),
        meta: buildMeta(msg),
    };
}

function convertAssistantMessage(msg: AssistantMessage): AgentMessage | null {
    const content = msg.message?.content;

    if (!Array.isArray(content) || content.length === 0) {
        return null;
    }

    const blocks = convertAssistantBlocks(content);

    if (blocks.length === 0) {
        return null;
    }

    return {
        role: "assistant",
        blocks,
        timestamp: parseTimestamp(msg.timestamp),
        model: msg.message.model,
        usage: mapUsage(msg.message.usage),
        meta: buildMeta(msg),
    };
}

function convertSystemMessage(msg: SystemMessage): AgentMessage {
    const text = [msg.subtype, msg.level, msg.stopReason].filter(Boolean).join(" | ");

    return {
        role: "system",
        blocks: [{ type: "text", text } satisfies AgentTextBlock],
        timestamp: parseTimestamp(msg.timestamp),
        meta: {
            ...buildMeta(msg),
            subtype: msg.subtype,
            level: msg.level,
        },
    };
}

function convertSubagentMessage(msg: SubagentMessage): AgentMessage | null {
    const role: AgentRole = msg.role === "user" ? "user" : "assistant";
    let blocks: AgentContentBlock[];

    if (msg.message.role === "user") {
        const userContent = msg.message.content;
        blocks = convertUserBlocks(userContent);
    } else {
        const assistantContent = msg.message.content;

        if (!Array.isArray(assistantContent)) {
            return null;
        }

        blocks = convertAssistantBlocks(assistantContent);
    }

    if (blocks.length === 0) {
        return null;
    }

    const agentMsg: AgentMessage = {
        role,
        blocks,
        timestamp: parseTimestamp(msg.timestamp),
        meta: {
            ...buildMeta(msg),
            agentId: msg.agentId,
            isSubagent: true,
        },
    };

    if (msg.message.role === "assistant") {
        const assistantContent = msg.message as import("@app/utils/claude/types").AssistantMessageContent;
        agentMsg.model = assistantContent.model;
        agentMsg.usage = mapUsage(assistantContent.usage);
    }

    return agentMsg;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function parseTimestamp(ts: string | undefined): Date | undefined {
    if (!ts) {
        return undefined;
    }

    const date = new Date(ts);

    if (Number.isNaN(date.getTime())) {
        return undefined;
    }

    return date;
}

function buildMeta(msg: ConversationMessage): Record<string, unknown> {
    const meta: Record<string, unknown> = {};

    if ("uuid" in msg && msg.uuid) {
        meta.uuid = msg.uuid;
    }

    if ("sessionId" in msg && msg.sessionId) {
        meta.sessionId = msg.sessionId;
    }

    if ("gitBranch" in msg && msg.gitBranch) {
        meta.gitBranch = msg.gitBranch;
    }

    if ("isSidechain" in msg && msg.isSidechain) {
        meta.isSidechain = true;
    }

    return meta;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Convert a single Claude Code ConversationMessage into an AgentMessage.
 * Returns null for non-renderable message types (progress, file-history-snapshot, queue-operation).
 */
export function toAgentMessage(msg: ConversationMessage): AgentMessage | null {
    switch (msg.type) {
        case "user":
            return convertUserMessage(msg);

        case "assistant":
            return convertAssistantMessage(msg);

        case "system":
            return convertSystemMessage(msg);

        case "subagent":
            return convertSubagentMessage(msg);

        case "summary":
            return {
                role: "metadata",
                blocks: [{ type: "text", text: msg.summary } satisfies AgentTextBlock],
                meta: { kind: "summary", leafUuid: msg.leafUuid },
            };

        case "custom-title":
            return {
                role: "metadata",
                blocks: [{ type: "text", text: msg.customTitle } satisfies AgentTextBlock],
                meta: { kind: "custom-title", sessionId: msg.sessionId },
            };

        case "pr-link":
            return {
                role: "metadata",
                blocks: [{ type: "text", text: msg.url } satisfies AgentTextBlock],
                timestamp: parseTimestamp(msg.timestamp),
                meta: { kind: "pr-link", sessionId: msg.sessionId },
            };

        case "progress":
        case "file-history-snapshot":
        case "queue-operation":
            return null;
    }
}

/**
 * Batch-convert Claude Code messages, filtering out nulls.
 */
export function toAgentMessages(msgs: ConversationMessage[]): AgentMessage[] {
    const result: AgentMessage[] = [];

    for (const msg of msgs) {
        const converted = toAgentMessage(msg);

        if (converted) {
            result.push(converted);
        }
    }

    return result;
}

/**
 * Extract session metadata from a Claude Code JSONL message array.
 * Scans the messages for sessionId, gitBranch, customTitle, summary,
 * and derives the project name from the file path.
 */
export function toAgentSessionInfo(msgs: ConversationMessage[], filePath: string): AgentSessionInfo {
    let sessionId = "";
    let gitBranch: string | undefined;
    let customTitle: string | undefined;
    let summary: string | undefined;
    let startedAt: Date | undefined;
    let lastActiveAt: Date | undefined;
    let isSubagent = false;

    for (const msg of msgs) {
        // Extract sessionId from the first message that has one
        if (!sessionId && "sessionId" in msg && typeof msg.sessionId === "string") {
            sessionId = msg.sessionId;
        }

        // Extract gitBranch from the first message that has one
        if (!gitBranch && "gitBranch" in msg && typeof msg.gitBranch === "string") {
            gitBranch = msg.gitBranch;
        }

        // Track timestamps for start/end
        if ("timestamp" in msg && typeof msg.timestamp === "string") {
            const ts = parseTimestamp(msg.timestamp);

            if (ts) {
                if (!startedAt || ts < startedAt) {
                    startedAt = ts;
                }

                if (!lastActiveAt || ts > lastActiveAt) {
                    lastActiveAt = ts;
                }
            }
        }

        // Detect subagent sessions
        if ("userType" in msg && msg.userType === "internal") {
            isSubagent = true;
        }

        // Custom title
        if (msg.type === "custom-title") {
            customTitle = msg.customTitle;
        }

        // Summary
        if (msg.type === "summary") {
            summary = msg.summary;
        }
    }

    const project = extractProjectName(filePath);

    return {
        id: sessionId,
        provider: "claude-code",
        title: customTitle,
        summary,
        branch: gitBranch,
        project,
        startedAt,
        lastActiveAt,
        isSubagent: isSubagent || undefined,
    };
}
