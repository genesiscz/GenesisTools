// Which repository a PR number of a reply means, for the link fixer (`links.tsx`). The session's folder alone does not
// say it: one session can work in several checkouts (a workspace folder that holds a frontend and a backend), and its
// shell folder moves between them, so on 2026-10-26 one session's `#900` was linked to the backend at one time and to
// the frontend at another, while the reply had linked `#900` to the frontend itself. The reply's words decide first: a
// repository written at the number (`owner/repo#900`, `web#900`), the same number linked before (in this reply, then
// in the session's earlier messages), the nearest repository the reply names (a forge URL, a hub link, a path inside a
// checkout, or a known repository's name as a plain word in the same line), and only then the remote of the session's
// checkout. On 2026-10-27 a session working in two checkouts wrote "GenesisPlayground is pushed, and its one fix is in
// #102 (fix(tools): ...)", and #102 was linked in the other checkout's repository: so the plain name counts, and a
// session in several checkouts with no such word links a number only when the title the reply wrote after it matches
// that repository's PR. Standalone, as every runtime plugin file.
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
    /** Named by its repository name as a plain word: counts in its own line only. */
    byName?: boolean;
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
 * The known projects a line names by their repository name alone, as a plain word ("GenesisPlayground is pushed").
 * Case-sensitive and whole-word, and never inside a path or a URL (`/GenesisPlayground/`, `x/GenesisPlayground`),
 * which `mentionsIn` reads itself. Only a name two known GitHub projects share is skipped.
 */
export function namesIn(line: string, known: readonly ForgeProject[]): RepoMention[] {
    const byName = new Map<string, ForgeProject | null>();

    for (const project of known) {
        const name = project.kind === "github" ? project.path.split("/").pop() : undefined;

        if (!name) {
            continue;
        }

        const held = byName.get(name);
        byName.set(
            name,
            held === null ||
                (held &&
                    (held.host.toLowerCase() !== project.host.toLowerCase() ||
                        held.path.toLowerCase() !== project.path.toLowerCase()))
                ? null
                : project
        );
    }

    const found: RepoMention[] = [];

    for (const [name, project] of byName) {
        if (!project) {
            continue;
        }

        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

        for (const match of line.matchAll(new RegExp(`(?<![\\w/.#@-])${escaped}(?![\\w/#-])`, "g"))) {
            found.push({ start: match.index ?? 0, project, byName: true });
        }
    }

    return found.sort((a, b) => a.start - b.start);
}

/**
 * Whether the text a reply wrote after a PR number (`#102 (fix(tools): replace @inquirer…)`) is that PR's title: the
 * first characters agree, up to an ellipsis the reply cut it at, and at least 8 of them.
 */
export function titleMatches(written: string, title: string): boolean {
    const norm = (text: string) =>
        text
            .replace(/^Draft: /, "")
            .replace(/\s+/g, " ")
            .trim()
            .toLowerCase();
    const truncated = /\.\.\.|…/.test(written);
    const said = norm(written.split(/\.\.\.|…/)[0] ?? "");
    const real = norm(title);

    return said.length >= 8 && (truncated ? real.startsWith(said) : said === real);
}

/**
 * What the session's earlier messages say: the GitHub PR numbers they linked with their repository (the latest
 * wins), and every project they named whole.
 */
export function sessionRepos(
    texts: readonly string[],
    githubHost = "github.com"
): { linked: Map<number, ForgeProject>; named: ForgeProject[] } {
    const found = { linked: new Map<number, ForgeProject>(), named: new Map<string, ForgeProject>() };
    addSessionRepos(found, texts, githubHost);

    return { linked: found.linked, named: [...found.named.values()] };
}

/** `sessionRepos` over more messages, added to what earlier ones said (`named` keyed by kind and lowercase path). */
export function addSessionRepos(
    found: { linked: Map<number, ForgeProject>; named: Map<string, ForgeProject> },
    texts: readonly string[],
    githubHost: string
): void {
    for (const text of texts) {
        for (const mention of mentionsIn(text, githubHost)) {
            if (!mention.project) {
                continue;
            }

            found.named.set(`${mention.project.kind}:${mention.project.path.toLowerCase()}`, mention.project);

            if (mention.number !== undefined && mention.project.kind === "github") {
                found.linked.set(mention.number, mention.project);
            }
        }
    }
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

/**
 * A lookup's answer, and whether git gave it: outside a checkout and without an `origin` are answers, while a run that
 * could not start or timed out says nothing, and is asked again the next time instead of being kept for the session.
 */
interface Lookup {
    project: ForgeProject | undefined;
    settled: boolean;
}

const pathProjects = new Map<string, Promise<Lookup>>();
/**
 * A checkout root's `origin` once git answered, for 10 minutes (no forge project for 30 seconds), so a remote added or
 * moved with `git remote set-url` during a session reaches the links of the session's own checkout. `at` is unset
 * while the run is in flight, which every caller then shares.
 */
const rootProjects = new Map<string, { lookup: Promise<Lookup>; at?: number; project?: ForgeProject }>();
const ORIGIN_MS = 10 * 60_000;
const NO_ORIGIN_MS = 30_000;
/**
 * A folder's checkout root once git answered, for 10 minutes (a folder outside a checkout for 1 minute). The git
 * band asks for the cwd on every refresh: its `git rev-parse` was 1,334 of the 14,746 processes of 20 sessions in a
 * quiet 3 hours on 2026-10-30.
 */
const folderRoots = new Map<string, { root: string | undefined; settled: boolean; at: number }>();
const ROOT_MS = 10 * 60_000;
const NO_ROOT_MS = 60_000;

/** The time the checkout and origin answers age by (tests move it). */
export const repoLookupClock = { now: (): number => Date.now() };

/** Forgets the checkouts read so far (tests). */
export function forgetRepoMentions(): void {
    pathProjects.clear();
    rootProjects.clear();
    folderRoots.clear();
}

/** The checkout a folder lies in; `settled` when git said so, or said it is not in one. */
async function rootOf(host: Host, dir: string): Promise<{ root: string | undefined; settled: boolean }> {
    const known = folderRoots.get(dir);

    if (known && repoLookupClock.now() - known.at < (known.root ? ROOT_MS : NO_ROOT_MS)) {
        return known;
    }

    const top = await host
        .run(["git", "-C", dir, "rev-parse", "--show-toplevel"], { timeoutMs: 3_000 })
        .catch(() => undefined);
    const root = (top?.exitCode === 0 && top.stdout.trim()) || undefined;
    const found = {
        root,
        settled: root !== undefined || (top !== undefined && /not a git repository/i.test(top.stderr)),
        at: repoLookupClock.now(),
    };

    // A run that could not start, timed out or failed otherwise says nothing, and is asked again.
    if (found.settled) {
        folderRoots.set(dir, found);
    }

    return found;
}

/** The checkout root of a folder; undefined outside a checkout or when git did not answer. */
export async function checkoutRoot(host: Host, dir: string): Promise<string | undefined> {
    return (await rootOf(host, dir)).root;
}

/** A folder's checkout root and the forge project of its `origin`. */
export async function checkoutOf(
    host: Host,
    dir: string
): Promise<{ root: string | undefined; project: ForgeProject | undefined }> {
    const { root } = await rootOf(host, dir);

    return { root, project: root ? (await originOf(host, root)).project : undefined };
}

/** The forge project of a checkout root's `origin`, kept for `ORIGIN_MS` once git answers (`NO_ORIGIN_MS` for none). */
function originOf(host: Host, root: string): Promise<Lookup> {
    const known = rootProjects.get(root);

    if (
        known &&
        (known.at === undefined || repoLookupClock.now() - known.at < (known.project ? ORIGIN_MS : NO_ORIGIN_MS))
    ) {
        return known.lookup;
    }

    const held: { lookup: Promise<Lookup>; at?: number; project?: ForgeProject } = {
        lookup: readOrigin(host, root),
    };
    rootProjects.set(root, held);
    void held.lookup.then((found) => {
        if (rootProjects.get(root) !== held) {
            return;
        }

        if (!found.settled) {
            rootProjects.delete(root);
            return;
        }

        held.at = repoLookupClock.now();
        held.project = found.project;
    });

    return held.lookup;
}

async function readOrigin(host: Host, root: string): Promise<Lookup> {
    const origin = await host
        .run(["git", "-C", root, "remote", "get-url", "origin"], { timeoutMs: 3_000 })
        .catch(() => undefined);

    return {
        project: origin?.exitCode === 0 ? forgeProject(origin.stdout) : undefined,
        settled: origin !== undefined && (origin.exitCode === 0 || /no such remote/i.test(origin.stderr)),
    };
}

/** One lookup per key while it runs and after it settled; an unsettled one is dropped once it answers. */
function remembered(held: Map<string, Promise<Lookup>>, key: string, look: () => Promise<Lookup>): Promise<Lookup> {
    const known = held.get(key);

    if (known) {
        return known;
    }

    const fresh = look();
    held.set(key, fresh);
    void fresh.then((found) => {
        if (!found.settled && held.get(key) === fresh) {
            held.delete(key);
        }
    });

    return fresh;
}

/** The forge project of the checkout an absolute path lies in (its `origin`); undefined outside a checkout. */
export async function projectOfPath(host: Host, path: string, home: string): Promise<ForgeProject | undefined> {
    const absolute = path.startsWith("~/") ? `${home}${path.slice(1)}` : path;
    const clean = absolute
        .replace(/[.,:;!?]+$/, "")
        .replace(/:\d+(-\d+)?$/, "")
        .replace(/\/+$/, "");

    return (await remembered(pathProjects, clean, () => checkoutProject(host, clean))).project;
}

async function checkoutProject(host: Host, path: string): Promise<Lookup> {
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
        return { project: undefined, settled: true };
    }

    const { root, settled } = await rootOf(host, dir);

    return root ? originOf(host, root) : { project: undefined, settled };
}
