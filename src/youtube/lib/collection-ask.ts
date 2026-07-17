import { logger } from "@app/logger";
import type { CallLLMStructuredOptions, CallLLMStructuredResult } from "@app/utils/ai/call-llm";
import { callLLMStructured } from "@app/utils/ai/call-llm";
import { SafeJSON } from "@app/utils/json";
import { resolveCollectionVideoIds } from "@app/youtube/lib/collection-rules";
import type { YoutubeDatabase } from "@app/youtube/lib/db";
import type { AskMessageRecord, CollectionRecord } from "@app/youtube/lib/db.types";
import { identifyProviderChoice, recordYoutubeUsage } from "@app/youtube/lib/usage";
import type { ProviderChoice } from "@ask/types";
import { z } from "zod";

export const MAX_TOOL_CALLS = 6;
export const TRANSCRIPT_CHAR_CAP = 24_000;

const AgentStepSchema = z.discriminatedUnion("action", [
    z.object({ action: z.literal("list_videos") }),
    z.object({ action: z.literal("get_transcript"), videoId: z.string() }),
    z.object({ action: z.literal("answer"), text: z.string() }),
]);

type AgentStep = z.infer<typeof AgentStepSchema>;

const SYSTEM_PROMPT = [
    "You are a research assistant answering questions about a user's video collection.",
    "You take exactly ONE action per turn, as JSON matching the schema:",
    '- {"action":"list_videos"} — list the collection\'s videos (id, title, channel, watched flag).',
    '- {"action":"get_transcript","videoId":"<id>"} — transcript excerpt for ONE video the user has watched.',
    '- {"action":"answer","text":"..."} — your final answer; reference video titles inline.',
    "Tool results appear as TOOL messages. Transcripts of unwatched videos are REFUSED — answer only from what the user may see.",
    `Budget: at most ${MAX_TOOL_CALLS} tool calls per question. Answer as soon as you have enough evidence.`,
].join("\n");

export interface CollectionAskDeps {
    callLLMStructured: (options: CallLLMStructuredOptions<AgentStep>) => Promise<CallLLMStructuredResult<AgentStep>>;
}

export interface CollectionAskInput {
    db: YoutubeDatabase;
    userId: number;
    collection: CollectionRecord;
    question: string;
    threadId?: number | null;
    providerChoice: ProviderChoice;
    /** Test seam — production callers omit it. */
    deps?: CollectionAskDeps;
}

export interface CollectionAskResult {
    threadId: number;
    answer: string;
    toolCalls: number;
}

export async function askCollection(input: CollectionAskInput): Promise<CollectionAskResult> {
    const deps: CollectionAskDeps = input.deps ?? { callLLMStructured };
    const thread = input.threadId
        ? input.db.getAskThread(input.userId, input.threadId)
        : input.db.createAskThread({
              userId: input.userId,
              collectionId: input.collection.id,
              title: input.question.slice(0, 80),
          });

    if (!thread) {
        throw new Error(`unknown ask thread: ${input.threadId}`);
    }

    if (thread.collectionId !== input.collection.id) {
        throw new Error("unknown ask thread: belongs to a different collection");
    }

    input.db.appendAskMessage({ threadId: thread.id, role: "user", content: input.question });
    let toolCalls = 0;

    for (;;) {
        const conversation = renderConversation(input.db.listAskMessages(thread.id));
        const budgetNote = toolCalls >= MAX_TOOL_CALLS ? "\n\nTOOL BUDGET EXHAUSTED — you MUST answer now." : "";
        const result = await deps.callLLMStructured({
            systemPrompt: SYSTEM_PROMPT,
            userPrompt: `Collection: "${input.collection.name}" (${input.collection.kind}).\n\nConversation so far:\n${conversation}${budgetNote}`,
            providerChoice: input.providerChoice,
            schema: AgentStepSchema,
        });
        const ids = identifyProviderChoice(input.providerChoice);
        await recordYoutubeUsage({
            action: "qa:ask",
            provider: ids.provider,
            model: ids.model,
            usage: result.usage,
            scope: `collection:${input.collection.id}`,
        });
        const step = result.object;

        if (step.action === "answer") {
            input.db.appendAskMessage({ threadId: thread.id, role: "assistant", content: step.text });
            input.db.touchAskThread(thread.id);
            logger.info(
                { threadId: thread.id, collectionId: input.collection.id, toolCalls },
                "youtube collection-ask: answered"
            );

            return { threadId: thread.id, answer: step.text, toolCalls };
        }

        if (toolCalls >= MAX_TOOL_CALLS) {
            throw new Error("collection ask: tool budget exhausted without an answer");
        }

        toolCalls += 1;
        const toolResult = executeTool(input, step);
        input.db.appendAskMessage({
            threadId: thread.id,
            role: "tool",
            content: toolResult,
            toolName: step.action,
            toolArgsJson: SafeJSON.stringify(step, { strict: true }),
        });
    }
}

function executeTool(input: CollectionAskInput, step: Exclude<AgentStep, { action: "answer" }>): string {
    if (step.action === "list_videos") {
        const ids = resolveCollectionVideoIds(input.db, input.collection);
        const videos = input.db.getVideosByIds(ids).map((video) => ({
            id: video.id,
            title: video.title,
            channel: video.channelHandle,
            watched: input.db.hasWatched(input.userId, video.id),
            hasTranscript: video.hasTranscript,
        }));

        return SafeJSON.stringify(videos, { strict: true });
    }

    // get_transcript — the hard server-side gate: membership AND watched.
    const memberIds = resolveCollectionVideoIds(input.db, input.collection);

    if (!memberIds.includes(step.videoId)) {
        return `REFUSED: ${step.videoId} is not in this collection.`;
    }

    if (!input.db.hasWatched(input.userId, step.videoId)) {
        return `REFUSED: the user has not watched ${step.videoId}; its transcript is not available.`;
    }

    const transcript = input.db.getTranscript(step.videoId);

    if (!transcript) {
        return `NO TRANSCRIPT: ${step.videoId} has no stored transcript yet.`;
    }

    const text =
        transcript.text.length > TRANSCRIPT_CHAR_CAP
            ? `${transcript.text.slice(0, TRANSCRIPT_CHAR_CAP)}\n[...truncated]`
            : transcript.text;

    return `TRANSCRIPT of ${step.videoId}:\n${text}`;
}

function renderConversation(messages: AskMessageRecord[]): string {
    return messages
        .map((message) => {
            if (message.role === "tool") {
                return `TOOL(${message.toolName}): ${message.content}`;
            }

            return `${message.role.toUpperCase()}: ${message.content}`;
        })
        .join("\n\n");
}
