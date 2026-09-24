import { type Dirent, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { logger } from "@genesiscz/utils/logger";
import { expandTilde } from "@genesiscz/utils/paths";
import { originWebBase } from "./origins/web";

/** A forge project, host lowercased and path without `.git` or edge slashes: `github.com` + `o/r`. */
export interface ProjectRef {
    host: string;
    path: string;
}

/** One working tree on this machine: a main checkout or a linked worktree. */
export interface LocalCheckout {
    root: string;
    commonDir: string;
    /** The branch checked out there; null on a detached HEAD. */
    branch: string | null;
    isMain: boolean;
    remoteUrl: string;
    project: ProjectRef;
}

export interface DiscoverOptions {
    /** Folders to scan for checkouts; `~` is expanded. */
    roots: string[];
    /** How many folder levels below each root to look for a `.git`. Default 3. */
    maxDepth?: number;
}

const log = logger.child({ component: "git/local-checkouts" });

const SKIP_DIRS = new Set(["node_modules", "dist", "build", "vendor", "Pods", "target", "Library"]);

/**
 * The project a remote or web URL points at. Accepts every remote shape `originWebBase` knows
 * (`git@host:o/r.git`, `ssh://…`, `https://…`) and a project web URL. A deeper web URL
 * (`…/-/merge_requests/1`, `…/pull/1`) must be cut to the project first: the path is taken whole.
 */
export function projectRefFromUrl(url: string): ProjectRef | null {
    const base = originWebBase(url);

    if (!base) {
        return null;
    }

    let parsed: URL;
    let path: string;

    try {
        parsed = new URL(base);
        path = decodeURIComponent(parsed.pathname).replace(/^\/+|\/+$/g, "");
    } catch (err) {
        log.debug({ err, url }, "unparsable project URL");
        return null;
    }

    if (!path) {
        return null;
    }

    return { host: parsed.host.toLowerCase(), path: path.toLowerCase() };
}

export function sameProject(a: ProjectRef, b: ProjectRef): boolean {
    return a.host === b.host && a.path === b.path;
}

function readText(path: string): string | null {
    try {
        return readFileSync(path, "utf8");
    } catch (err) {
        log.debug({ err, path }, "unreadable git file");
        return null;
    }
}

function branchFromHead(head: string | null): string | null {
    const match = /^ref:\s*refs\/heads\/(.+)$/m.exec(head?.trim() ?? "");
    return match ? match[1].trim() : null;
}

/** `origin`'s url from a git config file, else the first remote that has one. */
export function remoteUrlFromConfig(config: string): string | null {
    let section: string | null = null;
    const urls = new Map<string, string>();

    for (const raw of config.split("\n")) {
        const line = raw.trim();
        const header = /^\[remote\s+"([^"]+)"\]$/.exec(line);

        if (header) {
            section = header[1];
            continue;
        }

        if (line.startsWith("[")) {
            section = null;
            continue;
        }

        const url = /^url\s*=\s*(.+)$/.exec(line);

        if (section && url && !urls.has(section)) {
            urls.set(section, url[1].trim());
        }
    }

    return urls.get("origin") ?? urls.values().next().value ?? null;
}

/** The common git dir of the checkout at `dir`, or null when `dir` has no `.git`. */
function commonDirOf(dir: string): string | null {
    const dotGit = join(dir, ".git");

    if (!existsSync(dotGit)) {
        return null;
    }

    if (statSync(dotGit).isDirectory()) {
        return dotGit;
    }

    const pointer = /^gitdir:\s*(.+)$/m.exec(readText(dotGit) ?? "");

    if (!pointer) {
        return null;
    }

    const gitDir = resolve(dir, pointer[1].trim());
    const common = readText(join(gitDir, "commondir"))?.trim();

    return common ? resolve(gitDir, common) : gitDir;
}

/** Every working tree that shares `commonDir`: the main checkout first, then its linked worktrees. */
export function checkoutsOfCommonDir(commonDir: string): LocalCheckout[] {
    const remoteUrl = remoteUrlFromConfig(readText(join(commonDir, "config")) ?? "");
    const project = remoteUrl ? projectRefFromUrl(remoteUrl) : null;

    if (!remoteUrl || !project) {
        log.debug({ commonDir }, "checkout without a usable remote");
        return [];
    }

    const found: LocalCheckout[] = [];

    if (basename(commonDir) === ".git") {
        found.push({
            root: dirname(commonDir),
            commonDir,
            branch: branchFromHead(readText(join(commonDir, "HEAD"))),
            isMain: true,
            remoteUrl,
            project,
        });
    }

    const adminRoot = join(commonDir, "worktrees");

    if (!existsSync(adminRoot)) {
        return found;
    }

    for (const entry of readdirSync(adminRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) {
            continue;
        }

        const adminDir = join(commonDir, "worktrees", entry.name);
        const gitFile = readText(join(adminDir, "gitdir"))?.trim();

        if (!gitFile) {
            continue;
        }

        const root = dirname(isAbsolute(gitFile) ? gitFile : resolve(adminDir, gitFile));

        if (!existsSync(root)) {
            log.debug({ root }, "prunable worktree skipped");
            continue;
        }

        found.push({
            root,
            commonDir,
            branch: branchFromHead(readText(join(adminDir, "HEAD"))),
            isMain: false,
            remoteUrl,
            project,
        });
    }

    return found;
}

/** The checkouts sharing the repository that contains `dir`; empty when `dir` is not a checkout. */
export function checkoutsAt(dir: string): LocalCheckout[] {
    const common = commonDirOf(expandTilde(dir));
    return common ? checkoutsOfCommonDir(common) : [];
}

/**
 * Every checkout under `roots`, read from the git files directly (no `git` spawn per repo).
 * A folder with a `.git` is a leaf: the scan does not descend into it, and its linked worktrees
 * come from the common dir, wherever they live.
 */
export function discoverCheckouts({ roots, maxDepth = 3 }: DiscoverOptions): LocalCheckout[] {
    const commonDirs = new Set<string>();
    const queue = roots.map((root) => ({ dir: resolve(expandTilde(root)), depth: 0 }));

    while (queue.length > 0) {
        const next = queue.shift();

        if (!next) {
            break;
        }

        const common = commonDirOf(next.dir);

        if (common) {
            commonDirs.add(common);
            continue;
        }

        if (next.depth >= maxDepth) {
            continue;
        }

        let entries: Dirent[];

        try {
            entries = readdirSync(next.dir, { withFileTypes: true });
        } catch (err) {
            log.debug({ err, dir: next.dir }, "unreadable folder skipped");
            continue;
        }

        for (const entry of entries) {
            if (entry.isDirectory() && !entry.name.startsWith(".") && !SKIP_DIRS.has(entry.name)) {
                queue.push({ dir: join(next.dir, entry.name), depth: next.depth + 1 });
            }
        }
    }

    const checkouts = [...commonDirs].flatMap(checkoutsOfCommonDir);
    log.debug({ roots, repos: commonDirs.size, checkouts: checkouts.length }, "discovered checkouts");
    return checkouts;
}

/**
 * The checkouts of `project`, best first: a worktree on `branch`, then the main checkout, then
 * the other worktrees. Duplicate roots (a root listed twice) collapse.
 */
export function rankCheckouts({
    project,
    checkouts,
    branch,
}: {
    project: ProjectRef;
    checkouts: LocalCheckout[];
    branch?: string | null;
}): LocalCheckout[] {
    const seen = new Set<string>();
    const matching = checkouts.filter((checkout) => {
        if (!sameProject(checkout.project, project) || seen.has(checkout.root)) {
            return false;
        }

        seen.add(checkout.root);
        return true;
    });
    const score = (checkout: LocalCheckout): number => {
        if (branch && checkout.branch === branch) {
            return 0;
        }

        return checkout.isMain ? 1 : 2;
    };

    return matching.sort((a, b) => score(a) - score(b) || a.root.localeCompare(b.root));
}
