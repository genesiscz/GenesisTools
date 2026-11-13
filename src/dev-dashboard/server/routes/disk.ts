import { ENDPOINTS } from "@app/dev-dashboard/contract/endpoint-table";
import { collectDiskUsage } from "@app/dev-dashboard/lib/disk/usage";
import { bindHandler } from "@app/dev-dashboard/server/bind";
import { errorResult } from "@app/dev-dashboard/server/routes/error";
import type { RouteDef } from "@app/dev-dashboard/server/types";

export function diskRoutes(): RouteDef[] {
    return [
        bindHandler(ENDPOINTS.diskUsage, async () => {
            try {
                return { kind: "json", status: 200, body: await collectDiskUsage() };
            } catch (err) {
                return errorResult(err);
            }
        }),
    ];
}
