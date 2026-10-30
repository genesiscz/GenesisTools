import { randomUUID } from "node:crypto";
import { jsonError } from "@app/ai-proxy/lib/http-error";
import { readCompactionText } from "@app/ai-proxy/lib/providers/codex/wham-stream";
import type { ProviderRequestContext } from "@app/ai-proxy/lib/providers/types";
import { messageToAnthropicSse } from "@app/ai-proxy/lib/server-tools/web-search";
import {
    type BackgroundResult,
    backgroundInFlight,
    backgroundResult,
    clearBackground,
    estimateTokens,
    matchBackground,
    prefixHash,
    setPendingNotice,
} from "@app/ai-proxy/lib/sessions/background-compaction";
import {
    type CompactionRecord,
    compactionFromSse,
    compactionNote,
    expandCompactionMarkers,
    hasCompactionFallback,
    loadCompaction,
    newCompactionId,
    saveCompaction,
} from "@app/ai-proxy/lib/sessions/codex-compaction";
import { type CompactionTrace, recordCompactionEvent } from "@app/ai-proxy/lib/sessions/compaction-events";
import type { BackgroundCompactionSettings } from "@app/ai-proxy/lib/sessions/settings";
import { toAnthropicErrorResponse } from "@app/ai-proxy/lib/translators/formats/anthropic/error-envelope";
import {
    accountHash8,
    type ReasoningEnvelopeStamp,
} from "@app/ai-proxy/lib/translators/formats/anthropic/reasoning-envelope";
import type { UsageRequestRecord } from "@app/ai-proxy/lib/usage/types";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { isObject } from "@genesiscz/utils/object";

export class CompactionRestoreError extends Error {
    constructor(
        readonly marker: string,
        readonly permanent: boolean,
        message: string,
        readonly missingId: string = marker,
        readonly upstreamResponse?: Response
    ) {
        super(message);
    }
}

export function inputHasFallback(input: unknown[], id: string): boolean {
    return input.some(
        (item) =>
            isObject(item) &&
            Array.isArray(item.content) &&
            item.content.some(
                (part) => isObject(part) && typeof part.text === "string" && hasCompactionFallback(part.text, id)
            )
    );
}

/** Bound compaction preparation and send SSE pings while the provider is still preparing a response. */
export async function compactionDispatch({
    signal,
    stream,
    run,
    timeoutMs = 900_000,
    pingMs = 15_000,
}: {
    signal: AbortSignal;
    stream: boolean;
    run: (signal: AbortSignal) => Promise<Response>;
    timeoutMs?: number;
    pingMs?: number;
}): Promise<Response> {
    const abort = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
        timedOut = true;
        abort.abort();
    }, timeoutMs);
    const onClientAbort = () => abort.abort(signal.reason);
    signal.addEventListener("abort", onClientAbort, { once: true });

    if (signal.aborted) {
        onClientAbort();
    }

    const stopped = new Promise<Response>((resolve) => {
        const finish = () =>
            resolve(jsonError(timedOut ? 504 : 499, timedOut ? "Compaction timed out." : "Client cancelled."));

        if (abort.signal.aborted) {
            finish();
        } else {
            abort.signal.addEventListener("abort", finish, { once: true });
        }
    });
    const pending = abort.signal.aborted ? stopped : Promise.race([run(abort.signal), stopped]);
    const cleanup = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onClientAbort);
    };

    if (!stream) {
        try {
            return await pending;
        } finally {
            cleanup();
        }
    }

    // Keep a real HTTP status when preparation finishes before the first keepalive.
    let firstPing: ReturnType<typeof setTimeout> | undefined;
    let early: Response | undefined;
    try {
        early = await Promise.race([
            pending,
            new Promise<undefined>((resolve) => {
                firstPing = setTimeout(() => resolve(undefined), pingMs);
            }),
        ]);
    } catch (error) {
        cleanup();
        throw error;
    } finally {
        clearTimeout(firstPing);
    }

    if (early) {
        clearTimeout(timer);

        if (!early.body) {
            cleanup();
            return early;
        }

        const source = early.body.getReader();
        const body = new ReadableStream<Uint8Array>({
            async pull(controller) {
                try {
                    const chunk = await source.read();

                    if (chunk.done) {
                        cleanup();
                        controller.close();
                    } else {
                        controller.enqueue(chunk.value);
                    }
                } catch (error) {
                    cleanup();
                    controller.error(error);
                }
            },
            cancel(reason) {
                abort.abort(reason);
                cleanup();
                return source.cancel(reason).catch(() => undefined);
            },
        });
        return new Response(body, { status: early.status, statusText: early.statusText, headers: early.headers });
    }

    const encoder = new TextEncoder();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(encoder.encode(": keepalive\n\n"));
            const ping = setInterval(() => controller.enqueue(encoder.encode(": keepalive\n\n")), pingMs);
            void (async () => {
                try {
                    const response = await pending;
                    clearTimeout(timer);

                    if (!response.ok) {
                        const error = await toAnthropicErrorResponse(response);
                        controller.enqueue(encoder.encode(`event: error\ndata: ${await error.text()}\n\n`));
                    } else if (response.body) {
                        reader = response.body.getReader();

                        while (!cancelled) {
                            const chunk = await reader.read();

                            if (chunk.done) {
                                break;
                            }

                            controller.enqueue(chunk.value);
                        }
                    }
                } catch (error) {
                    if (!cancelled) {
                        const payload = { type: "error", error: { type: "api_error", message: String(error) } };
                        controller.enqueue(encoder.encode(`event: error\ndata: ${SafeJSON.stringify(payload)}\n\n`));
                    }
                } finally {
                    clearInterval(ping);
                    cleanup();

                    if (!cancelled) {
                        controller.close();
                    }
                }
            })();
        },
        cancel(reason) {
            cancelled = true;
            abort.abort(reason);
            cleanup();
            void reader?.cancel(reason).catch(() => undefined);
        },
    });

    return new Response(body, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } });
}

/** A background compaction is a full-context request; past this it is abandoned (a native one took 155 s at 430K). */
export const BACKGROUND_COMPACTION_TIMEOUT_MS = 15 * 60_000;
/** How the usage ledger names a background compaction's request. */
export const BACKGROUND_COMPACTION_PATH = "/v1/messages#background-compaction";

/** A Responses usage object as the token counts a compaction event and Claude Code's usage carry. */
export function usageTokens(usage: Record<string, unknown> | undefined): {
    inputTokens?: number;
    cachedTokens?: number;
    outputTokens?: number;
} {
    const details = isObject(usage?.input_tokens_details) ? usage.input_tokens_details : {};

    return {
        ...(typeof usage?.input_tokens === "number" ? { inputTokens: usage.input_tokens } : {}),
        ...(typeof details.cached_tokens === "number" ? { cachedTokens: details.cached_tokens } : {}),
        ...(typeof usage?.output_tokens === "number" ? { outputTokens: usage.output_tokens } : {}),
    };
}

/** Claude Code's answer to its compaction turn: one text block, as SSE or JSON like the request asked. */
export function compactionReply(input: {
    model: string;
    text: string;
    tokens: { inputTokens?: number; cachedTokens?: number; outputTokens?: number };
    stream: boolean;
}): Response {
    const { inputTokens = 0, cachedTokens = 0, outputTokens = 0 } = input.tokens;
    const reply = {
        id: `msg_${randomUUID().replaceAll("-", "")}`,
        type: "message",
        role: "assistant",
        model: input.model,
        content: [{ type: "text", text: input.text }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: {
            input_tokens: Math.max(0, inputTokens - cachedTokens),
            cache_read_input_tokens: cachedTokens,
            output_tokens: outputTokens,
        },
    };

    return input.stream
        ? new Response(messageToAnthropicSse(reply), { headers: { "Content-Type": "text/event-stream" } })
        : new Response(SafeJSON.stringify(reply), { headers: { "Content-Type": "application/json" } });
}

export const WASTE_REASONS: Record<"login_changed" | "history_changed" | "tail_too_large", string> = {
    login_changed: "another Codex login made it, and this login cannot read it",
    history_changed: "the conversation before it changed (a rewound, edited or replaced turn)",
    tail_too_large: "too much happened after it, so the next turns would have reached the limit again",
};

/**
 * The line the agent reads in its compaction summary when a background run went unused: one more full-context request
 * was spent. The agent tells the user once; the proxy log and `tools ai-proxy monitor` keep the details.
 */
export function backgroundWasteNotice(
    result: Pick<BackgroundResult, "readyAt">,
    reason: keyof typeof WASTE_REASONS,
    durationMs: number
): string {
    const at = new Date(result.readyAt).toTimeString().slice(0, 5);

    return (
        `Proxy notice: the compaction ai-proxy prepared in the background at ${at} could not be used, because ` +
        `${WASTE_REASONS[reason]}. This compaction read the whole context again (${Math.round(durationMs / 1000)} s).`
    );
}

/** Who gets an account failure: the Anthropic route's client (Claude Code) gets the status it acts on. */
export interface FailureClient {
    anthropic: boolean;
    /** The session record the request came from, for the switch command. */
    sessionId?: string;
    /** Filled by `respond`: the login that answered, which signs the reply's reasoning. */
    servedIdentity?: string;
}

/** Where compaction records live: the saved history and the encrypted item per login, by `gtc1.` id. */
export interface CompactionStore {
    load(id: string): CompactionRecord | undefined;
    save(record: CompactionRecord): void;
    newId(): string;
}

/** The records on disk under ai-proxy/compactions/. */
export const fileCompactionStore: CompactionStore = {
    load: loadCompaction,
    save: saveCompaction,
    newId: newCompactionId,
};

export interface CompactionFlowDeps {
    /** One WHAM request with the provider's logins and failover; fills `client.servedIdentity`. */
    upstream: (req: Request, model: string, body: Record<string, unknown>, client?: FailureClient) => Promise<Response>;
    /** The written-summary path, for a native compaction that gave no item. */
    writtenSummary: (
        req: Request,
        model: string,
        bodyText: string,
        context: ProviderRequestContext | undefined
    ) => Promise<Response>;
    store: CompactionStore;
    /** Books a request the proxy made on its own (a background compaction) in the usage ledger. */
    usage: (row: UsageRequestRecord) => void;
    account: string;
    provider: string;
}

/**
 * Claude Code's compaction on a Codex model, end to end: the native compaction of a turn, the background run near the
 * compaction point and the answer from it, and the item behind a marker for the login that serves the next turn. The
 * provider gives it one upstream call and the written-summary fallback; records and usage go through the ports.
 */
export class CodexCompactionFlow {
    constructor(private readonly deps: CompactionFlowDeps) {}

    /**
     * Claude Code's compaction turn, compacted the Codex way: the turn's request plus `compaction_trigger`, at the
     * session's effort, so the cached prefix holds. Claude Code gets a note with a marker; the item and the history it
     * compacted go to disk for the later turns. Any failure writes the text summary instead, as before.
     */
    async compactNatively(input: {
        req: Request;
        model: string;
        bodyText: string;
        context: ProviderRequestContext | undefined;
        parsed: Record<string, unknown>;
        responsesBody: Record<string, unknown>;
        rawInput: unknown[];
        stamp: ReasoningEnvelopeStamp;
        client: FailureClient;
        trace: CompactionTrace;
        startedAt: number;
        /** Why a background result could not answer this turn, for the agent to tell the user. */
        notice?: (durationMs: number) => string;
        threadKey?: string;
    }): Promise<Response> {
        const { req, model, client } = input;
        const sent = Array.isArray(input.responsesBody.input) ? input.responsesBody.input : [];
        const response = await this.deps.upstream(
            req,
            model,
            { ...input.responsesBody, input: [...sent, { type: "compaction_trigger" }], stream: true },
            client
        );
        const { item, usage, summary } = response.ok ? compactionFromSse(await readCompactionText(response)) : {};

        if (!item) {
            input.trace.record("turn", {
                mode: "summary",
                reason: `Codex native compaction gave no compaction item (HTTP ${response.status}); writing the text summary`,
            });
            return this.deps.writtenSummary(req, model, input.bodyText, input.context);
        }

        // Native compaction can return only an encrypted item. Do not issue another model request for a summary.
        if (req.signal.aborted) {
            return toAnthropicErrorResponse(jsonError(499, "Compaction was cancelled."));
        }

        const servedBy = client.servedIdentity;
        const accountHash = servedBy ? accountHash8(servedBy) : input.stamp.accountHash;
        const id = this.deps.store.newId();
        this.deps.store.save({
            id,
            model: input.stamp.model,
            createdAt: new Date().toISOString(),
            items: { [accountHash]: item },
            history: input.rawInput,
        });
        const durationMs = Date.now() - input.startedAt;
        const tokens = usageTokens(usage);
        const notice = input.notice?.(durationMs);

        if (input.threadKey) {
            clearBackground(input.threadKey);

            if (notice) {
                setPendingNotice(
                    input.threadKey,
                    `${notice} Start your next reply with one sentence that tells the user this.`
                );
            }
        }

        input.trace.record("done", { mode: "native", id, durationMs, ...tokens });

        return compactionReply({
            model,
            text: `<summary>\n${compactionNote(id, summary)}${notice ? `\n${notice}` : ""}\n</summary>`,
            tokens,
            stream: input.parsed.stream === true,
        });
    }

    /**
     * A compaction turn answered from the background run of its thread, when that run can stand for it. A run in
     * flight is awaited (the turn's keepalives are already running), like Codex does, instead of a second request.
     */
    async answerFromBackground(input: {
        key: string;
        point: number;
        rawInput: unknown[];
        accountHash: string;
        model: string;
        stream: boolean;
        trace: CompactionTrace;
        startedAt: number;
        settings: BackgroundCompactionSettings;
    }): Promise<{ response?: Response; notice?: (durationMs: number) => string }> {
        await backgroundInFlight(input.key);
        const result = backgroundResult(input.key);

        if (!result) {
            return {};
        }

        clearBackground(input.key);
        const match = matchBackground({
            result,
            rawInput: input.rawInput,
            accountHash: input.accountHash,
            point: input.point,
            tailTokens: estimateTokens,
            settings: input.settings,
        });

        if (!match.use) {
            input.trace.record("background-wasted", {
                reason: match.reason,
                inputTokens: result.inputTokens,
                cachedTokens: result.cachedTokens,
                outputTokens: result.outputTokens,
            });
            return { notice: (durationMs) => backgroundWasteNotice(result, match.reason, durationMs) };
        }

        const id = this.deps.store.newId();
        this.deps.store.save({
            id,
            model: input.trace.model ?? input.model,
            createdAt: new Date().toISOString(),
            items: { [result.accountHash]: result.item },
            history: input.rawInput,
            ...(match.tail.length > 0 ? { tail: { account: result.accountHash, items: match.tail } } : {}),
        });
        const durationMs = Date.now() - input.startedAt;
        const tokens = {
            inputTokens: result.inputTokens,
            cachedTokens: result.cachedTokens,
            outputTokens: result.outputTokens,
        };
        input.trace.record("background-used", { id, durationMs, tailItems: match.tail.length, ...tokens });
        input.trace.record("done", { mode: "background", id, durationMs, ...tokens });

        return {
            response: compactionReply({
                model: input.model,
                text: `<summary>\n${compactionNote(id)}\n</summary>`,
                tokens,
                stream: input.stream,
            }),
        };
    }

    /**
     * Compacts what one turn sent, in the background: the same request plus `compaction_trigger`, at its effort and
     * on its cached prefix, on a request of its own that the client's hang-up does not cancel. Never throws.
     */
    async runBackgroundCompaction(input: {
        req: Request;
        model: string;
        concreteModel: string;
        body: Record<string, unknown>;
        rawInput: unknown[];
        stamp: ReasoningEnvelopeStamp;
        contextTokens: number;
        sessionId?: string;
        trace: CompactionTrace;
    }): Promise<BackgroundResult | undefined> {
        const startedAt = Date.now();
        const abort = new AbortController();
        const timer = setTimeout(() => abort.abort(), BACKGROUND_COMPACTION_TIMEOUT_MS);
        const client: FailureClient = { anthropic: true, ...(input.sessionId ? { sessionId: input.sessionId } : {}) };
        const sent = Array.isArray(input.body.input) ? input.body.input : [];
        input.trace.record("background-start", { inputTokens: input.contextTokens });

        try {
            const request = new Request(input.req.url, {
                method: "POST",
                headers: input.req.headers,
                body: "{}",
                signal: abort.signal,
            });
            const response = await this.deps.upstream(
                request,
                input.model,
                { ...input.body, input: [...sent, { type: "compaction_trigger" }], stream: true },
                client
            );
            const { item, usage } = response.ok ? compactionFromSse(await readCompactionText(response)) : {};
            const tokens = usageTokens(usage);
            this.recordBackgroundUsage({ ...input, status: response.status, startedAt, tokens });

            if (!item) {
                input.trace.record("background-failed", {
                    reason: `no compaction item (HTTP ${response.status})`,
                    durationMs: Date.now() - startedAt,
                    ...tokens,
                });
                return undefined;
            }

            const servedBy = client.servedIdentity;
            const result: BackgroundResult = {
                item,
                accountHash: servedBy ? accountHash8(servedBy) : input.stamp.accountHash,
                prefixLength: input.rawInput.length,
                prefixHash: prefixHash(input.rawInput),
                prefix: input.rawInput,
                contextTokens: input.contextTokens,
                startedAt,
                readyAt: Date.now(),
                ...tokens,
            };
            input.trace.record("background-ready", { durationMs: result.readyAt - startedAt, ...tokens });

            return result;
        } catch (error) {
            input.trace.record("background-failed", {
                reason: error instanceof Error ? error.message : String(error),
                durationMs: Date.now() - startedAt,
            });
            return undefined;
        } finally {
            clearTimeout(timer);
        }
    }

    /** The background request is real spend: it goes into the usage ledger like a client's request. */
    private recordBackgroundUsage(input: {
        model: string;
        concreteModel: string;
        sessionId?: string;
        trace: CompactionTrace;
        status: number;
        startedAt: number;
        tokens: { inputTokens?: number; cachedTokens?: number; outputTokens?: number };
    }): void {
        const { inputTokens = 0, cachedTokens = 0, outputTokens = 0 } = input.tokens;
        const session = input.sessionId ?? input.trace.claudeSession;

        try {
            this.deps.usage({
                ts: new Date().toISOString(),
                account: this.deps.account,
                provider: this.deps.provider,
                proxyModel: input.model,
                upstreamModel: input.concreteModel,
                path: BACKGROUND_COMPACTION_PATH,
                status: input.status,
                elapsedMs: Date.now() - input.startedAt,
                stream: true,
                usage: {
                    prompt_tokens: Math.max(0, inputTokens - cachedTokens),
                    completion_tokens: outputTokens,
                    total_tokens: inputTokens + outputTokens,
                    cache_read_input_tokens: cachedTokens,
                },
                ...(session ? { tags: { session, label: "background-compaction" } } : {}),
                compaction: true,
            });
        } catch (error) {
            logger.warn({ error }, "ai-proxy: could not record the background compaction's usage");
        }
    }

    /**
     * The compaction item behind a marker, for this login. Another login cannot read an item, so the first request it
     * serves after a switch compacts the saved history once more there (one uncached read, which the switch costs
     * anyway) and keeps that item too.
     */
    async compactionItem(input: {
        id: string;
        req: Request;
        model: string;
        template: Record<string, unknown>;
        accountHash: string;
        client: FailureClient;
        ancestors?: ReadonlySet<string>;
    }): Promise<unknown[]> {
        if (input.ancestors?.has(input.id)) {
            throw new CompactionRestoreError(input.id, true, `Compaction history contains a cycle at ${input.id}.`);
        }

        const record = this.deps.store.load(input.id);

        if (!record) {
            throw new CompactionRestoreError(input.id, true, `Compaction record ${input.id} is missing or unreadable.`);
        }

        const held = record.items[input.accountHash];

        if (held) {
            return record.tail?.account === input.accountHash ? [held, ...record.tail.items] : [held];
        }

        const ancestors = new Set(input.ancestors);
        ancestors.add(input.id);
        const history = await expandCompactionMarkers(record.history, (id) =>
            this.compactionItem({ ...input, id, ancestors })
        );
        const cleanHistory = history.filter((item) => !isObject(item) || item.type !== "reasoning");
        const response = await this.deps.upstream(
            input.req,
            input.model,
            { ...input.template, input: [...cleanHistory, { type: "compaction_trigger" }], stream: true },
            input.client
        );
        if (!response.ok) {
            throw new CompactionRestoreError(
                input.id,
                false,
                `Could not restore compaction ${input.id}.`,
                input.id,
                response
            );
        }

        let item: Record<string, unknown> | undefined;
        try {
            item = response.ok ? compactionFromSse(await readCompactionText(response)).item : undefined;
        } catch (error) {
            logger.warn({ error, id: input.id }, "ai-proxy: could not read the recompaction stream");
            throw new CompactionRestoreError(input.id, false, `Could not read compaction ${input.id} for this login.`);
        }

        if (!item) {
            logger.warn({ id: input.id, status: response.status }, "ai-proxy: recompacting saved history failed");
            throw new CompactionRestoreError(
                input.id,
                false,
                `Could not restore compaction ${input.id} for this login.`
            );
        }

        if (input.req.signal.aborted) {
            throw new CompactionRestoreError(input.id, false, `Compaction ${input.id} was cancelled.`);
        }

        this.deps.store.save({ ...record, items: { ...record.items, [input.accountHash]: item } });
        recordCompactionEvent({ kind: "recompacted", id: input.id, model: input.model, reason: "another Codex login" });

        return [item];
    }
}
