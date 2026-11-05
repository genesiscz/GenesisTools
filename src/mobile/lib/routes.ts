import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { type MobileProject, type MobileRoute, projectRoutes } from "@genesiscz/utils/mobile/project";

/**
 * A route from what a person types: a route name (`agents`), a route name with a query (`session?key=abc`, which
 * keeps the route's root id), or a whole URL (`shop://cart`, opened with no root to wait for).
 */
export function resolveRoute(routes: MobileRoute[], target: string): MobileRoute {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target)) {
        return { name: "link", url: target };
    }

    const [name, query] = target.split(/\?(.*)/s, 2);
    const route = routes.find((candidate) => candidate.name === name);

    if (!route) {
        throw new Error(`no route "${name}"; list them with: ${toolCommand("mobile routes")}`);
    }

    if (!query) {
        return route;
    }

    return { ...route, url: `${route.url}${route.url.includes("?") ? "&" : "?"}${query}` };
}

/** The routes a command works on: all of them, or the named ones (an unknown name is an error with the list). */
export function selectRoutes(routes: MobileRoute[], only?: string[]): MobileRoute[] {
    const picked = routes.filter((route) => !only?.length || only.includes(route.name));

    if (picked.length === 0) {
        throw new Error(
            `no route matches ${only?.join(", ") || "(the project names none)"}; list them with: ${toolCommand("mobile routes")}`
        );
    }

    return picked;
}

export function projectRoute(project: MobileProject, target: string): MobileRoute {
    return resolveRoute(projectRoutes(project), target);
}
