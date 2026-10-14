import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { genesisToolsDir } from "@genesiscz/utils/storage/root";

/** One preset as a printed link needs it. */
export interface GatePreset {
    /** Its app or capability is on this Mac. */
    available: boolean;
    /** Turned on in the config. */
    enabled: boolean;
    /** The config holds its routes as the preset writes them. */
    routed: boolean;
    /** Capabilities it lacks, for the error a caller gets. */
    missing: string[];
}

/**
 * What a printed link needs to know about the router: `routerStatus()` reduced to the facts a link
 * depends on, kept on disk so a hook can ask for the price of one small read.
 */
export interface LinkGate {
    version: 2;
    at: number;
    /** The router config's mtime when this was taken; a saved config makes the gate stale at once. */
    configMtimeMs: number;
    /** GenesisTools.app, which routes the links and serves `genesis-tools://`, is installed. */
    installed: boolean;
    /** macOS opens https links with GenesisTools.app, so a clicked link reaches the router. */
    defaultHandler: boolean;
    httpsHandler: string | null;
    configured: boolean;
    linkHost: string | null;
    presets: Record<string, GatePreset>;
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

function isGate(value: unknown): value is LinkGate {
    return (
        typeof value === "object" &&
        value !== null &&
        "version" in value &&
        value.version === 2 &&
        "presets" in value &&
        typeof value.presets === "object" &&
        value.presets !== null
    );
}

/**
 * The router facts on this Mac. A gate under 30 minutes old whose router config is unchanged costs one
 * read; anything else is recomputed with `routerStatus()` and saved.
 */
export function linkGate({ now = Date.now() }: { now?: number } = {}): LinkGate {
    const configMtimeMs = routerConfigMtime();

    try {
        const cached: unknown = SafeJSON.parse(readFileSync(linkGatePath(), "utf8"));

        if (isGate(cached) && now - cached.at < MAX_AGE_MS && cached.configMtimeMs === configMtimeMs) {
            return cached;
        }
    } catch {
        // No gate yet, or an unreadable one: recomputed below.
    }

    // lazy: saves 32-70 ms of imports on every hook call (require of ./status, measured 2026-10-15) — only a stale gate needs them
    const { routerStatus } = require("./status") as typeof import("./status");
    const status = routerStatus();
    const gate: LinkGate = {
        version: 2,
        at: now,
        configMtimeMs,
        installed: status.installed,
        defaultHandler: status.defaultHandler,
        httpsHandler: status.httpsHandler,
        configured: status.configured,
        linkHost: status.linkHost,
        presets: Object.fromEntries(
            status.presets.map((row) => [
                row.id,
                { available: row.available, enabled: row.enabled, routed: row.routed, missing: row.missing },
            ])
        ),
    };

    try {
        mkdirSync(dirname(linkGatePath()), { recursive: true });
        writeFileSync(linkGatePath(), SafeJSON.stringify(gate));
    } catch {
        // A gate that cannot be saved is recomputed next time; the answer itself is still right.
    }

    return gate;
}
