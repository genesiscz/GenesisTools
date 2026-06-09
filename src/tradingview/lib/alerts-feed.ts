import { EventEmitter } from "node:events";
import { logger } from "@app/logger";
import { SafeJSON } from "@app/utils/json";
import { openTvWebSocket } from "./tv-websocket";
import type { Alert, AlertFire, TvSession } from "./types";

const FEED_URL = "wss://pushstream.tradingview.com/message-pipe-ws/private_feed";

interface PushFrame {
    id: number;
    text?: { content?: { m?: string; p?: unknown }; channel?: string };
}

export class AlertsFeed extends EventEmitter {
    private ws: WebSocket | null = null;

    constructor(private readonly session: TvSession) {
        super();
    }

    connect(): void {
        logger.debug("tradingview: opening alerts private_feed");
        this.ws = openTvWebSocket(FEED_URL, { cookie: this.session.cookie });
        this.ws.addEventListener("open", () => this.emit("open"));
        this.ws.addEventListener("message", (event) => this.onMessage(String(event.data)));
        this.ws.addEventListener("error", (event: Event) => {
            const wsEvent = event as ErrorEvent;
            const err =
                wsEvent.error instanceof Error ? wsEvent.error : new Error(wsEvent.message || "WebSocket error");
            this.emit("error", err);
        });
        this.ws.addEventListener("close", () => this.emit("close"));
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
