import { WebSocket as ReconnectingWebSocket } from "partysocket";
import { AppState, type AppStateStatus } from "react-native";
import type { TerminalStatus, TerminalTransport } from "@/transport/Transport";

const HEARTBEAT_INTERVAL_MS = 25_000;
const MAX_MISSED_PONGS = 2;

export interface HeartbeatState {
    pendingPings: number;
    dead: boolean;
}

export type HeartbeatAction = { type: "ping-sent" } | { type: "pong" } | { type: "reset" };

/** Pure: a ping with >= MAX_MISSED_PONGS outstanding means the link is dead. */
export function heartbeatReducer(state: HeartbeatState, action: HeartbeatAction): HeartbeatState {
    if (action.type === "pong" || action.type === "reset") {
        return { pendingPings: 0, dead: false };
    }

    const pendingPings = state.pendingPings + 1;

    return { pendingPings, dead: pendingPings >= MAX_MISSED_PONGS };
}

export interface TerminalTransportOptions {
    /** ws:// or wss:// URL to the ttyd session (already tier-resolved). */
    wsUrl: string;
    /** ttyd uses the "tty" subprotocol; auth cookie/token is planted by the renderer (plan 06). */
    protocols?: string[];
    /** Test seam: construct a fake socket. Defaults to partysocket's ReconnectingWebSocket. */
    socketFactory?: (url: string, protocols?: string[]) => ReconnectingWebSocket;
}

export function createTerminalTransport(opts: TerminalTransportOptions): TerminalTransport {
    const make = opts.socketFactory ?? ((url, protocols) => new ReconnectingWebSocket(url, protocols));
    let status: TerminalStatus = "connecting";
    let heartbeat: HeartbeatState = { pendingPings: 0, dead: false };
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    /** True while a close was asked for, so the socket's own close event is not read as a drop. */
    let closedByApp = false;
    const messageHandlers: ((d: string | ArrayBuffer) => void)[] = [];
    const statusHandlers: ((s: TerminalStatus) => void)[] = [];

    const socket = make(opts.wsUrl, opts.protocols ?? ["tty"]);
    socket.binaryType = "arraybuffer";

    function setStatus(next: TerminalStatus): void {
        status = next;
        for (const h of statusHandlers) {
            h(next);
        }
    }

    function stopHeartbeat(): void {
        if (heartbeatTimer) {
            clearInterval(heartbeatTimer);
            heartbeatTimer = null;
        }
    }

    function startHeartbeat(): void {
        stopHeartbeat();
        heartbeatTimer = setInterval(() => {
            heartbeat = heartbeatReducer(heartbeat, { type: "ping-sent" });

            if (heartbeat.dead) {
                socket.reconnect();
                heartbeat = heartbeatReducer(heartbeat, { type: "reset" });
                return;
            }

            try {
                socket.send(" ping");
            } catch (err) {
                // socket closed between the check and the send; the reconnect loop handles it.
                void err;
            }
        }, HEARTBEAT_INTERVAL_MS);
    }

    function onOpen(): void {
        closedByApp = false;
        heartbeat = heartbeatReducer(heartbeat, { type: "reset" });
        setStatus("open");
        startHeartbeat();
    }

    function onMessage(ev: MessageEvent): void {
        if (typeof ev.data === "string" && ev.data === " pong") {
            heartbeat = heartbeatReducer(heartbeat, { type: "pong" });
            return;
        }

        for (const h of messageHandlers) {
            h(ev.data as string | ArrayBuffer);
        }
    }

    /**
     * The socket's own close event arrives AFTER we asked for the close, so reporting
     * "reconnecting" here would overwrite the "closed" that backgrounding just set — and the
     * foreground branch below only reconnects from "closed", so the terminal would never come back.
     */
    function onDisconnect(): void {
        if (closedByApp) {
            return;
        }

        setStatus("reconnecting");
    }

    socket.addEventListener("open", onOpen);
    socket.addEventListener("message", onMessage);
    socket.addEventListener("close", onDisconnect);
    socket.addEventListener("error", onDisconnect);

    const appStateSub = AppState.addEventListener("change", (next: AppStateStatus) => {
        if (next === "background" || next === "inactive") {
            stopHeartbeat();
            closedByApp = true;
            socket.close();
            setStatus("closed");
            return;
        }

        if (next === "active" && status === "closed") {
            closedByApp = false;
            socket.reconnect();
            setStatus("connecting");
        }
    });

    return {
        get status() {
            return status;
        },
        send(data) {
            // partysocket's `Message` excludes SharedArrayBuffer; terminal frames are always a
            // string or a plain ArrayBuffer, so narrow ArrayBufferLike to ArrayBuffer.
            socket.send(typeof data === "string" ? data : (data as ArrayBuffer));
        },
        onMessage(handler) {
            messageHandlers.push(handler);
        },
        onStatus(handler) {
            statusHandlers.push(handler);
            handler(status);
        },
        close() {
            stopHeartbeat();
            appStateSub.remove();
            closedByApp = true;
            socket.close();
            setStatus("closed");

            // Drop every subscription. Without this a torn-down session's late frames and close
            // event still run its old handlers, which now belong to whatever session replaced it.
            socket.removeEventListener("open", onOpen);
            socket.removeEventListener("message", onMessage);
            socket.removeEventListener("close", onDisconnect);
            socket.removeEventListener("error", onDisconnect);
            messageHandlers.length = 0;
            statusHandlers.length = 0;
        },
    };
}
