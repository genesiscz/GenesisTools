import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";

type McpFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

let fetchImpl: McpFetch = globalThis.fetch;

export function mcpFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    return fetchImpl(input, init);
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
