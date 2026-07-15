import { classifyListeningPorts, killPort, listListeningPorts } from "@app/dev-dashboard/lib/ports/scanner";
import type { PortInfo, PortsClassifyEvent } from "@app/dev-dashboard/lib/ports/types";
import { errorResult } from "@app/dev-dashboard/server/routes/error";
import type { RouteDef } from "@app/dev-dashboard/server/types";
import { SafeJSON } from "@app/utils/json";

interface KillBody {
    pid?: number;
    expectedCommand?: string;
}

const CLASSIFY_CHUNK = 8;

export function portsRoutes(): RouteDef[] {
    return [
        {
            method: "GET",
            pattern: "/api/ports",
            handler: async () => {
                try {
                    return { kind: "json", status: 200, body: await listListeningPorts() };
                } catch (err) {
                    return errorResult(err);
                }
            },
        },
        {
            method: "GET",
            pattern: "/api/ports/classify",
            longLived: true,
            handler: async () => {
                // Re-list (meta only) then stream HTTP classification in batches so the UI can
                // paint immediately from GET /api/ports and merge kind updates as they arrive.
                let ports: PortInfo[] = [];
                try {
                    const listed = await listListeningPorts();
                    ports = listed.ports;
                } catch (err) {
                    return errorResult(err);
                }

                return {
                    kind: "sse",
                    start: (emit) => {
                        let cancelled = false;
                        const keepAlive = setInterval(() => emit.comment(" ping"), 12_000);

                        void (async () => {
                            try {
                                const pending = ports.filter((p) => p.probeStatus === "pending");
                                let classified = 0;

                                for (let i = 0; i < pending.length; i += CLASSIFY_CHUNK) {
                                    if (cancelled) {
                                        return;
                                    }

                                    const chunk = pending.slice(i, i + CLASSIFY_CHUNK);
                                    const updated = await classifyListeningPorts(chunk);
                                    classified += updated.length;

                                    if (updated.length > 0) {
                                        const evt: PortsClassifyEvent = { type: "batch", ports: updated };
                                        emit.data(SafeJSON.stringify(evt));
                                    }
                                }

                                if (!cancelled) {
                                    const done: PortsClassifyEvent = { type: "done", classified };
                                    emit.data(SafeJSON.stringify(done));
                                }
                            } catch (err) {
                                if (!cancelled) {
                                    const evt: PortsClassifyEvent = {
                                        type: "error",
                                        message: err instanceof Error ? err.message : String(err),
                                    };
                                    emit.data(SafeJSON.stringify(evt));
                                }
                            }
                        })();

                        return {
                            close: () => {
                                cancelled = true;
                                clearInterval(keepAlive);
                            },
                        };
                    },
                };
            },
        },
        {
            method: "POST",
            pattern: "/api/ports/kill",
            handler: async (ctx) => {
                try {
                    const body = await ctx.readJson<KillBody>();
                    const pid = Number(body.pid);

                    if (!Number.isInteger(pid)) {
                        return { kind: "json", status: 400, body: { error: "pid (number) is required" } };
                    }

                    return { kind: "json", status: 200, body: killPort(pid, body.expectedCommand) };
                } catch (err) {
                    return errorResult(err);
                }
            },
        },
    ];
}
