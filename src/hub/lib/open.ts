import { spawnSync } from "node:child_process";
import { appStatus, buildApp } from "@app/macos/lib/permissions/app";
import { logger } from "@genesiscz/utils/logger";
import { genesisAppBundlePath } from "@genesiscz/utils/macos/genesis-app";
import { hubStatus } from "./proposal";

export const HUB_MODES = ["sessions", "worktrees", "prs", "inbox", "timeline", "agents"] as const;
export type HubMode = (typeof HUB_MODES)[number];
export const HUB_TABS = ["transcript", "changes", "decisions"] as const;
export type HubTab = (typeof HUB_TABS)[number];

export interface OpenHubOptions {
    mode?: HubMode;
    session?: string;
    /**
     * Open this agent in the Agents mode: a Claude agent id (`aE-sharedkit-4743…`) or a codex/grok
     * worker name. With `session` it is looked up under that parent; alone, the hub searches every
     * parent. The hub switches to the Agents mode itself.
     */
    agent?: string;
    /** `42`, `#42`, or with its project: `group/app#42`, `app!12` (numbers repeat across projects), or a PR page URL. */
    pr?: string;
    /** With `pr`: this repo-relative file opens in that PR's review. */
    reveal?: string;
    /** Opens the Worktrees mode on this checkout folder. */
    worktree?: string;
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
    /** Opens the notification rules panel. */
    rules?: boolean;
    /** Opens the ⌘⇧P prompt picker. */
    prompts?: boolean;
    /** Opens the handoff composer for `session` (or the selected session). */
    handoff?: boolean;
    /** false keeps the window behind whatever is in front (`--no-activate`). */
    activate?: boolean;
    /** false never builds; a missing or stale app is then an error. */
    build?: boolean;
    /** With `build: false`: an app older than its Swift sources still opens (a browser click must not wait on a build). */
    staleOk?: boolean;
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

    if (options.agent) {
        args.push("--agent", options.agent);
    }

    if (options.pr !== undefined) {
        args.push("--pr", options.pr);

        if (options.reveal) {
            args.push("--reveal", options.reveal);
        }
    }

    if (options.worktree) {
        args.push("--worktree", options.worktree);
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

    if (options.rules) {
        args.push("--rules");
    }

    if (options.prompts) {
        args.push("--prompts");
    }

    if (options.handoff) {
        args.push("--handoff");
    }

    if (options.activate === false) {
        args.push("--no-activate");
    }

    return args;
}

/**
 * The same target as a link: `genesis-tools://hub?session=<parent>&agent=<child>`, with `mode`,
 * `pr`, `tab` and `filter` as further query items (the set the app's URL handler reads).
 */
export function hubUrl(options: Pick<OpenHubOptions, "mode" | "session" | "agent" | "pr" | "tab" | "filter">): string {
    // encodeURIComponent, not URLSearchParams: that writes a space as `+`, which Foundation's
    // URLComponents reads back as a literal plus.
    const query: string[] = [];
    for (const key of ["mode", "session", "agent", "pr", "tab", "filter"] as const) {
        const value = options[key];
        if (value !== undefined && value !== "") {
            query.push(`${key}=${encodeURIComponent(value)}`);
        }
    }

    return query.length > 0 ? `genesis-tools://hub?${query.join("&")}` : "genesis-tools://hub";
}

/** Why the installed app cannot serve the hub as it is, or undefined when it can. */
export function buildReason({ staleOk = false }: { staleOk?: boolean } = {}): string | undefined {
    const status = appStatus();

    if (!status.built) {
        return "GenesisTools.app is not built";
    }

    if (status.stale && !staleOk) {
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
    const reason = buildReason({ staleOk: options.build === false && options.staleOk === true });
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
