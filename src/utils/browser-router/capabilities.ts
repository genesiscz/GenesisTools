import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { GENESIS_APP_BUNDLE_ID, genesisAppBundlePath } from "@genesiscz/utils/macos/genesis-app";

/** What a preset needs on this Mac before its routes are written and its links are offered. */
export type Capability =
    | "browser-router:installed"
    | "browser-router:default"
    | "cmux:installed"
    | "claude:installed"
    | "codex:installed"
    | `file:${string}`;

export type CapabilityCheck = (capability: Capability) => boolean;

const CMUX_PATHS = [join(homedir(), ".local/bin/cmux"), "/opt/homebrew/bin/cmux", "/usr/local/bin/cmux"];

export function cmuxBinary(): string | undefined {
    return CMUX_PATHS.find((path) => existsSync(path));
}

const cache = new Map<Capability, boolean>();

/** Evaluated once per process: a capability does not change while one command runs. */
export function hasCapability(capability: Capability): boolean {
    const known = cache.get(capability);

    if (known !== undefined) {
        return known;
    }

    const value = evaluate(capability);
    cache.set(capability, value);
    return value;
}

function evaluate(capability: Capability): boolean {
    if (capability.startsWith("file:")) {
        return existsSync(capability.slice("file:".length));
    }

    switch (capability) {
        case "browser-router:installed":
            return existsSync(genesisAppBundlePath());
        case "browser-router:default":
            return httpsHandler() === GENESIS_APP_BUNDLE_ID;
        case "cmux:installed":
            return cmuxBinary() !== undefined;
        case "claude:installed":
            return Bun.which("claude") !== null;
        case "codex:installed":
            return Bun.which("codex") !== null;
        default:
            return false;
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

let handler: string | null | undefined;

/**
 * The bundle id macOS opens https links with, read from the Launch Services preferences
 * (`plutil`, about 4 ms). Null when nothing is recorded or the file cannot be read.
 */
export function httpsHandler(): string | null {
    if (handler !== undefined) {
        return handler;
    }

    handler = readHttpsHandler();
    return handler;
}

function readHttpsHandler(): string | null {
    if (process.platform !== "darwin") {
        return null;
    }

    const plist = join(homedir(), "Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist");
    const run = Bun.spawnSync(["plutil", "-extract", "LSHandlers", "json", "-o", "-", plist], {
        stdout: "pipe",
        stderr: "pipe",
    });

    if (run.exitCode !== 0) {
        logger.debug({ plist, stderr: run.stderr.toString() }, "browser-router: no Launch Services handlers");
        return null;
    }

    try {
        const rows: unknown = SafeJSON.parse(run.stdout.toString(), { strict: true });

        if (!Array.isArray(rows)) {
            return null;
        }

        for (const row of rows) {
            if (isRecord(row) && row.LSHandlerURLScheme === "https") {
                return typeof row.LSHandlerRoleAll === "string" ? row.LSHandlerRoleAll : null;
            }
        }

        return null;
    } catch (error) {
        logger.debug({ error, plist }, "browser-router: Launch Services handlers are not JSON");
        return null;
    }
}
