import { SafeJSON } from "@app/utils/json";
import type { JobEvent } from "@app/youtube/lib/jobs.types";
import type { Youtube } from "@app/youtube/lib/youtube";
import type { ServerWebSocket, WebSocketHandler } from "bun";

export interface WebsocketState {
    subscribedJobIds: Set<number> | "all";
    /** "all" = operator socket (service key or open mode); "user" = only events for jobs owned by userId. */
    scope: "all" | "user";
    userId: number | null;
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
    "summary:partial",
    "job:completed",
    "job:failed",
    "job:cancelled",
];

const TERMINAL_EVENTS: ReadonlySet<JobEvent["type"]> = new Set(["job:completed", "job:failed", "job:cancelled"]);

export function setupWebsocket(yt: Youtube): WebsocketServer {
    const sockets = new Set<ServerWebSocket<WebsocketState>>();
    // jobId → owner, fed by job-carrying events with a lazy DB lookup for
    // jobId-only events, so user filtering doesn't hit SQLite per socket.
    const jobOwners = new Map<number, number | null>();
    const offHandlers = PIPELINE_EVENTS.map((event) => yt.pipeline.on(event, broadcast));

    function ownerOf(event: JobEvent): number | null {
        if ("job" in event) {
            jobOwners.set(event.job.id, event.job.userId);

            return event.job.userId;
        }

        const jobId = getEventJobId(event);

        if (jobId === null) {
            return null;
        }

        if (!jobOwners.has(jobId)) {
            jobOwners.set(jobId, yt.db.getJob(jobId)?.userId ?? null);
        }

        return jobOwners.get(jobId) ?? null;
    }

    function broadcast(event: JobEvent): void {
        const payload = SafeJSON.stringify(event);
        const owner = ownerOf(event);

        for (const ws of sockets) {
            if (filterMatches(ws.data, event, owner)) {
                ws.send(payload);
            }
        }

        const jobId = getEventJobId(event);

        if (TERMINAL_EVENTS.has(event.type) && jobId !== null) {
            jobOwners.delete(jobId);
        }
    }

    return {
        handler: {
            open(ws) {
                // Keep the upgrade-time scope/user; only (re)set the job filter.
                ws.data = {
                    subscribedJobIds: "all",
                    scope: ws.data?.scope ?? "all",
                    userId: ws.data?.userId ?? null,
                };
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

                ws.data = { ...ws.data, subscribedJobIds: message.jobIds ? new Set(message.jobIds) : "all" };
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
            jobOwners.clear();
        },
    };
}

function filterMatches(state: WebsocketState, event: JobEvent, owner: number | null): boolean {
    if (state.scope === "user" && owner !== state.userId) {
        return false;
    }

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
