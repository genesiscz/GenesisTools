import { randomUUID } from "node:crypto";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { awaitWhamOperation, collectWhamResponse, isWhamEventStream } from "./wham-response";

/**
 * Parameters the ChatGPT backend ("WHAM") answers with 400 "Unsupported parameter"
 * (probed live 2026-07-19, Plus plan). `store` must be false and `stream` true.
 */
const WHAM_UNSUPPORTED = ["max_output_tokens", "temperature", "top_p", "previous_response_id"] as const;

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Turn a plain Responses request (what `@ai-sdk/openai` emits) into one WHAM accepts.
 * The ai-proxy carries the full rewrite for arbitrary clients (`buildWhamResponsesBody`);
 * this is the subset a first-party caller needs, applied inside the provider's fetch so
 * every `ai.chat` on a codex subscription goes out well-formed.
 *
 * A `Request` input carries its own headers and body; `init` overrides them field by
 * field, the way `fetch` itself reads the pair. The SDK sends a URL string plus `init`,
 * but a caller that hands over a built `Request` must not lose its Content-Type and
 * body on the way (PR #383 review).
 */
export async function toWhamRequest(input: RequestInfo | URL, init?: RequestInit): Promise<RequestInit> {
    return (await prepareWhamRequest({ input, init })).init;
}

/** Read a Request body under the caller's budget, so a stalled upload cannot outlive it. */
async function readRequestText({
    request,
    signal,
    onProgress,
}: {
    request: Request;
    signal?: AbortSignal;
    onProgress?: () => void;
}): Promise<string> {
    if (!signal) {
        return request.clone().text();
    }

    const body = request.clone().body;

    if (!body) {
        return "";
    }

    const reader = body.getReader();
    const decoder = new TextDecoder();
    let text = "";

    try {
        while (true) {
            const next = await awaitWhamOperation({ operation: reader.read(), signal });

            if (next.done) {
                return text + decoder.decode();
            }

            onProgress?.();
            text += decoder.decode(next.value, { stream: true });
        }
    } finally {
        void reader.cancel().catch(() => logger.debug("Subscription request body reader cancellation failed"));
        reader.releaseLock();
    }
}

async function prepareWhamRequest({
    input,
    init,
    signal,
    onProgress,
}: {
    input: RequestInfo | URL;
    init?: RequestInit;
    signal?: AbortSignal;
    onProgress?: () => void;
}): Promise<{ init: RequestInit; collect: boolean }> {
    const request = input instanceof Request ? input : null;
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers = new Headers(init?.headers ?? request?.headers);
    headers.set("OpenAI-Beta", "responses=experimental");
    headers.set("originator", "codex_cli_rs");
    headers.set("session_id", randomUUID());
    headers.set("Accept", "text/event-stream");
    const rawBody =
        init?.body === undefined && request?.body ? await readRequestText({ request, signal, onProgress }) : init?.body;
    const passthrough: RequestInit = { ...init, headers, ...(rawBody === undefined ? {} : { body: rawBody }) };

    if (!url.endsWith("/responses") || typeof rawBody !== "string") {
        return { init: passthrough, collect: false };
    }

    let parsed: unknown;
    try {
        parsed = SafeJSON.parse(rawBody, { strict: true });
    } catch {
        logger.debug("Subscription request body is not JSON; retaining its response mode");
        return { init: passthrough, collect: false };
    }

    if (!isObject(parsed)) {
        return { init: passthrough, collect: false };
    }

    const body: Record<string, unknown> = { ...parsed, stream: true, store: false };

    for (const key of WHAM_UNSUPPORTED) {
        delete body[key];
    }

    const include = Array.isArray(body.include) ? body.include.filter((v) => typeof v === "string") : [];
    body.include = include.includes("reasoning.encrypted_content")
        ? include
        : [...include, "reasoning.encrypted_content"];

    return {
        init: { ...passthrough, body: SafeJSON.stringify(body, { strict: true }) },
        collect: parsed.stream !== true,
    };
}

/**
 * Preserve the SDK's original response mode even though WHAM requires streaming on the wire.
 * `timeoutMs` is an idle deadline: every received chunk restarts it, so a long generation that
 * keeps streaming is never cut off, while a stalled body, fetch or stream still ends (PR #470 review).
 */
export async function fetchWhamResponse({
    input,
    init,
    fetch: fetchImpl = fetch,
    timeoutMs = 120_000,
}: {
    input: RequestInfo | URL;
    init?: RequestInit;
    fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
    timeoutMs?: number;
}): Promise<Response> {
    const callerSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    callerSignal?.throwIfAborted();

    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        throw new RangeError("Subscription response timeout must be positive and finite");
    }

    const deadline = new AbortController();
    const signal = callerSignal ? AbortSignal.any([callerSignal, deadline.signal]) : deadline.signal;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const touch = () => {
        clearTimeout(timer);
        timer = setTimeout(
            () => deadline.abort(new DOMException("Subscription response idle deadline exceeded", "TimeoutError")),
            timeoutMs
        );
    };
    touch();

    try {
        const prepared = await prepareWhamRequest({ input, init, signal, onProgress: touch });
        signal.throwIfAborted();

        if (!prepared.collect) {
            return fetchImpl(input, prepared.init);
        }

        const pendingResponse = fetchImpl(input, { ...prepared.init, signal });
        // A custom fetch may ignore abort and resolve later. Do not leave its body open.
        void pendingResponse.then(
            (response) => {
                if (signal.aborted) {
                    void response.body
                        ?.cancel()
                        .catch(() => logger.debug("Late subscription response cancellation failed"));
                }
            },
            () => logger.debug("Subscription fetch failed; propagating to caller")
        );
        const response = await awaitWhamOperation({ operation: pendingResponse, signal });
        logger.debug(
            {
                status: response.status,
                eventStream: response.headers.get("content-type")?.startsWith("text/event-stream") === true,
            },
            "Subscription response for non-streaming caller"
        );

        if (!response.ok || !(await isWhamEventStream({ response, signal, onProgress: touch }))) {
            return response;
        }

        return await collectWhamResponse({ response, signal, onProgress: touch });
    } finally {
        clearTimeout(timer);
    }
}
