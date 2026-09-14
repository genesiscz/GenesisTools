import { createDashboardClient, type DashboardClient, type EventSourceLike } from "@dd/contract";
import { fetch as expoFetch } from "expo/fetch";
import { createQaStream } from "@/transport/qa-stream";
import { streamSse, type SseHandle } from "@/transport/sse-parser";
import { createTerminalTransport, type TerminalTransportOptions } from "@/transport/terminal-ws";
import type { QaStream, TerminalTransport, Transport, TransportTier } from "@/transport/Transport";

export interface PlainTransportOptions {
    tier: TransportTier;
    /** Resolved per tier (LAN ip / tailnet host / tunnel url). No trailing slash. */
    baseUrl: string;
    authHeader: () => string | undefined;
    /** Tier-specific liveness probe (mDNS hit / tailnet GET / tunnel GET). */
    probe: () => Promise<boolean>;
    /** Test seam for the WS transport. */
    terminalFactory?: (opts: TerminalTransportOptions) => TerminalTransport;
}

/** http(s)://host -> ws(s)://host/ttyd/<id>/ws (mirrors the web ttyd path). */
function ttydWsUrl(baseUrl: string, sessionId: string): string {
    const wsBase = baseUrl.replace(/^http/, "ws");
    return `${wsBase}/ttyd/${sessionId}/ws`;
}

export function createPlainTransport(opts: PlainTransportOptions): Transport {
    const makeTerminal = opts.terminalFactory ?? createTerminalTransport;

    function client(): DashboardClient {
        return createDashboardClient({
            baseUrl: opts.baseUrl,
            fetch: ((url: string, init?: RequestInit) => expoFetch(url, init as never)) as unknown as typeof fetch,
            authHeader: opts.authHeader,
            // The contract's `qa.subscribe` wants an EventSource-like; we supply an expo/fetch
            // SSE adapter so `c.qa.subscribe(...)` works on RN too (web/mobile call-site parity,
            // ADR §3). The contract passes the FULL URL here, so we stream it directly (no path
            // re-append). The clean path for the QA screen is `transport.streamQa()` (plan 07).
            eventSourceFactory: (url: string): EventSourceLike => {
                let onmessage: ((ev: { data: string }) => void) | null = null;
                let onerror: ((ev: unknown) => void) | null = null;
                const auth = opts.authHeader();
                const handle: SseHandle = streamSse({
                    url,
                    headers: auth ? { Authorization: auth } : undefined,
                    onEvent: (event) => onmessage?.({ data: event.data }),
                    onError: (err) => onerror?.(err),
                });

                return {
                    close: () => handle.close(),
                    get onmessage() {
                        return onmessage;
                    },
                    set onmessage(handler) {
                        onmessage = handler;
                    },
                    get onerror() {
                        return onerror;
                    },
                    set onerror(handler) {
                        onerror = handler;
                    },
                };
            },
        });
    }

    return {
        tier: opts.tier,
        baseUrl: () => opts.baseUrl,
        authHeader: opts.authHeader,
        reachable: () => opts.probe(),
        client,
        streamQa(): QaStream {
            return createQaStream({ baseUrl: opts.baseUrl, authHeader: opts.authHeader });
        },
        openTerminal(sessionId: string): TerminalTransport {
            return makeTerminal({ wsUrl: ttydWsUrl(opts.baseUrl, sessionId), protocols: ["tty"] });
        },
    };
}
