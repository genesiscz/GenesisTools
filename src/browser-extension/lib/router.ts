import { type RouterConfig, readRouterConfig } from "@genesiscz/utils/browser-router/config";
import { browserHosts } from "@genesiscz/utils/browser-router/services";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { GENESIS_APP_BUNDLE_ID } from "@genesiscz/utils/macos/genesis-app";
import type { Deps } from "./deps";
import { cliTail, FeatureError } from "./errors";
import type { PlainNavigationService, RouterEnsureData } from "./host/messages";
import { allowsPlainNavigation, loopbackPort } from "./loopback";
import { isRecord } from "./values";

/**
 * What the router config wants caught in the browser: its link host, alias hosts and dashboard names, plus every
 * registered server it names with whether a plain browser navigation may start it.
 */
export interface RouterHosts {
    linkHost: string | null;
    hosts: string[];
    services: PlainNavigationService[];
}

/**
 * The servers the router config's `service` routes name, one per port. A port is open to a plain browser
 * navigation only when every service route for it carries the literal `true` (presets sync copies it from the
 * port registry), so one route without it closes the port.
 */
export function plainNavigationServices(config: RouterConfig | null): PlainNavigationService[] {
    const byPort = new Map<number, PlainNavigationService>();

    for (const rule of config?.routes ?? []) {
        if (rule.action.type !== "service") {
            continue;
        }

        const { port, name } = rule.action;
        const allowed = rule.action.allowExecuteByPlainBrowserNavigationMightBeDangerous === true;
        const seen = byPort.get(port);
        byPort.set(port, {
            port,
            name: seen?.name ?? name,
            allowExecuteByPlainBrowserNavigationMightBeDangerous:
                (seen?.allowExecuteByPlainBrowserNavigationMightBeDangerous ?? true) && allowed,
            target: `http://localhost:${port}`,
        });
    }

    return [...byPort.values()].sort((a, b) => a.port - b.port);
}

/** Read on every request: a flag flipped in the router config counts from the next navigation, with no rebuild. */
export function currentHosts(): RouterHosts {
    const config = readRouterConfig();
    return { ...browserHosts(config), services: plainNavigationServices(config) };
}
/** GenesisTools.app is the http(s) handler and routes links itself. */
export const ROUTER_BUNDLE_ID = GENESIS_APP_BUNDLE_ID;

const log = logger.child({ component: "browser-extension/router" });

export interface RouteOutcome {
    /** True when the router took the link; false when it would only forward it to the public site. */
    handled: boolean;
    kind: string;
    via: string;
    /** Where the router sends it, or what it runs, in one line. */
    summary: string;
    /** The route runs a program or a tool, so the route page asks for a click before handing it over. */
    runs: boolean;
    /** The link was handed to the router (false for `explainLink`). */
    routed: boolean;
    /** The registered server this link starts and opens, with the URL the router rewrote it to. */
    service: { port: number; name: string; target: string } | null;
    /**
     * The live config lets a plain browser navigation start that server (its flag is true for that port, and a
     * loopback link names that same port), so the route page starts it with `router.ensure` and stays in its tab.
     */
    plainNavigation: boolean;
}

export function checkRouterLink(value: unknown, wanted: RouterHosts = currentHosts()): string {
    if (typeof value !== "string" || value.length > 4000 || !URL.canParse(value)) {
        throw new FeatureError("invalid", "not a URL");
    }

    const url = new URL(value);
    const linkHostLink =
        (url.protocol === "https:" || url.protocol === "http:") &&
        wanted.linkHost !== null &&
        url.hostname === wanted.linkHost;
    const web = url.protocol === "https:" || url.protocol === "http:";
    const routerHost = web && url.port === "" && wanted.hosts.includes(url.hostname);
    // Beside the name hosts, not instead of their empty port: a typed loopback address counts only for a port whose
    // live config lets a plain browser navigation start its server.
    const port = loopbackPort(value);
    const loopback = port !== null && allowsPlainNavigation(wanted.services, port);

    if (!linkHostLink && !routerHost && !loopback) {
        throw new FeatureError(
            "invalid",
            "only the router's link host, its configured hosts, and the loopback address of a server that allows a plain browser navigation are routed"
        );
    }

    return url.href;
}

export interface RouterDecision {
    kind: string;
    via: string;
    summary: string;
    service: { port: number; name: string; target: string } | null;
}

/** The router's decision, as `tools browser-router explain --json` prints it. */
export function readDecision(stdout: string): RouterDecision {
    const parsed: unknown = SafeJSON.parse(stdout, { strict: true });

    if (!isRecord(parsed) || typeof parsed.kind !== "string") {
        throw new FeatureError("failed", "browser-router explain printed no decision");
    }

    const via = typeof parsed.via === "string" ? parsed.via : "route";
    const argv = Array.isArray(parsed.argv) ? parsed.argv.join(" ") : null;
    const tool = typeof parsed.tool === "string" ? `tools ${parsed.tool}` : null;
    const target = typeof parsed.url === "string" ? parsed.url : "";
    // A registered server's start and open: the router's own built-in decision, never a saved route.
    const service =
        isRecord(parsed.service) &&
        typeof parsed.service.name === "string" &&
        typeof parsed.service.port === "number" &&
        Number.isInteger(parsed.service.port)
            ? { port: parsed.service.port, name: parsed.service.name, target }
            : null;

    if (service) {
        return { kind: parsed.kind, via, summary: `start and open ${service.name} (${target})`, service };
    }

    return { kind: parsed.kind, via, summary: argv ?? tool ?? target, service: null };
}

/**
 * What GenesisTools.app would do with a router link, read through the router's own CLI door
 * (`explain`) so this code never re-implements its matching. No side effects. A link the router
 * would only forward to the default browser is `handled: false`: forwarding it would land in this
 * browser again and loop.
 */
export async function explainLink(
    deps: Deps,
    rawUrl: unknown,
    wanted: RouterHosts = currentHosts()
): Promise<RouteOutcome> {
    const url = checkRouterLink(rawUrl, wanted);
    const explained = await deps.tools(["browser-router", "explain", url, "--json"], { timeoutMs: 15_000 });

    if (explained.code !== 0) {
        throw new FeatureError(
            "unavailable",
            `The local router could not read this link: ${cliTail(explained.stderr)}`
        );
    }

    const decision = readDecision(explained.stdout);
    const handled = decision.via !== "default" && decision.via !== "loop-guard";
    const port = loopbackPort(url);
    // The flag is the only authorization: a service decision alone is not, and a loopback link must name the port
    // whose server it starts.
    const plainNavigation =
        handled &&
        decision.service !== null &&
        allowsPlainNavigation(wanted.services, decision.service.port) &&
        (port === null || port === decision.service.port);
    // Starting a server that allows it needs no click; any other run, and a server that does not allow it, does.
    const runs = (decision.kind === "run" || decision.kind === "tool") && !plainNavigation;
    log.info(
        { url, kind: decision.kind, via: decision.via, handled, runs, service: decision.service, plainNavigation },
        "router decision"
    );
    return { handled, runs, routed: false, plainNavigation, ...decision };
}

/** Above `browser-router ensure`'s own 20 s wait, so its message (with the log path) arrives instead of a kill. */
const ENSURE_TIMEOUT_MS = 30_000;

/**
 * Starts the server behind a plain browser navigation (a typed `http://127.0.0.1:<port>/`, a dashboard name) and
 * returns the URL the router rewrote, so the route page continues there in its own tab. It never hands the link to
 * GenesisTools.app, which would open a second tab. The host decides again on its own: it re-parses the URL, asks
 * the router, and runs `tools browser-router ensure <port>` only when the live config entry for that exact port
 * allows a plain browser navigation. Something already listening on the port is left alone (`started: false`).
 */
export async function ensureLink(
    deps: Deps,
    rawUrl: unknown,
    wanted: RouterHosts = currentHosts()
): Promise<RouterEnsureData> {
    const decision = await explainLink(deps, rawUrl, wanted);

    if (!decision.plainNavigation || decision.service === null) {
        throw new FeatureError(
            "invalid",
            "this link does not start a server that allows a plain browser navigation; it needs a click"
        );
    }

    const { port, name, target } = decision.service;
    log.info({ port, name, target }, "router ensure: starting for a plain browser navigation");
    const ensured = await deps.tools(["browser-router", "ensure", String(port)], { timeoutMs: ENSURE_TIMEOUT_MS });

    if (ensured.code !== 0) {
        log.warn({ port, name, code: ensured.code, stderr: ensured.stderr }, "router ensure failed");
        throw new FeatureError("failed", `${name} did not start: ${cliTail(ensured.stderr || ensured.stdout)}`);
    }

    // `ensure` prints `started <name>` when it launched the server and `<name> is up` when something listened.
    const started = /^started /m.test(ensured.stdout);
    log.info({ port, name, started }, "router ensure: listening");
    return { port, name, started, target };
}

/** Hands a router link to GenesisTools.app, unless the router would only send it back here. */
export async function routeLink(
    deps: Deps,
    rawUrl: unknown,
    wanted: RouterHosts = currentHosts()
): Promise<RouteOutcome> {
    const url = checkRouterLink(rawUrl, wanted);
    const decision = await explainLink(deps, url, wanted);

    if (!decision.handled) {
        return decision;
    }

    if (decision.plainNavigation && loopbackPort(url) !== null) {
        // GenesisTools.app would open it in a second tab, and that tab lands on the route page again.
        throw new FeatureError("invalid", "a typed loopback address starts in its own tab (router.ensure)");
    }

    const app = await deps.run(["/usr/bin/open", "-b", ROUTER_BUNDLE_ID, url], { timeoutMs: 15_000 });

    if (app.code === 0) {
        return { ...decision, routed: true };
    }

    log.warn({ stderr: app.stderr }, "GenesisTools.app did not take the link; using the CLI");
    const cli = await deps.tools(["browser-router", "open", url], { timeoutMs: 60_000 });

    if (cli.code !== 0) {
        throw new FeatureError("failed", `The local router could not open this link: ${cliTail(cli.stderr)}`);
    }

    return { ...decision, routed: true };
}
