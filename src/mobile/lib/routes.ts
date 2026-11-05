import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { type MobileProject, type MobileRoute, projectRoutes, resolveRoute } from "@genesiscz/utils/mobile/project";

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
