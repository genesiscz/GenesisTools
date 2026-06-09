import { EventEmitter } from "node:events";
import { logger } from "@app/logger";
import { SafeJSON } from "@app/utils/json";
import { encodeFrame, genSessionId, isHeartbeat, parseFrames } from "./protocol";
import { isWebSocketOpen, openTvWebSocket } from "./tv-websocket";
import type { QuoteSnapshot, QuoteValue } from "./types";

const DEFAULT_FIELDS = [
    "lp",
    "ch",
    "chp",
    "volume",
    "short_name",
    "description",
    "pro_name",
    "currency_code",
    "lp_time",
    "exchange",
    "type",
];

interface QuoteClientOpts {
    authToken?: string;
    host?: string;
    fields?: string[];
}

export class QuoteClient extends EventEmitter {
    private ws: WebSocket | null = null;
    private readonly sessionId = genSessionId("qs_");
    private readonly cache = new Map<string, QuoteValue>();
    private readonly fields: string[];
    private readonly authToken: string;
    private readonly host: string;
    private pending: string[] = [];

    constructor(opts: QuoteClientOpts = {}) {
        super();
        this.authToken = opts.authToken ?? "unauthorized_user_token";
        this.host = opts.host ?? "data.tradingview.com";
        this.fields = opts.fields ?? DEFAULT_FIELDS;
    }

    connect(): void {
        const url = `wss://${this.host}/socket.io/websocket?type=chart`;
        logger.debug({ url, host: this.host }, "tradingview: opening quote socket");
        this.ws = openTvWebSocket(url);
        this.ws.addEventListener("open", () => this.onOpen());
        this.ws.addEventListener("message", (event) => this.onMessage(String(event.data)));
        this.ws.addEventListener("error", (event: Event) => {
            const wsEvent = event as ErrorEvent;
            const err =
                wsEvent.error instanceof Error ? wsEvent.error : new Error(wsEvent.message || "WebSocket error");
            this.emit("error", err);
        });
        this.ws.addEventListener("close", () => this.emit("close"));
    }

    addSymbols(symbols: string[]): void {
        if (!isWebSocketOpen(this.ws)) {
            this.pending.push(...symbols);
            return;
        }
        for (const sym of symbols) {
            this.send({ m: "quote_add_symbols", p: [this.sessionId, sym] });
        }
    }

    close(): void {
        this.ws?.close();
    }

    private onOpen(): void {
        this.send({ m: "set_auth_token", p: [this.authToken] });
        this.send({ m: "quote_create_session", p: [this.sessionId] });
        this.send({ m: "quote_set_fields", p: [this.sessionId, ...this.fields] });
        this.emit("open");
        if (this.pending.length > 0) {
            const queued = this.pending;
            this.pending = [];
            this.addSymbols(queued);
        }
    }

    private onMessage(raw: string): void {
        for (const frame of parseFrames(raw)) {
            if (isHeartbeat(frame)) {
                this.ws?.send(encodeFrame(frame));
                continue;
            }
            this.handleJson(frame);
        }
    }

    private handleJson(frame: string): void {
        let msg: { m?: string; p?: unknown[] };
        try {
            msg = SafeJSON.parse(frame);
        } catch {
            return;
        }
        if (msg.m !== "qsd" || !Array.isArray(msg.p)) {
            return;
        }
        const payload = msg.p[1] as { n?: string; s?: string; v?: QuoteValue } | undefined;
        if (!payload?.n || payload.s !== "ok" || !payload.v) {
            return;
        }
        const merged = { ...(this.cache.get(payload.n) ?? {}), ...payload.v };
        this.cache.set(payload.n, merged);
        this.emit("quote", { symbol: payload.n, value: merged, updatedAt: Date.now() } satisfies QuoteSnapshot);
    }

    private send(obj: object): void {
        this.ws?.send(encodeFrame(obj));
    }
}
