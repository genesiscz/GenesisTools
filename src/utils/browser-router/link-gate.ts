import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { genesisToolsDir } from "@genesiscz/utils/storage/root";

/**
 * What a printed link needs to know about the router: `routerStatus()` reduced to the link host and
 * the presets a link works for, kept on disk so a hook can ask for the price of one small read.
 */
export interface LinkGate {
    at: number;
    /** The router config's mtime when this was taken; a saved config makes the gate stale at once. */
    configMtimeMs: number;
    /** null when links would not reach the router: not installed, or not the https handler. */
    linkHost: string | null;
    enabledPresets: string[];
}

/** The app being installed or made the https handler changes no file this gate watches, so it ages out. */
const MAX_AGE_MS = 30 * 60_000;

export function linkGatePath(): string {
    return genesisToolsDir("browser-router", "link-gate.json");
}

/** The same file as `configFile()`, named here so the gate need not import `Storage` and its logger. */
function routerConfigMtime(): number {
    try {
        return statSync(genesisToolsDir("browser-router", "config.json")).mtimeMs;
    } catch {
        return 0;
    }
}

/**
 * Whether router links work on this Mac. A gate under 30 minutes old whose router config is unchanged
 * costs one read; anything else is recomputed with `routerStatus()` and saved.
 */
export function linkGate({ now = Date.now() }: { now?: number } = {}): LinkGate {
    const configMtimeMs = routerConfigMtime();

    try {
        const cached = SafeJSON.parse(readFileSync(linkGatePath(), "utf8")) as Partial<LinkGate>;

        if (
            typeof cached.at === "number" &&
            now - cached.at < MAX_AGE_MS &&
            cached.configMtimeMs === configMtimeMs &&
            Array.isArray(cached.enabledPresets) &&
            (typeof cached.linkHost === "string" || cached.linkHost === null)
        ) {
            return { at: cached.at, configMtimeMs, linkHost: cached.linkHost, enabledPresets: cached.enabledPresets };
        }
    } catch {
        // No gate yet, or an unreadable one: recomputed below.
    }

    // lazy: saves 32-70 ms of imports on every hook call (require of ./status, measured 2026-10-15) — only a stale gate needs them
    const { routerStatus } = require("./status") as typeof import("./status");
    const status = routerStatus();
    const gate: LinkGate = {
        at: now,
        configMtimeMs,
        linkHost: status.installed && status.defaultHandler ? status.linkHost : null,
        enabledPresets: status.enabledPresets,
    };

    try {
        mkdirSync(dirname(linkGatePath()), { recursive: true });
        writeFileSync(linkGatePath(), SafeJSON.stringify(gate));
    } catch {
        // A gate that cannot be saved is recomputed next time; the answer itself is still right.
    }

    return gate;
}

/**
 * `https://<link host>/<path>` when the router routes `preset` on this Mac, else `null`, so the caller
 * prints its fallback (a plain path, a command) instead of a link that opens nothing.
 */
export function presetUrl({ preset, path, gate }: { preset: string; path: string; gate?: LinkGate }): string | null {
    const known = gate ?? linkGate();

    if (known.linkHost === null || !known.enabledPresets.includes(preset)) {
        return null;
    }

    return `https://${known.linkHost}/${path.replace(/^\//, "")}`;
}
