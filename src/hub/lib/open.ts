import { spawnSync } from "node:child_process";
import { appStatus, buildApp } from "@app/macos/lib/permissions/app";
import { HUB_LINK_KEYS, schemeLink } from "@genesiscz/utils/browser-router/router-link";
import { logger } from "@genesiscz/utils/logger";
import { genesisAppBundlePath } from "@genesiscz/utils/macos/genesis-app";
import { genesisAppBuildHint } from "@genesiscz/utils/macos/xcode";
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
    /**
     * A commit sha (7 to 40 hex characters, a prefix is enough). With `pr` it is selected in that PR's
     * review; without it, `repo` names its project and it opens in the Worktrees mode's diff.
     */
    commit?: string;
    /** With `commit` and no `pr`: the commit's project, a checkout path or its forge path (`owner/repo`). */
    repo?: string;
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
    /** Live progress of the app build's `swift build` step (`BuildAppOptions.onProgress`). */
    onProgress?: (message: string) => void;
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

    if (options.repo) {
        args.push("--repo", options.repo);
    }

    if (options.commit) {
        args.push("--commit", options.commit);
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
 * `pr`, `reveal`, `repo`, `commit`, `tab`, `filter` and `worktree` as further query items (keys of
 * `HubRequest.linkKeys` in the app). A link without `worktree` and `reveal` lost them: `--print-url`
 * named neither. A commit link: `?pr=owner%2Frepo%2342&commit=<sha>`, or `?repo=<path>&commit=<sha>`.
 */
export function hubUrl(options: Pick<OpenHubOptions, (typeof HUB_LINK_KEYS)[number]>): string {
    // The link itself is built in the router utils, beside its https twin, so the two cannot drift.
    return schemeLink({
        preset: "genesis-hub",
        action: "open",
        data: Object.fromEntries(HUB_LINK_KEYS.map((key) => [key, options[key]])),
    });
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
            throw new Error(`${reason}; run without --no-build, or: ${genesisAppBuildHint()}`);
        }

        options.onStep?.(`${reason}: building it (about a minute on a cold build)`);
        logger.info({ reason }, "hub open: building GenesisTools.app");
        await buildApp({ onStep: options.onStep, onProgress: options.onProgress });
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
