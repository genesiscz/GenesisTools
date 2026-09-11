import type { DashboardClient, QaRow } from "@dd/contract";

export type TransportTier = "lan" | "tailscale" | "cloudflared-self" | "managed";

/** A cancellable subscription (ADR §4 `streamQa` return). */
export interface Disposable {
    dispose(): void;
}

export type QaStreamStatus = "connecting" | "open" | "closed" | "error";

/** SSE Q&A stream (ADR §4). The contract's `eventSourceFactory` plugs this in. */
export interface QaStream {
    /** Begin streaming. `onRow` for each enriched entry; `onStatus` for connection state. */
    connect(onRow: (entry: QaRow) => void, onStatus: (status: QaStreamStatus) => void): void;
    /** Tear down (AppState background, screen unmount). */
    close(): void;
}

export type TerminalStatus = "connecting" | "open" | "reconnecting" | "closed";

/** ttyd WebSocket transport (ADR §4 `openTerminal`). xterm/WebView driver (plan 06) drives this. */
export interface TerminalTransport {
    /** Send raw bytes (keystrokes) to ttyd. */
    send(data: string | ArrayBufferLike): void;
    /** ttyd output frames. */
    onMessage(handler: (data: string | ArrayBuffer) => void): void;
    /** Connection lifecycle for the renderer's status pill. */
    onStatus(handler: (status: TerminalStatus) => void): void;
    /** Close the socket (does NOT kill the server-side tmux/cmux session). */
    close(): void;
    readonly status: TerminalStatus;
}

/**
 * The single transport contract (ADR §4). Tier selection swaps which impl is constructed;
 * a failed SSE/WS pick is replaced without touching feature code.
 */
export interface Transport {
    readonly tier: TransportTier;
    /** LAN ip / tailnet host / tunnel url / relay url. No trailing slash. */
    baseUrl(): string;
    /** "Basic …" from SecureStore, or undefined (cookie/loopback tiers). */
    authHeader(): string | undefined;
    /** Tier-specific liveness probe (mDNS hit / tailnet GET / tunnel GET / relay handshake). */
    reachable(): Promise<boolean>;
    /** A `@dd/contract` client already wired to this tier's fetch + auth + SSE factory. */
    client(): DashboardClient;
    /** SSE Q&A stream under the hood (expo/fetch on plain tiers; E2E-wrapped on managed). */
    streamQa(): QaStream;
    /** partysocket-wrapped ttyd WS (+ cookie/token; E2E-wrapped on managed). */
    openTerminal(sessionId: string): TerminalTransport;
}
