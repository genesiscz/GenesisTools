import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isInteractive } from "@genesiscz/utils/cli";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import {
    genesisAppBundlePath,
    genesisAppInstallDir,
    installedGenesisAppLauncher,
    isGenesisAppBundleInstalled,
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

/** Live readers of this machine. Each one is cheap, reads only, and starts no process. Tests pass a fake. */
export interface Facts {
    platform(): NodeJS.Platform;
    isTest(): boolean;
    appBundle(): { installed: boolean; routingOff: boolean; path: string };
    appManifest(): AppManifestFacts | null;
    hasDisplay(): boolean;
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
    platform: () => process.platform,
    isTest: () => isTestProcess(),
    appBundle: () => {
        const installed = isGenesisAppBundleInstalled();
        // installedGenesisAppLauncher is null when the bundle is missing or routing is switched off.
        return {
            installed,
            routingOff: installed && installedGenesisAppLauncher() === null,
            path: genesisAppBundlePath(),
        };
    },
    appManifest: readAppManifest,
    hasDisplay: () => {
        if (env.get("SSH_CONNECTION") || env.get("SSH_TTY")) {
            return false;
        }

        return process.platform === "darwin" || process.platform === "win32" || env.device.hasGraphicalDisplay();
    },
    hasTerminal: () => isInteractive(),
};
