const TV_ORIGIN = "https://www.tradingview.com";

interface TvWebSocketOpts {
    cookie?: string;
}

export function openTvWebSocket(url: string, opts: TvWebSocketOpts = {}): WebSocket {
    const headers: Record<string, string> = { Origin: TV_ORIGIN };
    if (opts.cookie) {
        headers.cookie = opts.cookie;
    }
    return new WebSocket(url, { headers } as never);
}

export function isWebSocketOpen(ws: WebSocket | null): boolean {
    return ws !== null && ws.readyState === WebSocket.OPEN;
}
