/** Browser-safe path display helpers — no Node built-ins. */

export function toPosixPath(p: string): string {
    return p.replace(/\\/g, "/");
}

export function collapsePathForDisplay(p: string): string {
    if (!p) {
        return p;
    }

    const normalized = toPosixPath(p.trim());

    if (normalized.startsWith("~/") || normalized === "~") {
        return normalized;
    }

    const mac = normalized.match(/^\/Users\/[^/]+(\/.*)?$/);
    if (mac) {
        return `~${mac[1] ?? ""}`;
    }

    const linux = normalized.match(/^\/home\/[^/]+(\/.*)?$/);
    if (linux) {
        return `~${linux[1] ?? ""}`;
    }

    return normalized;
}

function normalizePathsForDisplay(paths: readonly string[]): string[] {
    return [...new Set(paths.map((path) => collapsePathForDisplay(toPosixPath(path.trim()))).filter(Boolean))];
}

function splitPathSegments(path: string): string[] {
    const normalized = collapsePathForDisplay(toPosixPath(path.trim()));

    if (!normalized) {
        return [];
    }

    if (normalized === "~") {
        return ["~"];
    }

    if (normalized.startsWith("~/")) {
        return ["~", ...normalized.slice(2).split("/").filter(Boolean)];
    }

    if (normalized.startsWith("/")) {
        return normalized.split("/").filter(Boolean);
    }

    return normalized.split("/").filter(Boolean);
}

function joinPathSegments(segments: string[]): string {
    if (segments.length === 0) {
        return "";
    }

    if (segments[0] === "~") {
        if (segments.length === 1) {
            return "~";
        }

        return `~/${segments.slice(1).join("/")}`;
    }

    return `/${segments.join("/")}`;
}

const WORKTREE_MARKERS = ["/.claude/worktrees/", "/.worktrees/"] as const;

function pathContainsWorktree(path: string): boolean {
    const normalized = collapsePathForDisplay(toPosixPath(path.trim()));

    return WORKTREE_MARKERS.some((marker) => normalized.includes(marker));
}

function worktreeRepoRoot(path: string): string | null {
    const normalized = collapsePathForDisplay(toPosixPath(path.trim()));

    for (const marker of WORKTREE_MARKERS) {
        const idx = normalized.indexOf(marker);

        if (idx !== -1) {
            return normalized.slice(0, idx);
        }
    }

    return null;
}

function truncatePrefixBeforeWorktreeMarker(prefix: string): string {
    const normalized = collapsePathForDisplay(toPosixPath(prefix.trim()));

    if (!normalized) {
        return normalized;
    }

    for (const marker of WORKTREE_MARKERS) {
        const bare = marker.slice(0, -1);
        const idx = normalized.indexOf(bare);

        if (idx !== -1) {
            return normalized.slice(0, idx);
        }
    }

    return normalized;
}

function shallowerPathPrefix(a: string, b: string): string {
    if (!a) {
        return b;
    }

    if (!b) {
        return a;
    }

    return splitPathSegments(a).length <= splitPathSegments(b).length ? a : b;
}

/** Longest shared directory prefix across paths (collapsed, no trailing slash). Empty when not shared. */
export function longestCommonPathPrefix(paths: readonly string[]): string {
    const normalized = normalizePathsForDisplay(paths);

    if (normalized.length < 2) {
        return "";
    }

    const segmentLists = normalized.map(splitPathSegments);
    const first = segmentLists[0];
    let sharedSegmentCount = 0;

    for (let index = 0; index < first.length; index++) {
        const segment = first[index];

        if (!segmentLists.every((parts) => parts[index] === segment)) {
            break;
        }

        sharedSegmentCount = index + 1;
    }

    if (sharedSegmentCount === 0) {
        return "";
    }

    if (sharedSegmentCount === 1 && first[0] === "~") {
        return "";
    }

    return joinPathSegments(first.slice(0, sharedSegmentCount));
}

function resolveSameRepoWorktreePrefix(repoRoot: string, normalized: readonly string[]): string | null {
    const segments = splitPathSegments(repoRoot);

    if (segments.length < 2) {
        return null;
    }

    const dropParents = normalized.some((path) => path.includes("/.claude/worktrees/")) ? 2 : 1;
    const len = Math.max(2, segments.length - dropParents);
    const ancestor = joinPathSegments(segments.slice(0, len));
    const tails = new Set(normalized.map((path) => shortenPathWithPrefix(path, ancestor)));

    if (tails.size !== normalized.length) {
        return null;
    }

    const sample = shortenPathWithPrefix(normalized[0], ancestor);

    if (sample.startsWith(".claude") || sample.startsWith(".worktrees")) {
        return null;
    }

    return ancestor;
}

/**
 * Prefix for dashboard cwd display. When paths sit under `.claude/worktrees/`
 * or `.worktrees/`, avoid absorbing the worktree folder into the shared prefix
 * so siblings stay distinguishable (e.g. `CEZ/col-fe/.claude/worktrees/wt-a`).
 */
export function resolveDirPathDisplayPrefix(paths: readonly string[]): string {
    const normalized = normalizePathsForDisplay(paths);

    if (normalized.length < 2) {
        return "";
    }

    const standard = longestCommonPathPrefix(normalized);

    if (!normalized.some(pathContainsWorktree)) {
        return standard;
    }

    const capped = truncatePrefixBeforeWorktreeMarker(standard);
    const repoRoots = [...new Set(normalized.map(worktreeRepoRoot).filter((root): root is string => Boolean(root)))];

    if (repoRoots.length === 1) {
        const sameRepoPrefix = resolveSameRepoWorktreePrefix(repoRoots[0], normalized);

        if (sameRepoPrefix) {
            return sameRepoPrefix;
        }
    }

    const anchoredPrefix = longestCommonPathPrefix(normalized.map((path) => worktreeRepoRoot(path) ?? path));

    return shallowerPathPrefix(capped, anchoredPrefix);
}

export function shortenPathWithPrefix(path: string, prefix: string): string {
    const full = collapsePathForDisplay(toPosixPath(path.trim()));

    if (!full) {
        return full;
    }

    if (!prefix) {
        return full;
    }

    const shared = collapsePathForDisplay(toPosixPath(prefix.trim()));

    if (!shared) {
        return full;
    }

    if (full === shared) {
        return ".";
    }

    const sharedWithSlash = shared.endsWith("/") ? shared : `${shared}/`;

    if (full.startsWith(sharedWithSlash)) {
        const rest = full.slice(sharedWithSlash.length);

        return rest || ".";
    }

    return full;
}

export function formatPathForDisplay(path: string, commonPrefix?: string): { display: string; full: string } {
    const full = collapsePathForDisplay(toPosixPath(path.trim()));

    return {
        full,
        display: shortenPathWithPrefix(full, commonPrefix ?? ""),
    };
}
