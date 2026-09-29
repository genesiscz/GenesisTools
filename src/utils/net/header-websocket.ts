/**
 * Bun's `WebSocket` constructor takes `{ headers }`, which a browser's does not. This project's
 * tsconfig loads the DOM lib, and bun-types defers to DOM's constructor when DOM is present, so the
 * headers form does not type-check as written. This names Bun's signature once, so the options
 * object is still checked at every call instead of being cast away.
 */
type HeaderWebSocketConstructor = new (url: string, options: { headers: Record<string, string> }) => WebSocket;

/** Open a WebSocket that sends `headers` with its upgrade request (Bun runtime only). */
export function openHeaderWebSocket(url: string, headers: Record<string, string>): WebSocket {
    const BunWebSocket = WebSocket as unknown as HeaderWebSocketConstructor;
    return new BunWebSocket(url, { headers });
}
