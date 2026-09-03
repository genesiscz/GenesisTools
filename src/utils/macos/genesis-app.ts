import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";

/**
 * GenesisTools.app is a tiny signed launcher (src/macos/GenesisTools) that becomes the macOS TCC
 * "responsible process" for everything `tools` runs. Calendar, Reminders, Contacts, Full Disk
 * Access, Accessibility and Automation grants then attach to this one bundle instead of to the
 * terminal or launchd job that started the command.
 *
 * The bundle lives outside the repo in ~/Applications, so every checkout and worktree shares one
 * identity and the Full Disk Access "+" picker lists it under Applications without any path typing.
 * TCC keeps its rows across rebuilds and moves: the signature, not the path, is the key.
 */
export const GENESIS_APP_BUNDLE_ID = "com.genesiscz.genesistools";
export const GENESIS_APP_NAME = "GenesisTools";

/** Build manifest and prompt stamps; the bundle itself lives in ~/Applications. */
export function genesisAppDir(): string {
    return join(env.tools.getHome(), ".genesis-tools", "app");
}

export function genesisAppBundlePath(): string {
    return join(env.tools.getHome(), "Applications", `${GENESIS_APP_NAME}.app`);
}

export function genesisAppLauncherPath(): string {
    return join(genesisAppBundlePath(), "Contents", "MacOS", GENESIS_APP_NAME);
}

/** Written by the GenesisTools window's "Route tools through this app" switch, or `tools macos permissions disable`. */
export function genesisAppDisabledMarkerPath(): string {
    return join(genesisAppDir(), "disabled");
}

export function isGenesisAppDisabledByMarker(): boolean {
    return existsSync(genesisAppDisabledMarkerPath());
}

export function isRunningUnderGenesisApp(): boolean {
    return env.tools.getAppBundleId() === GENESIS_APP_BUNDLE_ID;
}

/** The launcher to prepend to a command, or null when the tree is already covered or the app is absent. */
export function genesisAppLauncher(): string | null {
    if (process.platform !== "darwin" || env.tools.isAppLauncherDisabled() || isRunningUnderGenesisApp()) {
        return null;
    }

    if (isGenesisAppDisabledByMarker()) {
        return null;
    }

    const launcher = genesisAppLauncherPath();
    return existsSync(launcher) ? launcher : null;
}

export function wrapWithGenesisApp(command: readonly string[]): string[] {
    const launcher = genesisAppLauncher();
    return launcher ? [launcher, ...command] : [...command];
}

function escapeXml(value: string): string {
    return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** `<array>…</array>` for a launchd ProgramArguments key, already routed through the launcher when available. */
export function launchdProgramArgumentsXml(command: readonly string[], indent = "  "): string {
    const items = wrapWithGenesisApp(command)
        .map((arg) => `${indent}  <string>${escapeXml(arg)}</string>`)
        .join("\n");
    return `${indent}<array>\n${items}\n${indent}</array>`;
}

/**
 * True when a plist written before GenesisTools.app existed (or with the launcher off) still runs
 * the bare command while the launcher is available now. Each service migrates on its next
 * user-triggered start; nothing rewrites a live job behind the user's back.
 */
export function launchdPlistNeedsGenesisApp(plistPath: string): boolean {
    const launcher = genesisAppLauncher();

    if (!launcher || !existsSync(plistPath)) {
        return false;
    }

    try {
        return !readFileSync(plistPath, "utf8").includes(launcher);
    } catch {
        return false;
    }
}

export const LAUNCHD_MIGRATION_HINT =
    "runs outside GenesisTools.app, so it cannot use the shared privacy grants; its next start migrates it";

export interface ResponsibleIdentity {
    kind: "genesis-app" | "host-app" | "unknown";
    /** bundle id of the process macOS holds responsible for this one */
    bundleId?: string;
}

/** Who macOS asks when this process touches Calendar, Reminders, files under TCC, and so on. */
export function responsibleIdentity(): ResponsibleIdentity {
    if (isRunningUnderGenesisApp()) {
        return { kind: "genesis-app", bundleId: GENESIS_APP_BUNDLE_ID };
    }

    const host = env.device.getHostBundleIdentifier();

    if (host) {
        return { kind: "host-app", bundleId: host };
    }

    return { kind: "unknown" };
}

export function describeResponsibleIdentity(): string {
    const identity = responsibleIdentity();

    switch (identity.kind) {
        case "genesis-app":
            return `GenesisTools.app (${identity.bundleId})`;
        case "host-app":
            return `the app "${identity.bundleId}" that launched tools`;
        default:
            return "the process that launched tools (under launchd that is the `bun` binary)";
    }
}
