import { basename } from "node:path";
import { isHubCommitSha, isHubPrRef } from "../pr-ref";
import { type NavTarget, normalizeTarget } from "./types";

/** The query of a hub link, `genesis-tools://hub?…` or `https://<link host>/hub?…`; undefined for anything else. */
function hubLinkQuery(input: string): URLSearchParams | undefined {
    if (!URL.canParse(input)) {
        return undefined;
    }

    const url = new URL(input);

    if (url.protocol === "genesis-tools:") {
        // `genesis-tools://hub?…` parses with `hub` as the host; some builders write `genesis-tools:hub?…`.
        return url.host === "hub" || url.pathname.replace(/^\/+/, "") === "hub" ? url.searchParams : undefined;
    }

    if ((url.protocol === "https:" || url.protocol === "http:") && /^\/hub\/?$/.test(url.pathname)) {
        return url.searchParams;
    }

    return undefined;
}

export type ParsedNavInput = { target: NavTarget; actor?: string; note?: string; from?: string } | { error: string };

/**
 * What `tools hub nav open <link-or-target>` names: a hub link (its `actor`, `note` and `from` come along), a PR or MR
 * page, a PR ref (`#563`, `group/app!12`), a commit sha (needs `--pr` or `--repo` beside it), or a checkout folder.
 */
export function parseNavInput(input: string, isFolder: (path: string) => boolean): ParsedNavInput {
    const text = input.trim();

    if (text === "") {
        return { target: {} };
    }

    const query = hubLinkQuery(text);

    if (query) {
        const raw: Record<string, string> = {};

        for (const [key, value] of query) {
            raw[key] = value;
        }

        return {
            target: normalizeTarget(raw),
            actor: query.get("actor") ?? undefined,
            note: query.get("note") ?? undefined,
            from: query.get("from") ?? undefined,
        };
    }

    if (isHubPrRef(text)) {
        return { target: { pr: text } };
    }

    if (isHubCommitSha(text)) {
        return { target: { commit: text } };
    }

    if (isFolder(text)) {
        return { target: { worktree: text } };
    }

    return {
        error: `${text} is not a hub link, a PR (#563, group/app!12, a PR page), a commit sha or a checkout folder`,
    };
}

/** What a place is, in a few words, until the hub names it better ("PR #563 · commit 0751d8a971"). */
export function navTitle(target: NavTarget): string {
    const commit = target.commit
        ? `commit ${target.commit
              .split("..")
              .map((sha) => sha.slice(0, 10))
              .join("..")}`
        : "";

    if (target.pr) {
        const pr = /^\d+$/.test(target.pr) ? `#${target.pr}` : target.pr.replace(/^https?:\/\/[^/]+\//, "");
        return [`PR ${pr}`, commit].filter(Boolean).join(" · ");
    }

    if (target.repo && commit) {
        return `${commit} in ${basename(target.repo)}`;
    }

    if (target.worktree) {
        return target.worktree === "cleanup" ? "worktree cleanup" : `worktree ${basename(target.worktree)}`;
    }

    if (target.agent) {
        return `agent ${target.agent}`;
    }

    if (target.session) {
        return `session ${target.session.slice(0, 8)}`;
    }

    return target.mode ? target.mode[0].toUpperCase() + target.mode.slice(1) : "Hub";
}

/** Why the place cannot open as given (the same rules as `tools hub open`); undefined when it can. */
export function navTargetProblem(target: NavTarget): string | undefined {
    if (Object.keys(target).length === 0) {
        return "name a place: a hub link, --pr, --commit with --repo, --worktree, --session or --mode";
    }

    if (target.pr !== undefined && !isHubPrRef(target.pr)) {
        return `--pr takes 42, #42, <project>#42 or a PR page URL, got ${target.pr}`;
    }

    if (target.commit !== undefined && !isHubCommitSha(target.commit)) {
        return `--commit takes a sha of 7 to 40 hex characters, or <from>..<to>, got ${target.commit}`;
    }

    if (target.commit !== undefined && target.pr === undefined && target.repo === undefined) {
        return "--commit needs the PR it is in (--pr) or its project (--repo <path|owner/repo>)";
    }

    return undefined;
}
