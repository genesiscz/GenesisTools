import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import type { MobileApp, MobileRoute } from "./types";

/**
 * A route from what a person types: a route name (`agents`), a route name with a query (`agent-session?key=abc`,
 * which keeps the route's root id), or a whole URL (`devdashboard://weather`, opened with no root to wait for).
 */
export function resolveRoute(app: MobileApp, appDir: string, target: string): MobileRoute {
    if (target.includes("://")) {
        return { name: "link", url: target };
    }

    const [name, query] = target.split(/\?(.*)/s, 2);
    const route = app.routes(appDir).find((candidate) => candidate.name === name);

    if (!route) {
        throw new Error(`no route "${name}"; list them with: ${toolCommand("mobile routes", app.id)}`);
    }

    if (!query) {
        return route;
    }

    return { ...route, url: `${route.url}${route.url.includes("?") ? "&" : "?"}${query}` };
}
