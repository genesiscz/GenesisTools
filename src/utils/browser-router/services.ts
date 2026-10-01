import { listDashboards, listPortRegistry } from "@genesiscz/utils/ui/dashboards";
import type { RouterService } from "./route";

/** 6666 is the router's own symbolic host, never a server to start. */
const ROUTER_PORT = 6666;

/**
 * Every registered server with a launch command. A browser dashboard also gets its registry key as
 * a short host, so `https://dashboard` reaches the Personal Dashboard on whatever port it is on.
 */
export function routerServices(): RouterService[] {
    const dashboards = new Set(listDashboards().map((entry) => entry.key));
    return listPortRegistry()
        .filter((entry) => entry.launch && entry.port !== ROUTER_PORT)
        .map((entry) => ({
            port: entry.port,
            name: entry.name,
            ...(dashboards.has(entry.key) ? { host: entry.key } : {}),
        }));
}

/** The short hosts `routerServices()` hands out, for the browser extension's redirect rule. */
export function serviceShortcutHosts(): string[] {
    return routerServices().flatMap((service) => (service.host ? [service.host] : []));
}
