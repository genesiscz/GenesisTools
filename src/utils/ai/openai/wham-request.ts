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

async function prepareWhamRequest({
    input,
    init,
}: {
    input: RequestInfo | URL;
    init?: RequestInit;
}): Promise<{ init: RequestInit; collect: boolean }> {
    const request = input instanceof Request ? input : null;
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers = new Headers(init?.headers ?? request?.headers);
    headers.set("OpenAI-Beta", "responses=experimental");
    headers.set("originator", "codex_cli_rs");
    headers.set("session_id", randomUUID());
    headers.set("Accept", "text/event-stream");
    const rawBody = init?.body === undefined && request?.body ? await request.clone().text() : init?.body;
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

/** Preserve the SDK's original response mode even though WHAM requires streaming on the wire. */
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
    const prepared = await prepareWhamRequest({ input, init });
    callerSignal?.throwIfAborted();

    if (!prepared.collect) {
        return fetchImpl(input, prepared.init);
    }

    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        throw new RangeError("Subscription response timeout must be positive and finite");
    }

    const deadline = new AbortController();
    const signal = callerSignal ? AbortSignal.any([callerSignal, deadline.signal]) : deadline.signal;
    const timer = setTimeout(
        () => deadline.abort(new DOMException("Subscription response deadline exceeded", "TimeoutError")),
        timeoutMs
    );

    try {
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

        if (!response.ok || !(await isWhamEventStream({ response, signal }))) {
            return response;
        }

        return await collectWhamResponse({ response, signal });
    } finally {
        clearTimeout(timer);
    }
}
