import { statSync } from "node:fs";
import { ClaudeSession } from "@genesiscz/utils/claude/session";
import { extractToolInputSummary, extractToolResultText } from "@genesiscz/utils/claude/session-helpers";
import { extractUserText } from "@genesiscz/utils/claude/session.utils";
import type {
    AssistantMessage,
    ConversationMessage,
    ToolResultBlock,
    UserMessage,
} from "@genesiscz/utils/claude/types";
import { clipResult, sliceTurns, type SliceOptions, type TranscriptEnvelope, type TranscriptTool, type TranscriptTurn } from "./types";

const NOISE_BLOCKS =
    /<(local-command-caveat|local-command-stdout|system-reminder|command-name|command-message|command-args)>[\s\S]*?<\/\1>/g;

function cleanTranscriptText(raw: string): string {
    const commands: string[] = [];
    for (const match of raw.matchAll(/<command-name>\s*([^<]+?)\s*<\/command-name>/gi)) {
        const name = match[1]?.trim();
        if (name) {
            commands.push(name.startsWith("/") ? name : `/${name}`);
        }
    }
    const text = raw
        .replace(/\[Image #\d+\]/g, " ")
        .replace(NOISE_BLOCKS, " ")
        .replace(/<\/?[a-z][\w-]*>/gi, " ")
        .replace(/\s+/g, " ")
        .trim();
    return text || commands.join(" ");
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

export function claudeMessagesToTurns(messages: ConversationMessage[]): TranscriptTurn[] {
    const turns: TranscriptTurn[] = [];
    let pendingTools: TranscriptTool[] = [];

    const flushPending = () => {
        pendingTools = [];
    };

    for (const msg of messages) {
        if (msg.type === "user") {
            const results = toolResultsFromUser(msg);
            if (results.length > 0 && pendingTools.length > 0) {
                attachResults(pendingTools, results);
                flushPending();
            }
            if (!userHasVisibleText(msg) || msg.isMeta) {
                continue;
            }
            const raw = extractUserText(msg.message.content);
            const text = cleanTranscriptText(raw);
            if (!text) {
                continue;
            }
            turns.push({
                id: msg.uuid,
                role: "user",
                at: msg.timestamp ?? null,
                text,
                tools: [],
            });
            continue;
        }

        if (msg.type === "assistant") {
            const assistant = msg as AssistantMessage;
            const content = assistant.message.content;
            const text = content
                .filter((b) => b.type === "text")
                .map((b) => b.text)
                .join("\n")
                .trim();
            const tools: TranscriptTool[] = content
                .filter((b) => b.type === "tool_use")
                .map((b) => ({
                    id: b.id,
                    name: b.name,
                    inputPreview: extractToolInputSummary(b),
                    result: null,
                    isError: false,
                }));
            if (!text && tools.length === 0) {
                continue;
            }
            turns.push({
                id: assistant.uuid,
                role: "assistant",
                at: assistant.timestamp ?? null,
                text,
                tools,
            });
            pendingTools = tools;
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
    };
}
