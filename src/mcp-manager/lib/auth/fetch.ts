type McpFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

let fetchImpl: McpFetch = globalThis.fetch;

export function mcpFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    return fetchImpl(input, init);
}

export function _setMcpFetchForTest(fn: McpFetch): void {
    fetchImpl = fn;
}

export function _resetMcpFetchForTest(): void {
    fetchImpl = globalThis.fetch;
}
