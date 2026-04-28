import { SafeJSON } from "@app/utils/json";
import type { JobEvent } from "@app/youtube/lib/jobs.types";
import type { Youtube } from "@app/youtube/lib/youtube";
import type { ServerWebSocket, WebSocketHandler } from "bun";

export interface WebsocketState {
    subscribedJobIds: Set<number> | "all";
}

export interface WebsocketServer {
    handler: WebSocketHandler<WebsocketState>;
    close(): void;
}

type ClientMessage = { type: "ping" } | { type: "subscribe"; jobIds?: number[] };

const PIPELINE_EVENTS: JobEvent["type"][] = [
    "job:created",
    "job:started",
    "stage:started",
    "stage:progress",
    "stage:completed",
    "job:completed",
    "job:failed",
    "job:cancelled",
];

export function setupWebsocket(yt: Youtube): WebsocketServer {
    const sockets = new Set<ServerWebSocket<WebsocketState>>();
    const offHandlers = PIPELINE_EVENTS.map((event) => yt.pipeline.on(event, broadcast));

    function broadcast(event: JobEvent): void {
        const payload = SafeJSON.stringify(event);

        for (const ws of sockets) {
            if (filterMatches(ws.data, event)) {
                ws.send(payload);
            }
        }
    }

    return {
        handler: {
            open(ws) {
                ws.data = { subscribedJobIds: "all" };
                sockets.add(ws);
                ws.send(SafeJSON.stringify({ type: "hello", protocolVersion: 1 }));
            },
            close(ws) {
                sockets.delete(ws);
            },
            message(ws, raw) {
                const message = parseClientMessage(raw);

                if (!message) {
                    return;
                }

                if (message.type === "ping") {
                    ws.send(SafeJSON.stringify({ type: "pong" }));
                    return;
                }

                ws.data = { subscribedJobIds: message.jobIds ? new Set(message.jobIds) : "all" };
                ws.send(SafeJSON.stringify({ type: "subscribed", jobIds: message.jobIds ?? null }));
            },
        },
        close() {
            for (const off of offHandlers) {
                off();
            }

            for (const ws of sockets) {
                ws.close();
            }

            sockets.clear();
        },
    };
}

function filterMatches(state: WebsocketState, event: JobEvent): boolean {
    if (state.subscribedJobIds === "all") {
        return true;
    }

    const jobId = getEventJobId(event);
    return jobId !== null && state.subscribedJobIds.has(jobId);
}

function getEventJobId(event: JobEvent): number | null {
    if ("job" in event) {
        return event.job.id;
    }

    if ("jobId" in event) {
        return event.jobId;
    }

    return null;
}

function parseClientMessage(raw: string | Buffer): ClientMessage | null {
    try {
        const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
        const parsed = SafeJSON.parse(text) as { type?: unknown; jobIds?: unknown };

        if (parsed.type === "ping") {
            return { type: "ping" };
        }

        if (parsed.type === "subscribe") {
            if (!Array.isArray(parsed.jobIds)) {
                return { type: "subscribe" };
            }

            const jobIds = parsed.jobIds.filter((value): value is number => Number.isInteger(value));
            return { type: "subscribe", jobIds };
        }
    } catch {
        return null;
    }

    return null;
}
