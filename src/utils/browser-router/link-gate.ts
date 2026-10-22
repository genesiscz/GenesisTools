import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { moduleDir, requireSibling } from "@genesiscz/utils/fs/module-dir";
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

function isMissing(err: unknown): boolean {
    return typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT";
}

/** A failed gate read or write. Absent is normal; the logger loads only when there is something to say. */
function gateDiag(reason: string, err: unknown): void {
    // lazy: saves 12.5 ms cold import (tools ts imports analyze src/utils/logger.ts, 2026-10-15) — every link reads the gate
    const { logger }: typeof import("@genesiscz/utils/logger") = require("@genesiscz/utils/logger");

    logger.warn({ err, path: linkGatePath() }, reason);
}

/** The part of `routerStatus()` (./status) a gate keeps. */
interface RouterStatusFacts {
    installed: boolean;
    defaultHandler: boolean;
    httpsHandler: string | null;
    configured: boolean;
    linkHost: string | null;
    presets: Array<{ id: string; available: boolean; enabled: boolean; routed: boolean; missing: string[] }>;
}

/**
 * `routerStatus` from ./status, loaded only for a stale gate: it saves 32-70 ms of imports on every hook call
 * (measured 2026-10-15). The path is built at run time so a bundler or the type checker that follows this file (a
 * copy of the link helpers in another repo) does not pull in the router, its presets and the browser-extension
 * profiles behind it.
 */
function loadRouterStatus(): () => RouterStatusFacts {
    const loaded: unknown = requireSibling(import.meta, "status");
    const routerStatus = (loaded as { routerStatus?: unknown } | null)?.routerStatus;
    if (typeof routerStatus !== "function") {
        throw new Error(`link gate: ${join(moduleDir(import.meta), "status")} exports no routerStatus`);
    }

    return routerStatus as () => RouterStatusFacts;
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
    } catch (err) {
        // No gate yet is normal. A gate that is there and cannot be read is why the next call is slow.
        if (!isMissing(err)) {
            gateDiag("Could not read the link gate", err);
        }
    }

    const status = loadRouterStatus()();
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
    } catch (err) {
        gateDiag("Could not save the link gate", err);
    }

    return gate;
}
