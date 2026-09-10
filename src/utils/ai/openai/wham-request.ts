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
 */
export function toWhamRequest(input: RequestInfo | URL, init?: RequestInit): RequestInit {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers = new Headers(init?.headers);
    headers.set("OpenAI-Beta", "responses=experimental");
    headers.set("originator", "codex_cli_rs");
    headers.set("session_id", randomUUID());
    headers.set("Accept", "text/event-stream");

    if (!url.endsWith("/responses") || typeof init?.body !== "string") {
        return { ...init, headers };
    }

    let parsed: unknown;
    try {
        parsed = SafeJSON.parse(init.body, { strict: true });
    } catch {
        return { ...init, headers };
    }

    if (!isObject(parsed)) {
        return { ...init, headers };
    }

    const body: Record<string, unknown> = { ...parsed, stream: true, store: false };

    for (const key of WHAM_UNSUPPORTED) {
        delete body[key];
    }

    const include = Array.isArray(body.include) ? body.include.filter((v) => typeof v === "string") : [];
    body.include = include.includes("reasoning.encrypted_content")
        ? include
        : [...include, "reasoning.encrypted_content"];

    return { ...init, headers, body: SafeJSON.stringify(body, { strict: true }) };
}
