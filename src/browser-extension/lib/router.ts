import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { GENESIS_APP_BUNDLE_ID } from "@genesiscz/utils/macos/genesis-app";
import type { Deps } from "./deps";
import { FeatureError } from "./errors";
import { isRecord } from "./values";

/** The public host whose links the extension hands to GenesisTools.app. */
export const ROUTER_LINK_HOST = "genesis.tools";
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
}

export function checkRouterLink(value: unknown): string {
    if (typeof value !== "string" || value.length > 4000 || !URL.canParse(value)) {
        throw new FeatureError("invalid", "not a URL");
    }

    const url = new URL(value);

    if (url.protocol !== "https:" || url.hostname !== ROUTER_LINK_HOST) {
        throw new FeatureError("invalid", `only https://${ROUTER_LINK_HOST}/ links are routed`);
    }

    return url.href;
}

/** The router's decision, as `tools browser-router explain --json` prints it. */
export function readDecision(stdout: string): { kind: string; via: string; summary: string } {
    const parsed: unknown = SafeJSON.parse(stdout, { strict: true });

    if (!isRecord(parsed) || typeof parsed.kind !== "string") {
        throw new FeatureError("failed", "browser-router explain printed no decision");
    }

    const via = typeof parsed.via === "string" ? parsed.via : "route";
    const argv = Array.isArray(parsed.argv) ? parsed.argv.join(" ") : null;
    const tool = typeof parsed.tool === "string" ? `tools ${parsed.tool}` : null;
    const target = typeof parsed.url === "string" ? parsed.url : "";
    return { kind: parsed.kind, via, summary: argv ?? tool ?? target };
}

/**
 * What GenesisTools.app would do with a genesis.tools link, read through the router's own CLI door
 * (`explain`) so this code never re-implements its matching. No side effects. A link the router
 * would only forward to the default browser is `handled: false`: forwarding it would land in this
 * browser again and loop.
 */
export async function explainLink(deps: Deps, rawUrl: unknown): Promise<RouteOutcome> {
    const url = checkRouterLink(rawUrl);
    const explained = await deps.tools(["browser-router", "explain", url, "--json"], { timeoutMs: 15_000 });

    if (explained.code !== 0) {
        throw new FeatureError("unavailable", `browser-router explain failed: ${explained.stderr.trim().slice(-300)}`);
    }

    const decision = readDecision(explained.stdout);
    const handled = decision.via !== "default" && decision.via !== "loop-guard";
    const runs = decision.kind === "run" || decision.kind === "tool";
    log.info({ url, kind: decision.kind, via: decision.via, handled, runs }, "router decision");
    return { handled, runs, routed: false, ...decision };
}

/** Hands a genesis.tools link to GenesisTools.app, unless the router would only send it back here. */
export async function routeLink(deps: Deps, rawUrl: unknown): Promise<RouteOutcome> {
    const url = checkRouterLink(rawUrl);
    const decision = await explainLink(deps, url);

    if (!decision.handled) {
        return decision;
    }

    const app = await deps.run(["/usr/bin/open", "-b", ROUTER_BUNDLE_ID, url], { timeoutMs: 15_000 });

    if (app.code === 0) {
        return { ...decision, routed: true };
    }

    log.warn({ stderr: app.stderr }, "GenesisTools.app did not take the link; using the CLI");
    const cli = await deps.tools(["browser-router", "open", url], { timeoutMs: 60_000 });

    if (cli.code !== 0) {
        throw new FeatureError("failed", `browser-router open failed: ${cli.stderr.trim().slice(-300)}`);
    }

    return { ...decision, routed: true };
}
