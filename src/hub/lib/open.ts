import { spawnSync } from "node:child_process";
import { appStatus, buildApp } from "@app/macos/lib/permissions/app";
import { logger } from "@genesiscz/utils/logger";
import { genesisAppBundlePath } from "@genesiscz/utils/macos/genesis-app";
import { hubStatus } from "./proposal";

export const HUB_MODES = ["sessions", "worktrees", "prs", "inbox", "timeline"] as const;
export type HubMode = (typeof HUB_MODES)[number];
export const HUB_TABS = ["transcript", "changes", "decisions"] as const;
export type HubTab = (typeof HUB_TABS)[number];

export interface OpenHubOptions {
    mode?: HubMode;
    session?: string;
    /** `42`, `#42`, or with its project: `group/app#42`, `app!12` (numbers repeat across projects). */
    pr?: string;
    tab?: HubTab;
    /** The session list filter, which also searches every project's history. */
    filter?: string;
    /** Opens the command palette with this text ("gt pr 424"). */
    palette?: string;
    /** Opens find in files with this query. */
    find?: string;
    /** Opens the transcript search over every session (⌥⌘F) with this text. */
    sessionSearch?: string;
    /** Opens the Today digest (⌥⌘D). */
    digest?: boolean;
    /** false keeps the window behind whatever is in front (`--no-activate`). */
    activate?: boolean;
    /** false never builds; a missing or stale app is then an error. */
    build?: boolean;
    onStep?: (message: string) => void;
}

export interface OpenHubResult {
    built: boolean;
    reason?: string;
    args: string[];
}

/** The `GenesisTools --hub` arguments for these options (see Sources/Hub/HubWindow.swift). */
export function hubArgs(options: OpenHubOptions): string[] {
    const args = ["--hub"];

    if (options.mode) {
        args.push("--mode", options.mode);
    }

    if (options.session) {
        args.push("--session", options.session);
    }

    if (options.pr !== undefined) {
        args.push("--pr", options.pr);
    }

    if (options.tab) {
        args.push("--tab", options.tab);
    }

    for (const [flag, value] of [
        ["--filter", options.filter],
        ["--palette", options.palette],
        ["--find", options.find],
        ["--session-search", options.sessionSearch],
    ] as const) {
        if (value !== undefined) {
            args.push(flag, value);
        }
    }

    if (options.digest) {
        args.push("--digest");
    }

    if (options.activate === false) {
        args.push("--no-activate");
    }

    return args;
}

/** Why the installed app cannot serve the hub as it is, or undefined when it can. */
export function buildReason(): string | undefined {
    const status = appStatus();

    if (!status.built) {
        return "GenesisTools.app is not built";
    }

    if (status.stale) {
        return "GenesisTools.app is older than its Swift sources";
    }

    const hub = hubStatus();
    return hub.available ? undefined : hub.reason;
}

/**
 * Builds GenesisTools.app when it is missing or stale, then starts the hub through Launch Services
 * (`open -n`), so the hub lives in the login session rather than under this terminal. A hub that
 * already runs takes the arguments and comes forward instead of a second window opening.
 */
export async function openHub(options: OpenHubOptions): Promise<OpenHubResult> {
    const reason = buildReason();
    let built = false;

    if (reason) {
        if (options.build === false) {
            throw new Error(`${reason}; run without --no-build, or: tools macos permissions build`);
        }

        options.onStep?.(`${reason}: building it (about a minute on a cold build)`);
        logger.info({ reason }, "hub open: building GenesisTools.app");
        await buildApp({ onStep: options.onStep });
        built = true;
    }

    const args = hubArgs(options);
    const openArgs = ["-n", ...(options.activate === false ? ["-g"] : []), genesisAppBundlePath(), "--args", ...args];
    logger.info({ openArgs }, "hub open: open");
    const result = spawnSync("open", openArgs, { encoding: "utf8" });

    if (result.status !== 0) {
        throw new Error(`open failed (${result.status}): ${(result.stderr || result.error?.message || "").trim()}`);
    }

    return { built, reason, args };
}
