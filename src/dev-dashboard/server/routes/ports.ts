import { killPort, listListeningPorts } from "@app/dev-dashboard/lib/ports/scanner";
import { errorResult } from "@app/dev-dashboard/server/routes/error";
import type { RouteDef } from "@app/dev-dashboard/server/types";

interface KillBody {
    pid?: number;
    expectedCommand?: string;
}

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
