import { listDashboards, listPortRegistry } from "@genesiscz/utils/ui/dashboards";
import { hostPattern, linkPattern, type RouteRule, type RouterConfig } from "./route";

export interface RegistryService {
    key: string;
    port: number;
    name: string;
    /** A browser dashboard, not an API: only these get a name of their own. */
    dashboard: boolean;
}

/** Every registered server with a launch command, from `src/utils/ui/dashboards.ts`. */
export function registryServices(): RegistryService[] {
    const dashboards = new Set(listDashboards().map((entry) => entry.key));
    return listPortRegistry()
        .filter((entry) => entry.launch)
        .map((entry) => ({ key: entry.key, port: entry.port, name: entry.name, dashboard: dashboards.has(entry.key) }));
}

function pick(services: RegistryService[], only: string[] | undefined): RegistryService[] {
    return only === undefined ? services : services.filter((service) => only.includes(service.key));
}

/** The `local-services` preset: a click on `localhost:<port>` starts that registered server first. */
export function localServiceRoutes(only?: string[]): RouteRule[] {
    return pick(registryServices(), only).map((service) => ({
        preset: "local-services",
        name: service.name,
        pattern: `https?://(?:localhost|127\\.0\\.0\\.1):${service.port}([/?#].*)?`,
        action: { type: "service", port: service.port, name: service.name, to: `http://localhost:${service.port}$1` },
    }));
}

/**
 * The names the `dashboard-names` preset answers to: every dashboard's registry key (narrowed by
 * `only`), plus each extra name in `names` pointing at a registry dashboard (`dashboard` ->
 * `artifact-library`). An extra name that equals a key replaces that key's own dashboard.
 */
export function dashboardNames({
    only,
    names = {},
}: {
    only?: string[];
    names?: Record<string, string>;
}): Array<{ name: string; service: RegistryService }> {
    const dashboards = registryServices().filter((service) => service.dashboard);
    const extra = Object.entries(names).flatMap(([name, key]) => {
        const service = dashboards.find((item) => item.key === key);
        return service ? [{ name: name.toLowerCase(), service }] : [];
    });
    const taken = new Set(extra.map((item) => item.name));
    const own = pick(dashboards, only)
        .filter((service) => !taken.has(service.key))
        .map((service) => ({ name: service.key, service }));
    return [...extra, ...own];
}

/**
 * The `dashboard-names` preset: each name works as a host (`https://jev/x`) and, with a link host,
 * as a path on it (`https://<linkHost>/jev/x`).
 */
export function dashboardNameRoutes({
    linkHost,
    only,
    names,
}: {
    linkHost?: string;
    only?: string[];
    names?: Record<string, string>;
}): RouteRule[] {
    return dashboardNames({ only, names }).flatMap(({ name, service }) => {
        const action = {
            type: "service" as const,
            port: service.port,
            name: service.name,
            to: `http://localhost:${service.port}$1`,
        };
        const byHost: RouteRule = {
            preset: "dashboard-names",
            name: service.name,
            // The capture takes a root query or fragment too (`https://youtube?view=queue`), so $1 keeps it.
            pattern: `https?://${hostPattern(name)}([/?#].*)?`,
            action,
        };
        const byPath: RouteRule[] = linkHost
            ? [
                  {
                      preset: "dashboard-names",
                      name: service.name,
                      pattern: linkPattern(linkHost, `${name}([/?#].*)?`),
                      action,
                  },
              ]
            : [];
        return [byHost, ...byPath];
    });
}

/**
 * Hosts the browser extension must catch when typed: the link host, every alias host, and the
 * dashboard names when that preset is on. The build grants exactly these.
 */
export function browserHosts(config: RouterConfig | null): { linkHost: string | null; hosts: string[] } {
    if (!config) {
        return { linkHost: null, hosts: [] };
    }

    const chosen = config.presets?.["dashboard-names"];
    const dashboards =
        chosen === undefined ? [] : dashboardNames({ only: chosen.only, names: chosen.names }).map((item) => item.name);
    const aliases =
        config.allowAliases === false ? [] : (config.aliases ?? []).map((alias) => alias.host.toLowerCase());
    return { linkHost: config.linkHost ?? null, hosts: [...new Set([...aliases, ...dashboards])] };
}
