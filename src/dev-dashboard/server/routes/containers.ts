import { listContainers } from "@app/dev-dashboard/lib/containers/docker";
import { errorResult } from "@app/dev-dashboard/server/routes/error";
import type { RouteDef } from "@app/dev-dashboard/server/types";

export function containersRoutes(): RouteDef[] {
    return [
        {
            method: "GET",
            pattern: "/api/containers",
            handler: async () => {
                try {
                    return { kind: "json", status: 200, body: await listContainers() };
                } catch (err) {
                    return errorResult(err);
                }
            },
        },
    ];
}
