import { collectDiskUsage } from "@app/dev-dashboard/lib/disk/usage";
import { errorResult } from "@app/dev-dashboard/server/routes/error";
import type { RouteDef } from "@app/dev-dashboard/server/types";

export function diskRoutes(): RouteDef[] {
    return [
        {
            method: "GET",
            pattern: "/api/disk/usage",
            handler: async () => {
                try {
                    return { kind: "json", status: 200, body: await collectDiskUsage() };
                } catch (err) {
                    return errorResult(err);
                }
            },
        },
    ];
}
