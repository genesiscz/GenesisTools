import { EventEmitter } from "node:events";
import { logger } from "@app/logger";
import { SafeJSON } from "@app/utils/json";
import { encodeFrame, genSessionId, isHeartbeat, parseFrames } from "./protocol";
import type { QuoteSnapshot, QuoteValue } from "./types";
import { tvSocket } from "./ws";

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

export interface QuoteClient {
    on(event: "quote", listener: (snap: QuoteSnapshot) => void): this;
    on(event: "symbolError", listener: (info: { symbol: string; errmsg: string }) => void): this;
    on(event: "open", listener: () => void): this;
    on(event: "error", listener: (err: Error) => void): this;
    on(event: "close", listener: () => void): this;
}

// biome-ignore lint/suspicious/noUnsafeDeclarationMerging: typed EventEmitter events
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
        this.ws = tvSocket(url);
        this.ws.addEventListener("open", () => this.onOpen());
        this.ws.addEventListener("message", (e) => this.onMessage(String(e.data)));
        this.ws.addEventListener("error", () => this.emit("error", new Error("quote socket error")));
        this.ws.addEventListener("close", () => this.emit("close"));
    }

    addSymbols(symbols: string[]): void {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
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
        const payload = msg.p[1] as { n?: string; s?: string; errmsg?: string; v?: QuoteValue } | undefined;
        if (!payload?.n) {
            return;
        }
        if (payload.s === "error") {
            this.emit("symbolError", { symbol: payload.n, errmsg: payload.errmsg ?? "unknown error" });
            return;
        }
        if (payload.s !== "ok" || !payload.v) {
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
