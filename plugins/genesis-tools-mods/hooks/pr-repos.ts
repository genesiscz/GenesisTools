// Which repository a PR number of a reply means, for the link fixer (`links.tsx`). The session's folder alone does not
// say it: one session can work in several checkouts (a workspace folder that holds a frontend and a backend), and its
// shell folder moves between them, so on 2026-10-26 one session's `#900` was linked to the backend at one time and to
// the frontend at another, while the reply had linked `#900` to the frontend itself. The reply's words decide first: a
// repository written at the number (`owner/repo#900`, `web#900`), the same number linked before (in this reply, then
// in the session's earlier messages), the nearest repository the reply names (a forge URL, a hub link, a path inside a
// checkout), and only then the remote of the session's checkout. Standalone, as every runtime plugin file.
import { type ForgeProject, forgeProject } from "./commit-links";
import type { Host } from "./shared";

/** A repository a line names: a forge or hub URL, `owner/repo#12` or `name#12`, or a path inside a checkout. */
export interface RepoMention {
    /** Where it starts in its line. */
    start: number;
    /** The project, when the text names it whole; a bare `name#12` and a path are resolved on demand. */
    project?: ForgeProject;
    /** `web` of `web#12`: a repository written without its owner. */
    name?: string;
    /** An absolute path (or one under `~/`), whose checkout's `origin` names the project. */
    path?: string;
    /** The PR, issue or MR number the link or the reference names. */
    number?: number;
}

const LINK_URL = /(?:https?|genesis-tools):\/\/[^\s)<>"'`\]]+/g;

/** `owner/repo#12` or `repo#12`: a PR number with its repository written at it. */
export const QUALIFIED_PR = /(?<![\w/.@&#-])(?:([A-Za-z0-9][\w.-]*)\/)?([A-Za-z][\w.-]*\w)#(\d{1,6})\b/g;

const ABSOLUTE = /(?:~\/|\/(?:Users|tmp|private|opt|var|Applications|Library|Volumes)\/)[^\s`'"()<>[\]|,;&?#]+/g;

/** GitHub pages that are no repository: `github.com/orgs/acme` names no `orgs/acme` project. */
const NOT_OWNERS = new Set([
    "orgs",
    "settings",
    "notifications",
    "marketplace",
    "sponsors",
    "apps",
    "features",
    "topics",
    "search",
    "pulls",
    "issues",
    "login",
    "users",
    "enterprises",
    "site",
    "about",
    "collections",
    "trending",
    "explore",
]);

/** The project and number a forge URL or a hub link (`pr=owner%2Frepo%2312`) names; undefined for any other URL. */
export function urlProject(
    url: string,
    githubHost = "github.com"
): { project: ForgeProject; number?: number } | undefined {
    let parsed: URL;

    try {
        parsed = new URL(url.replace(/&amp;/g, "&"));
    } catch {
        return undefined;
    }

    const host = parsed.hostname.toLowerCase();
    const segments = parsed.pathname.split("/").filter(Boolean);
    const hub = parsed.protocol === "genesis-tools:" ? host === "hub" : segments.length === 1 && segments[0] === "hub";

    if (hub) {
        const [, path, mark, n] = /^(.+?)([#!])(\d+)$/.exec(parsed.searchParams.get("pr") ?? "") ?? [];

        if (!path || !n) {
            return undefined;
        }

        const kind = mark === "!" ? "gitlab" : "github";
        return { project: { kind, host: kind === "github" ? githubHost : "", path }, number: Number(n) };
    }

    if (host === "github.com" || host === githubHost) {
        const [owner, repo, page, n] = segments;

        if (!owner || !repo || NOT_OWNERS.has(owner.toLowerCase())) {
            return undefined;
        }

        const number = (page === "pull" || page === "issues") && /^\d+$/.test(n ?? "") ? Number(n) : undefined;
        return { project: { kind: "github", host, path: `${owner}/${repo.replace(/\.git$/, "")}` }, number };
    }

    if (host.includes("gitlab")) {
        const dash = segments.indexOf("-");
        const path = (dash === -1 ? segments : segments.slice(0, dash)).join("/").replace(/\.git$/, "");
        const n = dash === -1 ? undefined : segments[dash + 2];

        if (!path.includes("/")) {
            return undefined;
        }

        const number = segments[dash + 1] === "merge_requests" && /^\d+$/.test(n ?? "") ? Number(n) : undefined;
        return { project: { kind: "gitlab", host, path }, number };
    }

    return undefined;
}

/** The repositories one line names, in the order they stand. `githubHost`: the session checkout's GitHub host. */
export function mentionsIn(line: string, githubHost = "github.com"): RepoMention[] {
    const found: RepoMention[] = [];

    for (const match of line.matchAll(LINK_URL)) {
        const named = urlProject(match[0], githubHost);

        if (named) {
            found.push({ start: match.index ?? 0, ...named });
        }
    }

    for (const match of line.matchAll(QUALIFIED_PR)) {
        const [, owner, name, n] = match;

        if (!name || !n) {
            continue;
        }

        const start = match.index ?? 0;
        found.push(
            owner
                ? { start, project: { kind: "github", host: githubHost, path: `${owner}/${name}` }, number: Number(n) }
                : { start, name, number: Number(n) }
        );
    }

    for (const match of line.matchAll(ABSOLUTE)) {
        found.push({ start: match.index ?? 0, path: match[0] });
    }

    return found.sort((a, b) => a.start - b.start);
}

/**
 * What the session's earlier messages say: the GitHub PR numbers they linked with their repository (the latest
 * wins), and every project they named whole.
 */
export function sessionRepos(
    texts: readonly string[],
    githubHost = "github.com"
): { linked: Map<number, ForgeProject>; named: ForgeProject[] } {
    const linked = new Map<number, ForgeProject>();
    const named = new Map<string, ForgeProject>();

    for (const text of texts) {
        for (const mention of mentionsIn(text, githubHost)) {
            if (!mention.project) {
                continue;
            }

            named.set(`${mention.project.kind}:${mention.project.path.toLowerCase()}`, mention.project);

            if (mention.number !== undefined && mention.project.kind === "github") {
                linked.set(mention.number, mention.project);
            }
        }
    }

    return { linked, named: [...named.values()] };
}

/**
 * The known GitHub project a repository name without its owner means; undefined when none or two known projects
 * have that name.
 */
export function projectNamed(name: string, known: readonly ForgeProject[]): ForgeProject | undefined {
    const wanted = name.toLowerCase();
    const matches = new Map<string, ForgeProject>();

    for (const project of known) {
        if (project.kind === "github" && project.path.split("/").pop()?.toLowerCase() === wanted) {
            matches.set(project.path.toLowerCase(), project);
        }
    }

    return matches.size === 1 ? [...matches.values()][0] : undefined;
}

/**
 * A guess for `web#12` when no known project is named `web`: the session project's owner with that name. Only the
 * reference itself may use it, after `gh` confirms the PR; a guess never names the repository of another number.
 */
export function sameOwner(name: string, home: ForgeProject | undefined): ForgeProject | undefined {
    const owner = home?.kind === "github" ? home.path.split("/")[0] : undefined;

    return home && owner ? { kind: "github", host: home.host, path: `${owner}/${name}` } : undefined;
}

const pathProjects = new Map<string, Promise<ForgeProject | undefined>>();
const rootProjects = new Map<string, Promise<ForgeProject | undefined>>();

/** Forgets the checkouts read so far (tests). */
export function forgetRepoMentions(): void {
    pathProjects.clear();
    rootProjects.clear();
}

/** The forge project of the checkout an absolute path lies in (its `origin`); undefined outside a checkout. */
export function projectOfPath(host: Host, path: string, home: string): Promise<ForgeProject | undefined> {
    const absolute = path.startsWith("~/") ? `${home}${path.slice(1)}` : path;
    const clean = absolute
        .replace(/[.,:;!?]+$/, "")
        .replace(/:\d+(-\d+)?$/, "")
        .replace(/\/+$/, "");
    let held = pathProjects.get(clean);

    if (!held) {
        held = checkoutProject(host, clean);
        pathProjects.set(clean, held);
    }

    return held;
}

async function checkoutProject(host: Host, path: string): Promise<ForgeProject | undefined> {
    let dir: string | undefined = path;

    // A file names its folder; a path that is gone names the nearest folder above it that is not.
    for (let up = 0; dir && up < 4; up++) {
        const stat = await host.stat(dir).catch(() => undefined);

        if (stat?.kind === "dir") {
            break;
        }

        const parent: string = dir.slice(0, dir.lastIndexOf("/"));
        dir = parent.length > 1 && up < 3 ? parent : undefined;
    }

    if (!dir) {
        return undefined;
    }

    const top = await host
        .run(["git", "-C", dir, "rev-parse", "--show-toplevel"], { timeoutMs: 3_000 })
        .catch(() => undefined);
    const root = top?.exitCode === 0 ? top.stdout.trim() : "";

    if (!root) {
        return undefined;
    }

    let held = rootProjects.get(root);

    if (!held) {
        held = host
            .run(["git", "-C", root, "remote", "get-url", "origin"], { timeoutMs: 3_000 })
            .then((origin) => (origin.exitCode === 0 ? forgeProject(origin.stdout) : undefined))
            .catch(() => undefined);
        rootProjects.set(root, held);
    }

    return held;
}
