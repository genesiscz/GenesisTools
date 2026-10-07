import { WebSocket as ReconnectingWebSocket } from "partysocket";
import { AppState, type AppStateStatus } from "react-native";
import {
    decodeTtydFrame,
    encodeTtydInit,
    encodeTtydInput,
    encodeTtydResize,
    type TtydDimensions,
} from "@/transport/ttyd-protocol";
import type { TerminalStatus, TerminalTransport } from "@/transport/Transport";

export interface TerminalTransportOptions {
    /** ws:// or wss:// URL to the ttyd session (already tier-resolved). */
    wsUrl: string;
    /** ttyd uses the "tty" subprotocol; auth cookie/token is planted by the renderer (plan 06). */
    protocols?: string[];
    /** Test seam: construct a fake socket. Defaults to partysocket's ReconnectingWebSocket. */
    socketFactory?: (url: string, protocols?: string[]) => ReconnectingWebSocket;
    dimensions?: TtydDimensions;
    authToken?: string;
    /** Optional managed-tier envelope around complete ttyd protocol frames. */
    wire?: {
        encode: (frame: ArrayBuffer) => string | ArrayBuffer;
        decode: (frame: string | ArrayBuffer) => string | ArrayBuffer | null;
    };
}

export function createTerminalTransport(opts: TerminalTransportOptions): TerminalTransport {
    const make = opts.socketFactory ?? ((url, protocols) => new ReconnectingWebSocket(url, protocols));
    let status: TerminalStatus = "connecting";
    let dimensions = opts.dimensions ?? { columns: 80, rows: 24 };
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

    function sendFrame(frame: ArrayBuffer): void {
        socket.send(opts.wire?.encode(frame) ?? frame);
    }

    function onOpen(): void {
        closedByApp = false;
        sendFrame(encodeTtydInit(dimensions, opts.authToken));
        setStatus("open");
    }

    function onMessage(ev: MessageEvent): void {
        const wireFrame = ev.data as string | ArrayBuffer;
        const decodedWireFrame = opts.wire ? opts.wire.decode(wireFrame) : wireFrame;
        if (decodedWireFrame === null) {
            return;
        }

        const frame = decodeTtydFrame(decodedWireFrame);
        if (frame.type !== "output") {
            return;
        }

        for (const h of messageHandlers) {
            h(frame.data);
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
            sendFrame(encodeTtydInput(data));
        },
        onMessage(handler) {
            messageHandlers.push(handler);
        },
        onStatus(handler) {
            statusHandlers.push(handler);
            handler(status);
        },
        resize(columns, rows) {
            dimensions = { columns, rows };

            if (status === "open") {
                sendFrame(encodeTtydResize(dimensions));
            }
        },
        close() {
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
