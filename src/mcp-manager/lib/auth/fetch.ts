import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";

type McpFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export const MAX_AUTH_RESPONSE_BYTES = 256 * 1024;
export const MCP_CREDENTIAL_TIMEOUT_MS = 15_000;

let fetchImpl: McpFetch = globalThis.fetch;

/**
 * Every credential-bearing request in this module goes through here: the refresh POST
 * (grant_type=refresh_token), the token-endpoint exchange and dynamic client
 * registration. `fetch` defaults to `redirect: "follow"`, and a 307 or 308 PRESERVES
 * the method and the body — so a token endpoint answering with a redirect would have
 * forwarded the refresh token to whatever host it named.
 *
 * Default to `manual` at the chokepoint rather than at each caller, so a future POST
 * added here is safe by construction. A 3xx then arrives as a non-ok response and the
 * callers already fail on that. Discovery opts back into `follow` explicitly, because
 * it carries no credential and a well-known document may legitimately redirect.
 *
 * The gateway proxy path already gets this right (server.ts: `redirect: "manual"` plus
 * an explicit same-origin check); this side did not.
 */
export function mcpFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const deadline = AbortSignal.timeout(MCP_CREDENTIAL_TIMEOUT_MS);
    const signal = init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline;

    return fetchImpl(input, { redirect: "manual", ...init, signal });
}

async function readBoundedText(response: Response): Promise<string> {
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_AUTH_RESPONSE_BYTES) {
        throw new Error(
            `Response Content-Length ${declared} exceeds the ${MAX_AUTH_RESPONSE_BYTES}-byte MCP auth response limit.`
        );
    }

    if (!response.body) {
        return "";
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;

    while (true) {
        const { done, value } = await reader.read();
        if (done) {
            break;
        }

        bytes += value.byteLength;
        if (bytes > MAX_AUTH_RESPONSE_BYTES) {
            await reader.cancel();
            throw new Error(`Response exceeds the ${MAX_AUTH_RESPONSE_BYTES}-byte MCP auth response limit.`);
        }

        chunks.push(value);
    }

    return Buffer.concat(chunks, bytes).toString("utf8");
}

export async function readJsonRecord(response: Response): Promise<{
    json?: Record<string, unknown>;
    text: string;
}> {
    const text = await readBoundedText(response);

    try {
        const parsed = SafeJSON.parse(text, { strict: true });

        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            return { json: parsed as Record<string, unknown>, text };
        }
    } catch (error) {
        // No snippet. This path runs on the token endpoint's response, so the body may
        // hold a credential, and logger.debug writes to the day-stamped file every run.
        logger.debug(
            { error, status: response.status, bytes: text.length, contentType: response.headers.get("content-type") },
            "mcp auth response was not JSON"
        );
    }

    return { text };
}

export function _setMcpFetchForTest(fn: McpFetch): void {
    fetchImpl = fn;
}

export function _resetMcpFetchForTest(): void {
    fetchImpl = globalThis.fetch;
}
