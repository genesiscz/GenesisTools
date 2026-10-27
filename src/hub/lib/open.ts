import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { appStatus, buildApp } from "@app/macos/lib/permissions/app";
import { HUB_LINK_KEYS, routerLink, schemeLink } from "@genesiscz/utils/browser-router/router-link";
import { logger } from "@genesiscz/utils/logger";
import { genesisAppBundlePath } from "@genesiscz/utils/macos/genesis-app";
import { genesisAppBuildHint } from "@genesiscz/utils/macos/xcode";
import { expandTilde } from "@genesiscz/utils/paths";
import { hubStatus } from "./proposal";

export const HUB_MODES = ["sessions", "worktrees", "prs", "inbox", "timeline", "agents"] as const;
export type HubMode = (typeof HUB_MODES)[number];
export const HUB_TABS = ["transcript", "changes", "files", "decisions"] as const;
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
     * A commit sha (7 to 40 hex characters, a prefix is enough), or `<from>..<to>`: a run of commits with both
     * ends included. With `pr` it is selected in that PR's review; without it, `repo` names its project and it
     * opens in the Worktrees mode's diff.
     */
    commit?: string;
    /** With `commit` and no `pr`: the commit's project, a checkout path or its forge path (`owner/repo`). */
    repo?: string;
    /** Opens the Worktrees mode on this checkout folder. */
    worktree?: string;
    /** Opens the Inbox at this decision or todo card (`d_3_<session>`). */
    decision?: string;
    /** Opens the Inbox at this pending form (`ask_…`). */
    question?: string;
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
    /** Who asked for this place, for the hub's history: `user`, `agent` or `link` (the hub's default). */
    actor?: string;
    /** Why the place was opened; the history list shows it under the place. */
    note?: string;
    /** The agent session that asked for it. */
    from?: string;
    /** The history entry `tools hub nav open` already stored, so the hub updates it instead of adding one. */
    nav?: string;
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

/** Explicit relative checkouts are relative to the CLI caller, not the app's Launch Services cwd. */
function repoTarget(repo: string): string {
    return /^\.{1,2}(?:[/\\]|$)/.test(repo) ? resolve(repo) : repo;
}

/**
 * A worktree flag as the app compares it: `cleanup` and `cleanup-blocked` stay; a path is made absolute against the
 * caller's folder (the app's own folder is `/`), with `~` expanded and a trailing slash gone. The app resolves symlinks
 * and the checkout's top folder itself (`/tmp` is `/private/tmp` to git).
 */
export function worktreeTarget(worktree: string): string {
    return worktree === "cleanup" || worktree === "cleanup-blocked" ? worktree : resolve(expandTilde(worktree));
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
        args.push("--repo", repoTarget(options.repo));
    }

    if (options.commit) {
        args.push("--commit", options.commit);
    }

    if (options.worktree) {
        args.push("--worktree", worktreeTarget(options.worktree));
    }

    if (options.tab) {
        args.push("--tab", options.tab);
    }

    for (const [flag, value] of [
        ["--decision", options.decision],
        ["--question", options.question],
    ] as const) {
        if (value) {
            args.push(flag, value);
        }
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

    for (const [flag, value] of [
        ["--actor", options.actor],
        ["--note", options.note],
        ["--from", options.from],
        ["--nav", options.nav],
    ] as const) {
        if (value) {
            args.push(flag, value);
        }
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
 * named neither. A commit link: `?pr=owner%2Frepo%2342&commit=<sha>` (or `<from>..<to>`), or `?repo=<path>&commit=<sha>`.
 */
export function hubUrl(options: Pick<OpenHubOptions, (typeof HUB_LINK_KEYS)[number]>): string {
    // The link itself is built in the router utils, beside its https twin, so the two cannot drift.
    return schemeLink({ preset: "genesis-hub", action: "open", data: hubLinkData(options) });
}

/**
 * The link to print for a place (`--print-url`): the https link where the router serves `/hub` on this Mac, as the
 * agents' rule writes it, else the app's own `genesis-tools://hub?…` (`hubUrl`).
 */
export function hubPrintUrl(options: Pick<OpenHubOptions, (typeof HUB_LINK_KEYS)[number]>): string {
    const data = hubLinkData(options);
    return routerLink({
        preset: "genesis-hub",
        action: "open",
        data,
        fallback: () => schemeLink({ preset: "genesis-hub", action: "open", data }),
    }).result;
}

function hubLinkData(
    options: Pick<OpenHubOptions, (typeof HUB_LINK_KEYS)[number]>
): Record<string, string | undefined> {
    return Object.fromEntries(
        HUB_LINK_KEYS.map((key) => {
            const value = options[key];

            if (key === "repo" && value) {
                return [key, repoTarget(value)];
            }

            return [key, key === "worktree" && value ? worktreeTarget(value) : value];
        })
    );
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

    if (!status.parts.includes("hub")) {
        return "GenesisTools.app was built without the hub part";
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
        // The installed parts plus the hub (src/macos/lib/permissions/parts.ts): a host-only install gains it here.
        await buildApp({ onStep: options.onStep, onProgress: options.onProgress, parts: { add: ["hub"] } });
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
