import { ENDPOINTS } from "@app/dev-dashboard/contract/endpoint-table";
import { listContainers } from "@app/dev-dashboard/lib/containers/docker";
import { bindHandler } from "@app/dev-dashboard/server/bind";
import { errorResult } from "@app/dev-dashboard/server/routes/error";
import type { RouteDef } from "@app/dev-dashboard/server/types";

export function containersRoutes(): RouteDef[] {
    return [
        bindHandler(ENDPOINTS.containers, async () => {
            try {
                return { kind: "json", status: 200, body: await listContainers() };
            } catch (err) {
                return errorResult(err);
            }
        }),
    ];
}
