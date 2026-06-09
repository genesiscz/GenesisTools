export const TV_ORIGIN = "https://www.tradingview.com";
export const TV_USER_AGENT =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";

// Bun's native WebSocket accepts a non-standard `headers` option on the second
// argument, which the `ws` npm package's bun shim silently drops — without an
// Origin + User-Agent header TradingView rejects the handshake with HTTP non-101
// (close code 1002). Use the native WebSocket directly so the headers land.
interface BunWebSocketInit {
    headers?: Record<string, string>;
}

type BunWebSocketCtor = new (url: string, options?: BunWebSocketInit) => WebSocket;

export function tvSocket(url: string, extraHeaders: Record<string, string> = {}): WebSocket {
    const Ctor = WebSocket as unknown as BunWebSocketCtor;
    return new Ctor(url, {
        headers: { Origin: TV_ORIGIN, "User-Agent": TV_USER_AGENT, ...extraHeaders },
    });
}
