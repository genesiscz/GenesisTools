/**
 * Full-exchange transcripts, written in the SAME JSONL shape Claude Code uses
 * for its session files: one JSON object per line, each with `uuid`,
 * `parentUuid`, `sessionId`, `timestamp`, `type` and a `message` carrying
 * `content` blocks. That shape is deliberate — every parser we already have for
 * Claude sessions (`parseJsonlTranscript`, learn-from-fable's miner) can read a
 * proxy transcript unchanged.
 *
 * `requests.jsonl` says WHAT was called and how long it took. A transcript says
 * what was actually sent and what came back, including the model's reasoning,
 * so a slow or wrong call can be reconstructed instead of re-run.
 *
 * Layout (one file per session, appended):
 *   ~/.genesis-tools/ai-proxy/transcripts/<YYYY-MM-DD>/<session>.jsonl
 *
 * `<session>` comes from the caller's `x-gt-session` header, so one pipeline run
 * is one file. Untagged callers land in `_untagged.jsonl`. Writes are
 * best-effort: a transcript must never slow down or fail a proxied request.
 */
import { appendFile, chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { getAiProxyStorage } from "@app/ai-proxy/lib/storage";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import type { CallTimeline } from "./call-timeline";
import type { RequestTags } from "./types";

export interface TranscriptInput {
    ts: string;
    account: string;
    provider: string;
    proxyModel: string;
    upstreamModel: string;
    path: string;
    status: number;
    elapsedMs: number;
    stream: boolean;
    requestBody: string;
    responseBody: string;
    tags?: RequestTags;
    /** Phase timings for this turn (dispatch, TTFB, thinking span, text span). */
    timeline?: CallTimeline;
}

export interface TranscriptRef {
    /** JSONL file the exchange was appended to. */
    file: string;
    /** uuid of the assistant entry, so a single call can be pulled out of the file. */
    uuid: string;
}

const MAX_TEXT_CHARS = 1_000_000;

/**
 * Transcripts hold whatever the caller sent, verbatim and unredacted, so the
 * directory is owner-only and every file is created 0600. The proxy is local,
 * but prompts routinely carry file contents and credentials.
 */
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/**
 * One append at a time per file, so concurrent calls sharing a session cannot
 * interleave half-written lines. Chained rather than awaited by the caller: a
 * transcript must never slow down a proxied request.
 */
const appendQueues = new Map<string, Promise<void>>();

/**
 * `mode` on mkdir/appendFile only applies to paths those calls create, so a
 * directory or file written before this hardening (or by another process) would
 * keep its old permissions and quietly break the guarantee above. chmod after
 * the write covers the pre-existing case too.
 */
async function enforceMode(path: string, mode: number): Promise<void> {
    try {
        await chmod(path, mode);
    } catch (err) {
        logger.debug({ err, path, mode }, "ai-proxy transcripts: chmod failed");
    }
}

function queueAppend(file: string, day: string, payload: string): void {
    const next = (appendQueues.get(file) ?? Promise.resolve())
        .then(async () => {
            const dir = join(transcriptsRoot(), day);
            await mkdir(dir, { recursive: true, mode: DIR_MODE });
            await enforceMode(dir, DIR_MODE);
            await appendFile(file, payload, { mode: FILE_MODE });
            await enforceMode(file, FILE_MODE);
        })
        .catch((err: unknown) => {
            logger.debug({ err, file }, "ai-proxy transcripts: append failed");
        });

    appendQueues.set(file, next);
    void next.then(() => {
        if (appendQueues.get(file) === next) {
            appendQueues.delete(file);
        }
    });
}

/** Transcripts are opt-out; a realtime session must honour the same switch. */
export function transcriptsEnabled(): boolean {
    return env.aiProxy.getTranscripts();
}

/**
 * Append already-serialized JSONL entries to a session file. Realtime sessions
 * stream for minutes, so they write as they go instead of building one exchange
 * up front the way `writeTranscript` does.
 */
export function appendTranscriptLines(file: string, day: string, lines: string[]): void {
    if (lines.length === 0) {
        return;
    }

    queueAppend(file, day, `${lines.join("\n")}\n`);
}

function sanitize(part: string | undefined, fallback: string): string {
    const cleaned = (part ?? "").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
    return cleaned || fallback;
}

export function transcriptsRoot(): string {
    return join(getAiProxyStorage().getBaseDir(), "transcripts");
}

/** JSONL file holding one session's exchanges. */
export function transcriptFile(day: string, session?: string): string {
    return join(transcriptsRoot(), day, `${sanitize(session, "_untagged")}.jsonl`);
}

type ContentBlock =
    | { type: "text"; text: string }
    | { type: "thinking"; thinking: string }
    | { type: "tool_use"; id: string; name: string; input: unknown }
    | { type: "tool_result"; tool_use_id: string; content: string };

interface OpenAiToolCall {
    id?: string;
    function?: { name?: string; arguments?: string };
}

interface ParsedResponse {
    text: string;
    thinking: string;
    usage?: Record<string, unknown>;
    finishReason?: string;
    toolCalls?: OpenAiToolCall[];
}

interface SseDelta {
    content?: string;
    reasoning_content?: string;
    reasoning?: string;
    thinking?: string;
    tool_calls?: OpenAiToolCall[];
}

interface ChatChoice {
    delta?: SseDelta;
    message?: {
        content?: string;
        reasoning_content?: string;
        reasoning?: string;
        tool_calls?: OpenAiToolCall[];
    };
    finish_reason?: string;
}

interface ChatPayload {
    choices?: ChatChoice[];
    usage?: Record<string, unknown>;
}

/** Reassemble a streamed or plain response into text + thinking + usage. */
export function parseResponseBody(body: string, stream: boolean): ParsedResponse {
    const parsed: ParsedResponse = { text: "", thinking: "" };

    if (!body.trim()) {
        return parsed;
    }

    if (!stream) {
        try {
            const payload = SafeJSON.parse(body, { strict: true }) as ChatPayload;
            const choice = payload.choices?.[0];
            parsed.text = choice?.message?.content ?? "";
            parsed.thinking = choice?.message?.reasoning_content ?? choice?.message?.reasoning ?? "";
            parsed.usage = payload.usage;
            parsed.finishReason = choice?.finish_reason;
            parsed.toolCalls = choice?.message?.tool_calls;
        } catch (err) {
            logger.debug({ err }, "ai-proxy transcripts: non-JSON response body kept verbatim");
            parsed.text = body.slice(0, MAX_TEXT_CHARS);
        }

        return parsed;
    }

    for (const line of body.split("\n")) {
        if (!line.startsWith("data:")) {
            continue;
        }

        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") {
            continue;
        }

        try {
            const payload = SafeJSON.parse(data, { strict: true }) as ChatPayload;
            const choice = payload.choices?.[0];
            const delta = choice?.delta;
            parsed.text += delta?.content ?? "";
            parsed.thinking += delta?.reasoning_content ?? delta?.reasoning ?? delta?.thinking ?? "";

            if (delta?.tool_calls?.length) {
                parsed.toolCalls = [...(parsed.toolCalls ?? []), ...delta.tool_calls];
            }

            if (choice?.finish_reason) {
                parsed.finishReason = choice.finish_reason;
            }

            if (payload.usage) {
                parsed.usage = payload.usage;
            }
        } catch (err) {
            logger.debug({ err }, "ai-proxy transcripts: skipped unparseable SSE frame");
        }
    }

    return parsed;
}

interface RequestMessage {
    role: string;
    content: unknown;
    tool_calls?: OpenAiToolCall[];
    tool_call_id?: string;
}

function messageText(content: unknown): string {
    if (typeof content === "string") {
        return content;
    }

    if (Array.isArray(content)) {
        return content
            .map((block) => {
                if (typeof block === "string") {
                    return block;
                }

                const typed = block as { type?: string; text?: string; thinking?: string };
                return typed.text ?? typed.thinking ?? "";
            })
            .join("\n");
    }

    return content === undefined || content === null ? "" : SafeJSON.stringify(content, { strict: true });
}

/** OpenAI `tool_calls` become Claude `tool_use` blocks so `toolUses()` finds them. */
function toolUseBlocks(calls: OpenAiToolCall[] | undefined): ContentBlock[] {
    return (calls ?? []).map((call) => {
        const raw = call.function?.arguments ?? "";
        let input: unknown = raw;

        try {
            input = raw ? SafeJSON.parse(raw, { strict: true }) : {};
        } catch (err) {
            logger.debug({ err }, "ai-proxy transcripts: tool call arguments were not JSON");
        }

        return { type: "tool_use", id: call.id ?? crypto.randomUUID(), name: call.function?.name ?? "", input };
    });
}

/**
 * One request message as Claude-shaped content blocks. A `role: "tool"` message
 * becomes a `tool_result` block (which is how `loadTurns()` recognizes a tool
 * result at all) and an assistant message keeps its calls as `tool_use` blocks,
 * so an agentic exchange survives the round-trip with its structure intact.
 */
function requestMessageBlocks(message: RequestMessage): ContentBlock[] {
    const text = messageText(message.content).slice(0, MAX_TEXT_CHARS);

    if (message.role === "tool") {
        return [{ type: "tool_result", tool_use_id: message.tool_call_id ?? "", content: text }];
    }

    const blocks: ContentBlock[] = [];
    if (text || !message.tool_calls?.length) {
        blocks.push({ type: "text", text });
    }

    blocks.push(...toolUseBlocks(message.tool_calls));
    return blocks;
}

/**
 * Append one exchange as Claude-Code-shaped JSONL entries: every request message
 * becomes an entry, and the response becomes an assistant entry whose content
 * carries a `thinking` block (when the model exposed reasoning) followed by the
 * answer text.
 */
export function writeTranscript(input: TranscriptInput): TranscriptRef | undefined {
    if (!env.aiProxy.getTranscripts()) {
        return undefined;
    }

    const day = input.ts.slice(0, 10);
    const file = transcriptFile(day, input.tags?.session);
    const sessionId = input.tags?.session ?? "_untagged";
    const callId = crypto.randomUUID();

    let request: { messages?: RequestMessage[]; [key: string]: unknown } = {};
    try {
        request = SafeJSON.parse(input.requestBody || "{}", { strict: true }) as typeof request;
    } catch (err) {
        logger.debug({ err }, "ai-proxy transcripts: request body was not JSON");
    }

    const response = parseResponseBody(input.responseBody, input.stream);
    const assistantContent: ContentBlock[] = [];
    if (response.thinking.trim()) {
        assistantContent.push({ type: "thinking", thinking: response.thinking.slice(0, MAX_TEXT_CHARS) });
    }

    assistantContent.push({ type: "text", text: response.text.slice(0, MAX_TEXT_CHARS) });
    assistantContent.push(...toolUseBlocks(response.toolCalls));

    // Parsing produced nothing but bytes did arrive: keep the raw body so the
    // shape that defeated the parser is visible instead of silently lost.
    const unparsed =
        !response.text.trim() && !response.thinking.trim() && input.responseBody.trim().length > 0
            ? input.responseBody.slice(0, 20_000)
            : undefined;

    const lines: string[] = [];
    let parentUuid: string | null = null;

    for (const message of request.messages ?? []) {
        const uuid = crypto.randomUUID();
        lines.push(
            SafeJSON.stringify(
                {
                    parentUuid,
                    sessionId,
                    uuid,
                    timestamp: input.ts,
                    type: message.role === "assistant" ? "assistant" : "user",
                    callId,
                    message: {
                        role: message.role,
                        content: requestMessageBlocks(message),
                    },
                },
                { strict: true }
            )
        );
        parentUuid = uuid;
    }

    const assistantUuid = crypto.randomUUID();
    lines.push(
        SafeJSON.stringify(
            {
                parentUuid,
                sessionId,
                uuid: assistantUuid,
                timestamp: new Date(new Date(input.ts).getTime() + input.elapsedMs).toISOString(),
                type: "assistant",
                callId,
                tags: input.tags ?? {},
                elapsedMs: input.elapsedMs,
                timeline: input.timeline,
                status: input.status,
                stream: input.stream,
                account: input.account,
                provider: input.provider,
                path: input.path,
                rawResponse: unparsed,
                requestParams: {
                    max_tokens: request.max_tokens,
                    temperature: request.temperature,
                    reasoning_effort: request.reasoning_effort,
                    // The OpenRouter-style `reasoning` object decides whether the
                    // upstream returns thinking at all. Without it recorded, a
                    // client that suppressed thinking is indistinguishable from a
                    // model that simply did not think — which is exactly the
                    // question a "why is there no thinking" report needs answered.
                    reasoning: request.reasoning,
                    response_format: request.response_format,
                    tools: Array.isArray(request.tools) ? request.tools.length : undefined,
                },
                message: {
                    role: "assistant",
                    model: input.upstreamModel,
                    proxyModel: input.proxyModel,
                    content: assistantContent,
                    stop_reason: response.finishReason,
                    tool_calls: response.toolCalls,
                    usage: response.usage,
                },
            },
            { strict: true }
        )
    );

    queueAppend(file, day, `${lines.join("\n")}\n`);

    return { file, uuid: assistantUuid };
}

/** Read `x-gt-*` tags off an incoming request. */
export function readRequestTags(headers: Headers): RequestTags | undefined {
    const tags: RequestTags = {
        session: headers.get("x-gt-session") ?? undefined,
        stage: headers.get("x-gt-stage") ?? undefined,
        run: headers.get("x-gt-run") ?? undefined,
        label: headers.get("x-gt-label") ?? undefined,
    };

    return Object.values(tags).some(Boolean) ? tags : undefined;
}
