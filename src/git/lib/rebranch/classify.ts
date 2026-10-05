/**
 * Path groups and commit classification, pure. A group is a name plus path patterns; a commit is
 * IN a group when every path it changes matches, OUTSIDE when none does, MIXED when both. The
 * paths come from a `--no-renames` listing, so a move counts with both halves: the deleted old
 * name and the added new one.
 */

import { matchGlob } from "@genesiscz/utils/string";

export type CommitClass = "IN" | "OUTSIDE" | "MIXED";

export interface PathGroup {
    name: string;
    patterns: string[];
}

export interface HistoryCommit {
    sha: string;
    subject: string;
    /** Every path the commit changes, both halves of a move included. */
    paths: string[];
}

export interface GroupClassification {
    class: CommitClass;
    groupPaths: string[];
    outsidePaths: string[];
}

export interface ClassifiedCommit extends HistoryCommit {
    /** By group name. */
    classes: Record<string, GroupClassification>;
    /** Groups the commit is IN or MIXED for. */
    groups: string[];
}

export interface Analysis {
    commits: ClassifiedCommit[];
    /** Commits that match no group at all. */
    unassigned: ClassifiedCommit[];
    /** Commits that match two or more groups. */
    shared: ClassifiedCommit[];
}

const GROUP_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * `"api=src/api/**,docs/api"` → `{ name: "api", patterns: ["src/api/**", "docs/api"] }`. Throws on a
 * spec without a name, without patterns, or with a name that cannot be part of a branch name.
 */
export function parseGroupSpec(spec: string): PathGroup {
    const eq = spec.indexOf("=");

    if (eq <= 0) {
        throw new Error(`group "${spec}" must look like name=path,path`);
    }

    const name = spec.slice(0, eq).trim();
    const patterns = spec
        .slice(eq + 1)
        .split(",")
        .map((p) => p.trim().replace(/^\.\//, ""))
        .filter((p) => p.length > 0);

    if (!GROUP_NAME.test(name)) {
        throw new Error(`group name "${name}" may use letters, digits, ".", "_" and "-" only`);
    }

    if (patterns.length === 0) {
        throw new Error(`group "${name}" has no path patterns`);
    }

    return { name, patterns };
}

/**
 * A pattern with `*` goes through the repo's glob matcher, where `*` crosses `/` (so `src/git/*`
 * and `src/git/**` match the same paths). A pattern without `*` names a file or a directory: it
 * matches that path and everything below it. Both ignore letter case.
 */
export function pathMatches(path: string, pattern: string): boolean {
    if (pattern.includes("*")) {
        return matchGlob(path, pattern);
    }

    const dir = pattern.replace(/\/+$/, "");
    return matchGlob(path, dir) || matchGlob(path, `${dir}/*`);
}

export function matchesGroup(path: string, patterns: string[]): boolean {
    return patterns.some((pattern) => pathMatches(path, pattern));
}

export function classifyPaths(paths: string[], patterns: string[]): GroupClassification {
    const groupPaths = paths.filter((p) => matchesGroup(p, patterns));
    const outsidePaths = paths.filter((p) => !matchesGroup(p, patterns));
    let cls: CommitClass = "MIXED";

    if (groupPaths.length === 0) {
        cls = "OUTSIDE";
    } else if (outsidePaths.length === 0) {
        cls = "IN";
    }

    return { class: cls, groupPaths, outsidePaths };
}

export function analyseCommits(commits: HistoryCommit[], groups: PathGroup[]): Analysis {
    const names = new Set<string>();

    for (const g of groups) {
        if (names.has(g.name)) {
            throw new Error(`group "${g.name}" is named twice`);
        }

        names.add(g.name);
    }

    const classified = commits.map((commit): ClassifiedCommit => {
        const classes: Record<string, GroupClassification> = {};

        for (const g of groups) {
            classes[g.name] = classifyPaths(commit.paths, g.patterns);
        }

        return {
            ...commit,
            classes,
            groups: groups.filter((g) => classes[g.name].class !== "OUTSIDE").map((g) => g.name),
        };
    });

    return {
        commits: classified,
        unassigned: classified.filter((c) => c.groups.length === 0),
        shared: classified.filter((c) => c.groups.length > 1),
    };
}
