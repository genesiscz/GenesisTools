import { randomUUID } from "node:crypto";
import { SafeJSON } from "@genesiscz/utils/json";

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
        return passthrough;
    }

    let parsed: unknown;
    try {
        parsed = SafeJSON.parse(rawBody, { strict: true });
    } catch {
        return passthrough;
    }

    if (!isObject(parsed)) {
        return passthrough;
    }

    const body: Record<string, unknown> = { ...parsed, stream: true, store: false };

    for (const key of WHAM_UNSUPPORTED) {
        delete body[key];
    }

    const include = Array.isArray(body.include) ? body.include.filter((v) => typeof v === "string") : [];
    body.include = include.includes("reasoning.encrypted_content")
        ? include
        : [...include, "reasoning.encrypted_content"];

    return { ...passthrough, body: SafeJSON.stringify(body, { strict: true }) };
}
