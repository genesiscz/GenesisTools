import { mdKind } from "@app/dev-dashboard/lib/share/kind";
import { snapshotShareSource } from "@app/dev-dashboard/lib/share/snapshot";
import { routerToResponse } from "@app/dev-dashboard/server/adapters/bun-serve";
import { defaultSystemCollector } from "@app/dev-dashboard/server/collector/SystemCollector";
import { Router } from "@app/dev-dashboard/server/router";
import { shareRoutes } from "@app/dev-dashboard/server/routes/share";
import type { PublishKindId } from "@genesiscz/utils/genesis-tools/publish/kinds";
import { type KindRequest, type KindServer, serveKind } from "@genesiscz/utils/publish/kind";
import { artifactKindServer } from "@genesiscz/utils/publish/kinds/artifact";

let renderer: { kindDir: string; origin: string; router: Router } | undefined;

export function serveMd({ request, kindDir, origin }: KindRequest): Promise<Response | null> {
    if (!renderer || renderer.kindDir !== kindDir || renderer.origin !== origin) {
        const source = snapshotShareSource({ dataDir: kindDir, publicOrigin: origin });
        renderer = { kindDir, origin, router: new Router().addAll(shareRoutes(source, { pagePath: "/md" })) };
    }

    return routerToResponse(renderer.router, request, { services: { collector: defaultSystemCollector() } });
}

export const PUBLISH_KIND_SERVERS: Record<PublishKindId, KindServer> = {
    md: serveKind(mdKind, serveMd),
    artifact: artifactKindServer,
};
