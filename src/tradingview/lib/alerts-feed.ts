import { EventEmitter } from "node:events";
import { logger } from "@app/logger";
import { SafeJSON } from "@app/utils/json";
import WebSocket from "ws";
import type { Alert, AlertFire, TvSession } from "./types";

const FEED_URL = "wss://pushstream.tradingview.com/message-pipe-ws/private_feed";
const TV_ORIGIN = "https://www.tradingview.com";

export interface AlertsFeed {
    on(event: "fired", listener: (fire: AlertFire) => void): this;
    on(event: "created", listener: (alerts: Alert[]) => void): this;
    on(event: "updated", listener: (alerts: Alert[]) => void): this;
    on(event: "open", listener: () => void): this;
    on(event: "error", listener: (err: Error) => void): this;
    on(event: "close", listener: () => void): this;
}

interface PushFrame {
    id: number;
    text?: { content?: { m?: string; p?: unknown }; channel?: string };
}

// biome-ignore lint/suspicious/noUnsafeDeclarationMerging: typed EventEmitter events
export class AlertsFeed extends EventEmitter {
    private ws: WebSocket | null = null;

    constructor(private readonly session: TvSession) {
        super();
    }

    connect(): void {
        logger.debug("tradingview: opening alerts private_feed");
        this.ws = new WebSocket(FEED_URL, {
            origin: TV_ORIGIN,
            headers: { Origin: TV_ORIGIN, cookie: this.session.cookie },
        });
        this.ws.on("open", () => this.emit("open"));
        this.ws.on("message", (data: WebSocket.RawData) => this.onMessage(String(data)));
        this.ws.on("error", (err) => this.emit("error", err));
        this.ws.on("close", () => this.emit("close"));
    }

    close(): void {
        this.ws?.close();
    }

    private onMessage(raw: string): void {
        let frame: PushFrame;
        try {
            frame = SafeJSON.parse(raw);
        } catch {
            return;
        }
        const content = frame.text?.content;
        if (frame.text?.channel !== "pricealerts" || !content?.m) {
            return;
        }
        switch (content.m) {
            case "alert_fired":
                this.emit("fired", content.p as AlertFire);
                break;
            case "alerts_created":
                this.emit("created", content.p as Alert[]);
                break;
            case "alerts_updated":
                this.emit("updated", content.p as Alert[]);
                break;
            default:
                logger.debug({ m: content.m }, "tradingview: unhandled alerts event");
        }
    }
}
