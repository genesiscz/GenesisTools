import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveEnvHost } from "@genesiscz/utils/agent/identity/env";
import { isInteractive } from "@genesiscz/utils/cli";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import {
    genesisAppBundlePath,
    genesisAppInstallDir,
    genesisAppLauncherPath,
    isGenesisAppBundleInstalled,
    isGenesisAppRoutingOff,
} from "@genesiscz/utils/macos/genesis-app";
import { isTestProcess } from "@genesiscz/utils/test-process";

/** What the install manifest (`~/.genesis-tools/app/manifest.json`) says about the installed build. */
export interface AppManifestFacts {
    /** `<sourceHash>@<builtAt>`: a state value read under another build id is not used. */
    buildId: string;
    /** The parts the build links; null in a build from before parts existed, which links every part. */
    parts: string[] | null;
    /** The `--rpc` methods the build answers; null in a build from before 2026-11-17, which did not write them. */
    rpcMethods: string[] | null;
}

/**
 * Live readers of this machine. Each one reads only. All but `hasDisplay` are synchronous and start no process;
 * `hasDisplay` asks `ioreg` on macOS, so it is async and never holds the event loop. Tests pass a fake.
 */
export interface Facts {
    isAgent(): boolean;
    platform(): NodeJS.Platform;
    isTest(): boolean;
    /**
     * The bundle at `path`: `installed` when its folder is there, `launcher` when its `Contents/MacOS` executable is
     * there too (missing after an interrupted install), `routingOff` when `GENESIS_TOOLS_NO_APP=1` or the window's
     * switch keeps `tools` from running through it, whatever is on disk.
     */
    appBundle(): { installed: boolean; launcher: boolean; routingOff: boolean; path: string };
    appManifest(): AppManifestFacts | null;
    hasDisplay(): Promise<boolean>;
    hasTerminal(): boolean;
}

function stringList(value: unknown): string[] | null {
    return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value : null;
}

/** Reads a manifest's text; null when it is not a manifest. */
export function parseAppManifest(text: string): AppManifestFacts | null {
    const raw: unknown = SafeJSON.parse(text, { strict: true });

    if (typeof raw !== "object" || raw === null || !("sourceHash" in raw) || !("builtAt" in raw)) {
        return null;
    }

    return {
        buildId: `${String(raw.sourceHash)}@${String(raw.builtAt)}`,
        parts: "parts" in raw ? stringList(raw.parts) : null,
        rpcMethods: "rpcMethods" in raw ? stringList(raw.rpcMethods) : null,
    };
}

function readAppManifest(): AppManifestFacts | null {
    const path = join(genesisAppInstallDir(), "manifest.json");

    if (!existsSync(path)) {
        return null;
    }

    try {
        return parseAppManifest(readFileSync(path, "utf8"));
    } catch (error) {
        logger.warn({ error, path }, "genesis-tools facts: the app manifest is unreadable");
        return null;
    }
}

export const LIVE_FACTS: Facts = {
    isAgent: () => resolveEnvHost(env.getProcessEnv()).isInAgent === true,
    platform: () => process.platform,
    isTest: () => isTestProcess(),
    appBundle: () => {
        const installed = isGenesisAppBundleInstalled();
        return {
            installed,
            launcher: installed && existsSync(genesisAppLauncherPath()),
            routingOff: isGenesisAppRoutingOff(),
            path: genesisAppBundlePath(),
        };
    },
    appManifest: readAppManifest,
    hasDisplay: async () => {
        if (env.get("SSH_CONNECTION") || env.get("SSH_TTY")) {
            return false;
        }

        if (process.platform === "darwin") {
            const proc = Bun.spawn(["/usr/sbin/ioreg", "-n", "Root", "-d", "1"], {
                stdout: "pipe",
                stderr: "ignore",
                timeout: 2000,
            });
            const [exit, text] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
            if (exit !== 0) {
                logger.debug({ exit }, "display probe did not answer");
                return false;
            }
            return !/"CGSSessionScreenIsLocked"\s*=\s*(?:Yes|true)/i.test(text) && /IOConsoleUsers/.test(text);
        }
        return process.platform === "win32" || env.device.hasGraphicalDisplay();
    },
    hasTerminal: () => isInteractive(),
};
