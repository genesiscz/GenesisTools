import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";

type McpFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

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
    return fetchImpl(input, { redirect: "manual", ...init });
}

export async function readJsonRecord(response: Response): Promise<{
    json?: Record<string, unknown>;
    text: string;
}> {
    const text = await response.text();

    try {
        const parsed = SafeJSON.parse(text, { strict: true });

        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            return { json: parsed as Record<string, unknown>, text };
        }
    } catch (error) {
        logger.debug({ error, status: response.status, snippet: text.slice(0, 200) }, "mcp auth response was not JSON");
    }

    return { text };
}

export function _setMcpFetchForTest(fn: McpFetch): void {
    fetchImpl = fn;
}

export function _resetMcpFetchForTest(): void {
    fetchImpl = globalThis.fetch;
}
