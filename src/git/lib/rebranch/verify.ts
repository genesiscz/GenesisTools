/**
 * The split proof, pure: for every path the source changed since the merge-base, the group that
 * carries the LAST commit touching it must hold the source's final entry (mode and blob, or the
 * path's absence after a deletion). The git side only reads trees; every judgement is here.
 */

import type { HistoryCommit } from "./classify";
import { matchesGroup } from "./classify";
import type { ResolvedGroup } from "./plan";

export interface Entry {
    mode: string;
    sha: string;
}

/** Path → entry for every path of a tree; a missing key means the path does not exist there. */
export type EntryMap = Map<string, Entry>;

export type PathStatus = "ok" | "differs" | "lost" | "dropped" | "unverifiable";

export interface PathVerdict {
    path: string;
    status: PathStatus;
    /** Groups whose picks carry the last change of this path. */
    owners: string[];
    /** Other groups whose picks changed this path earlier (a shared path). */
    sharedWith: string[];
    detail: string;
}

export interface VerifyInput {
    groups: ResolvedGroup[];
    /** Source commits since the merge-base, oldest first. */
    history: HistoryCommit[];
    /** Full shas left out on purpose (the plan's top-level skip list). */
    skip: string[];
    /** The tree every carried path must reach: the source tip, or the source merged onto a moved base. */
    expected: EntryMap;
    /** The tree the group branches start from. */
    base: EntryMap;
    /** By group name. */
    branches: Record<string, EntryMap>;
    /** Paths the expected tree could not settle (the source conflicts with a moved base there). */
    unverifiable: string[];
}

export interface VerifyReport {
    ok: boolean;
    paths: PathVerdict[];
    /** Paths a group branch changes that the source never touched. */
    extra: { group: string; path: string }[];
    /** Paths a `paths-only` pick removed, per group and commit. */
    stripped: { group: string; sha: string; paths: string[] }[];
    /** `skip` decisions, per group, and the top-level skip list (group null). */
    skipped: { group: string | null; sha: string; subject: string }[];
    /** Source commits in no group and not in the skip list. */
    unassigned: HistoryCommit[];
}

const short = (sha: string): string => sha.slice(0, 9);

export function sameEntry(a: Entry | undefined, b: Entry | undefined): boolean {
    if (!a || !b) {
        return a === b;
    }

    return a.mode === b.mode && a.sha === b.sha;
}

export function describeEntry(e: Entry | undefined): string {
    return e ? `${e.mode} ${short(e.sha)}` : "absent";
}

/** Does this group's pick of `sha` bring the change to `path` onto the group branch? */
function carries(group: ResolvedGroup, sha: string, path: string): boolean {
    const pick = group.picks.find((p) => p.sha === sha);

    if (!pick || pick.decision === "skip") {
        return false;
    }

    return pick.decision === "whole" || matchesGroup(path, group.patterns);
}

function leftOutReason(groups: ResolvedGroup[], skip: string[], commit: HistoryCommit, path: string): string | null {
    if (skip.includes(commit.sha)) {
        return "the plan skips that commit";
    }

    const reasons: string[] = [];

    for (const g of groups) {
        const pick = g.picks.find((p) => p.sha === commit.sha);

        if (pick?.decision === "skip") {
            reasons.push(`skip in ${g.name}`);
        } else if (pick?.decision === "paths-only" && !matchesGroup(path, g.patterns)) {
            reasons.push(`paths-only in ${g.name}`);
        }
    }

    return reasons.length > 0 ? reasons.join(", ") : null;
}

export function verifySplit(input: VerifyInput): VerifyReport {
    const { groups, history, skip, expected, base, branches } = input;
    const touchers = new Map<string, HistoryCommit[]>();

    for (const commit of history) {
        for (const path of commit.paths) {
            const list = touchers.get(path) ?? [];

            if (!list.includes(commit)) {
                list.push(commit);
            }

            touchers.set(path, list);
        }
    }

    const unverifiable = new Set(input.unverifiable);
    const paths: PathVerdict[] = [];

    for (const path of [...touchers.keys()].sort()) {
        const commits = touchers.get(path) ?? [];
        const last = commits[commits.length - 1];
        const owners = groups.filter((g) => carries(g, last.sha, path)).map((g) => g.name);
        const touching = new Set(
            commits.flatMap((c) => groups.filter((g) => carries(g, c.sha, path)).map((g) => g.name))
        );
        const sharedWith = [...touching].filter((g) => !owners.includes(g));
        const want = expected.get(path);
        const verdict = (status: PathStatus, detail: string): void => {
            paths.push({ path, status, owners, sharedWith, detail });
        };
        const lastLabel = `${short(last.sha)} "${last.subject}"`;

        if (unverifiable.has(path)) {
            verdict("unverifiable", "the source conflicts with the moved base here; compare by hand");
            continue;
        }

        if (owners.length === 0) {
            const untouched = groups.every((g) => sameEntry(branches[g.name]?.get(path), base.get(path)));

            if (untouched && sameEntry(want, base.get(path))) {
                verdict("ok", "net unchanged on the source, untouched by every group");
                continue;
            }

            const reason = leftOutReason(groups, skip, last, path);

            if (reason) {
                verdict("dropped", `last changed by ${lastLabel}: ${reason}`);
            } else {
                verdict("lost", `last changed by ${lastLabel}, which is in no group`);
            }

            continue;
        }

        const holding = owners.filter((g) => sameEntry(branches[g]?.get(path), want));

        if (holding.length > 0) {
            const others = owners.filter((g) => !holding.includes(g));
            const note = others.length > 0 ? `; ${others.join(", ")} hold another version` : "";
            const shared = sharedWith.length > 0 ? `; also changed in ${sharedWith.join(", ")}` : "";
            const verb = holding.length === 1 ? "holds" : "hold";
            verdict("ok", `${holding.join(", ")} ${verb} the source's ${describeEntry(want)}${note}${shared}`);
            continue;
        }

        const found = owners.map((g) => `${g} has ${describeEntry(branches[g]?.get(path))}`).join(", ");
        const shared =
            sharedWith.length > 0
                ? `; shared path: earlier commits picked into ${sharedWith.join(", ")} also changed it`
                : "";
        verdict("differs", `the source has ${describeEntry(want)}, ${found} (last change ${lastLabel})${shared}`);
    }

    const extra: VerifyReport["extra"] = [];

    for (const g of groups) {
        const tree = branches[g.name];

        if (!tree) {
            continue;
        }

        for (const path of new Set([...tree.keys(), ...base.keys()])) {
            if (!touchers.has(path) && !sameEntry(tree.get(path), base.get(path))) {
                extra.push({ group: g.name, path });
            }
        }
    }

    extra.sort((a, b) => a.group.localeCompare(b.group) || a.path.localeCompare(b.path));

    const stripped: VerifyReport["stripped"] = [];
    const skipped: VerifyReport["skipped"] = [];
    const subjectOf = new Map(history.map((c) => [c.sha, c.subject]));

    for (const g of groups) {
        for (const pick of g.picks) {
            if (pick.decision === "paths-only" && pick.outsidePaths.length > 0) {
                stripped.push({ group: g.name, sha: pick.sha, paths: pick.outsidePaths });
            }

            if (pick.decision === "skip") {
                skipped.push({ group: g.name, sha: pick.sha, subject: pick.subject });
            }
        }
    }

    for (const sha of skip) {
        skipped.push({ group: null, sha, subject: subjectOf.get(sha) ?? "" });
    }

    const listed = new Set([...groups.flatMap((g) => g.picks.map((p) => p.sha)), ...skip]);
    const failed = paths.some((p) => p.status === "differs" || p.status === "lost" || p.status === "unverifiable");

    return {
        ok: !failed && extra.length === 0,
        paths,
        extra,
        stripped,
        skipped,
        unassigned: history.filter((c) => !listed.has(c.sha)),
    };
}
