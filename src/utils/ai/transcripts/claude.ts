import { statSync } from "node:fs";
import { ClaudeSession } from "@genesiscz/utils/claude/session";
import { getToolUseBlocks, humanTextOf } from "@genesiscz/utils/claude/session.utils";
import { extractToolInputSummary, extractToolResultText } from "@genesiscz/utils/claude/session-helpers";
import type {
    AssistantMessage,
    AssistantMessageContent,
    ConversationMessage,
    ToolResultBlock,
    UserMessage,
} from "@genesiscz/utils/claude/types";
import { cleanTranscriptText } from "./clean-text";
import { type PromptPart, structuredPromptParts } from "./prompt-parts";
import {
    clipResult,
    type SliceOptions,
    sliceTurns,
    type TranscriptEnvelope,
    type TranscriptTool,
    type TranscriptTurn,
    type TranscriptUsage,
} from "./types";

/** Input is net of cache reads (shown apart as `cache`); cache writes are fresh input, so they count in it. */
function assistantUsage(message: AssistantMessageContent): TranscriptUsage | undefined {
    if (!message.usage || message.model === "<synthetic>") {
        return undefined;
    }

    return {
        inputTokens: message.usage.input_tokens + (message.usage.cache_creation_input_tokens ?? 0),
        cacheReadTokens: message.usage.cache_read_input_tokens,
        outputTokens: message.usage.output_tokens,
    };
}

function toolResultsFromUser(msg: UserMessage): ToolResultBlock[] {
    const content = msg.message.content;
    if (typeof content === "string") {
        return [];
    }
    return content.filter((b): b is ToolResultBlock => b.type === "tool_result");
}

function userHasVisibleText(msg: UserMessage): boolean {
    const content = msg.message.content;
    if (typeof content === "string") {
        return content.trim().length > 0;
    }
    return content.some((b) => b.type === "text" && b.text.trim().length > 0);
}

function attachResults(tools: TranscriptTool[], results: ToolResultBlock[]): void {
    const byId = new Map(results.map((r) => [r.tool_use_id, r]));
    for (const tool of tools) {
        const hit = byId.get(tool.id);
        if (!hit) {
            continue;
        }
        tool.result = clipResult(extractToolResultText(hit));
        tool.isError = hit.is_error === true;
    }
}

const DELIVERY_KINDS = new Set<PromptPart["kind"]>(["teammate", "task", "interrupt"]);

/**
 * A user turn's `text`, or "" when the turn shows nothing. A prompt that showed before keeps the text
 * it always had, so a reader that knows no parts sees no change. A turn only its parts make visible
 * gets the user's words (a message typed mid-turn, which Claude Code stores as meta), else the
 * delivery itself (a task result the cleaner drops whole), which still opens with its harness marker
 * so `isHarnessDeliveryText` keeps it out of the user's prompts.
 */
function userTurnText(input: { raw: string; parts: PromptPart[] | undefined; isMeta: boolean }): string {
    const { raw, parts, isMeta } = input;
    if (!isMeta) {
        const cleaned = cleanTranscriptText(raw);
        if (cleaned) {
            return cleaned;
        }
    }

    const own = (parts ?? []).flatMap((part) => (part.kind === "user" && (part.midTurn || !isMeta) ? [part.text] : []));
    if (own.length > 0) {
        return own.join(" ");
    }

    if (isMeta || !parts?.some((part) => DELIVERY_KINDS.has(part.kind))) {
        return "";
    }

    return raw.replace(/\s+/g, " ").trim();
}

export function claudeMessagesToTurns(messages: ConversationMessage[]): TranscriptTurn[] {
    const turns: TranscriptTurn[] = [];
    let pendingTools: TranscriptTool[] = [];
    // One API response is written as one row per content block, all sharing message.id: its usage
    // counts once, on the response's first visible turn, with the last row's (final) figures.
    const lastUsage = new Map<string, TranscriptUsage>();
    const firstTurn = new Map<string, TranscriptTurn>();

    const flushPending = () => {
        pendingTools = [];
    };

    for (const msg of messages) {
        if (msg.type === "user") {
            const results = toolResultsFromUser(msg);
            if (results.length > 0 && pendingTools.length > 0) {
                attachResults(pendingTools, results);
                if (pendingTools.every((tool) => tool.result !== null)) {
                    flushPending();
                }
            }
            if (!userHasVisibleText(msg)) {
                continue;
            }
            const raw = humanTextOf(msg.message.content);
            const parts = structuredPromptParts(raw);
            const text = userTurnText({ raw, parts, isMeta: msg.isMeta === true });
            if (!text) {
                continue;
            }
            turns.push({
                id: msg.uuid,
                role: "user",
                at: msg.timestamp ?? null,
                text,
                tools: [],
                ...(parts ? { parts } : {}),
            });
            continue;
        }

        if (msg.type === "assistant") {
            const assistant = msg as AssistantMessage;
            const content = assistant.message.content;
            const messageId = assistant.message.id;
            const usage = assistantUsage(assistant.message);

            if (messageId && usage) {
                lastUsage.set(messageId, usage);
            }

            const text = content
                .filter((b) => b.type === "text")
                .map((b) => b.text)
                .join("\n")
                .trim();
            const tools: TranscriptTool[] = getToolUseBlocks(content).map((b) => ({
                id: b.id,
                name: b.name,
                inputPreview: extractToolInputSummary(b),
                result: null,
                isError: false,
            }));
            if (!text && tools.length === 0) {
                continue;
            }
            const turn: TranscriptTurn = {
                id: assistant.uuid,
                role: "assistant",
                at: assistant.timestamp ?? null,
                text,
                tools,
            };
            turns.push(turn);

            if (messageId && !firstTurn.has(messageId)) {
                firstTurn.set(messageId, turn);
            }

            pendingTools = tools;
        }
    }

    for (const [messageId, turn] of firstTurn) {
        const usage = lastUsage.get(messageId);
        if (usage) {
            turn.usage = usage;
        }
    }

    return turns;
}

export async function claudeTranscriptEnvelope(
    sessionId: string,
    opts: SliceOptions = {}
): Promise<TranscriptEnvelope> {
    const session = await ClaudeSession.fromSessionId(sessionId);
    const all = claudeMessagesToTurns(session.messages);
    const sliced = sliceTurns(all, opts);
    let byteSize = 0;
    try {
        byteSize = statSync(session.filePath).size;
    } catch {
        byteSize = 0;
    }
    return {
        provider: "claude",
        sessionId: session.sessionId ?? sessionId,
        filePath: session.filePath,
        byteSize,
        truncated: sliced.truncated,
        nextOffset: sliced.nextOffset,
        turns: sliced.turns,
        turnCount: all.length,
    };
}
