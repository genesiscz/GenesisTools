import { isLiveChannel, parseChannelsQuery } from "@app/dev-dashboard/lib/live/channels";
import type { LiveHub } from "@app/dev-dashboard/lib/live/hub";
import type { LiveChannel, LiveSubscribeBody } from "@app/dev-dashboard/lib/live/types";
import { errorResult } from "@app/dev-dashboard/server/routes/error";
import type { RouteDef } from "@app/dev-dashboard/server/types";

export function liveRoutes(hub: LiveHub): RouteDef[] {
    return [
        {
            method: "GET",
            pattern: "/api/live",
            longLived: true,
            handler: (ctx) => {
                const channels = parseChannelsQuery(ctx.query.get("channels"));

                return {
                    kind: "sse",
                    start: (emit) => {
                        const { close } = hub.open(emit, channels);
                        const keepAlive = setInterval(() => emit.comment(" ping"), 12_000);

                        return {
                            close: () => {
                                clearInterval(keepAlive);
                                close();
                            },
                        };
                    },
                };
            },
        },
        {
            method: "POST",
            pattern: "/api/live/subscribe",
            handler: async (ctx) => {
                try {
                    const body = await ctx.readJson<LiveSubscribeBody>();
                    const connId = typeof body.connId === "string" ? body.connId : "";
                    if (!connId) {
                        return { kind: "json", status: 400, body: { error: "connId required" } };
                    }

                    const raw = Array.isArray(body.channels) ? body.channels : [];
                    const channels: LiveChannel[] = [];
                    const seen = new Set<string>();
                    for (const c of raw) {
                        if (typeof c !== "string" || seen.has(c) || !isLiveChannel(c)) {
                            continue;
                        }

                        seen.add(c);
                        channels.push(c);
                    }

                    const result = hub.setChannels(connId, channels);
                    if (result === null) {
                        return { kind: "json", status: 404, body: { error: "unknown connId" } };
                    }

                    return { kind: "json", status: 200, body: { ok: true, channels: result } };
                } catch (err) {
                    return errorResult(err);
                }
            },
        },
    ];
}
