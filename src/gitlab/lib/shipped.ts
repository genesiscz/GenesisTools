/**
 * Did the code of an MR branch already reach the environments?
 *
 * Ancestry cannot answer that: a squash merge, a rebase or a rewritten integration branch all
 * make `git merge-base --is-ancestor` and `git cherry` say "never shipped" for code that did
 * ship. The reliable test is the content of the branch: take the lines the branch adds, then
 * look for them in the target refs.
 */

import type { EnvironmentBranches } from "@app/gitlab/lib/config";
import { gitResult } from "@app/gitlab/lib/git";

export type ShippedVerdict = "present" | "partial" | "absent" | "unknown";

export interface ShippedRefCheck {
    ref: string;
    matched: number;
    sampled: number;
    verdict: ShippedVerdict;
}

export interface ShippedFileCheck {
    path: string;
    sampled: number;
    /** Ref to the number of sampled lines found in that ref's version of the file. */
    matched: Record<string, number>;
    /** The sampled lines and the refs whose version of the file contains each one. */
    lines: Array<{ text: string; in: string[] }>;
}

export interface ShippedFacts {
    mergeBase: string | null;
    filesChanged: number;
    insertions: number;
    deletions: number;
    refs: ShippedRefCheck[];
    files: ShippedFileCheck[];
    verdict: ShippedVerdict;
    note: string | null;
    /** True when every significant added line of every file was checked, not a sample. */
    exhaustive?: boolean;
    /** Files that had significant added lines (the denominator of an exhaustive check). */
    filesChecked?: number;
}

/** Which remote ref plays which environment; null when the environment is not configured. Full refs (`origin/<branch>`). */
export interface ShippedRoles {
    uat: string | null;
    production: string | null;
    test: string | null;
}

/** Lock files, snapshots and data JSON never count; package.json does, because a version bump is the change in an upgrade MR. */
const SKIP_PATH = /(^|\/)(bun\.lock|yarn\.lock|package-lock\.json|.*\.snap|.*\.lock|(?!package\.json$)[^/]*\.json)$/;
const MAX_FILES = 10;
const MAX_LINES_PER_FILE = 8;
const IMPORT_CONTINUATION = /^(\}?\s*from\s+["']|[A-Za-z_$][\w$.]*,?$)/;
const SINGLE_JSX_ATTRIBUTE = /^[A-Za-z][\w-]*=(\{[^{}]*\}|"[^"]*"|'[^']*'),?$/;
const SHORT_PROPERTY = /^[A-Za-z_$][\w$]*:\s*[^,;{}()]{1,30},?$/;

const IMPORT_OR_REEXPORT = /^(import\s|export\s+(\*|\{[^}]*\})\s+from\s)/;
const BARE_JSX_TAG = /^<\/?[A-Za-z][\w.]*\s*\/?>$/;
const CLOSING_ONLY = /^[)\]}>;,\s]*$/;

/**
 * A line worth searching for: long enough to be unique, carries letters, and says something
 * about the change. Imports and their continuation lines (`Foo,`, `} from "..."`), re-exports,
 * bare JSX tags, single JSX attributes, short `key: value,` properties and closing punctuation
 * are shared by every file, so they are not evidence that this change landed.
 */
export function isSignificantLine(line: string): boolean {
    const text = line.trim();
    if (text.length < 12) {
        return false;
    }

    if (!/[A-Za-z]/.test(text)) {
        return false;
    }

    return (
        !IMPORT_OR_REEXPORT.test(text) &&
        !IMPORT_CONTINUATION.test(text) &&
        !BARE_JSX_TAG.test(text) &&
        !SINGLE_JSX_ATTRIBUTE.test(text) &&
        !SHORT_PROPERTY.test(text) &&
        !CLOSING_ONLY.test(text) &&
        !/^[/*{}()[\],;]+$/.test(text)
    );
}

/**
 * Files touched by the branch's own non-merge commits. A long-lived branch that merged its
 * target or another feature branch into itself carries other people's work in its diff;
 * sampling that work would report it as "already shipped" and prove nothing about this MR.
 */
function ownFiles(cwd: string, mergeBase: string, sourceRef: string): Set<string> {
    const result = gitResult(cwd, ["log", "--no-merges", "--name-only", "--format=", `${mergeBase}..${sourceRef}`]);
    if (result.exitCode !== 0) {
        return new Set();
    }

    return new Set(
        result.stdout
            .split("\n")
            .map((l) => l.trim())
            .filter(Boolean)
    );
}

/** Added lines of a unified diff, without the `+++` header, filtered to the significant ones. */
export function addedLines(diff: string): string[] {
    const seen = new Set<string>();
    for (const line of diff.split("\n")) {
        if (!line.startsWith("+") || line.startsWith("+++")) {
            continue;
        }

        const text = line.slice(1).trim();
        if (isSignificantLine(text)) {
            seen.add(text);
        }
    }

    return [...seen];
}

/** `present` needs more than 80 % of the sampled lines; below that a change is only partly there. */
export const PRESENT_RATIO = 0.8;

export function refVerdict(matched: number, sampled: number): ShippedVerdict {
    if (sampled === 0) {
        return "unknown";
    }

    if (matched === 0) {
        return "absent";
    }

    return matched / sampled > PRESENT_RATIO ? "present" : "partial";
}

/** `present` when any ref has it, `absent` when every ref lacks it, `partial` in between. */
export function overallVerdict(refs: ShippedRefCheck[]): ShippedVerdict {
    const known = refs.filter((r) => r.verdict !== "unknown");
    if (!known.length) {
        return "unknown";
    }

    if (known.some((r) => r.verdict === "present")) {
        return "present";
    }

    return known.every((r) => r.verdict === "absent") ? "absent" : "partial";
}

/** Newest `origin/<prefix>…<YYYY-MM-DD>` whose date is not after `asOf`: the dated release branch that is production. */
export function pickReleaseRef(refs: string[], prefix: string, asOf: string): string | null {
    const dated = refs
        .filter((ref) => ref.startsWith(`origin/${prefix}`))
        .map((ref) => ({ ref, date: ref.match(/(\d{4}-\d{2}-\d{2})$/)?.[1] ?? null }))
        .filter((r): r is { ref: string; date: string } => r.date !== null && r.date <= asOf)
        .sort((a, b) => b.date.localeCompare(a.date));

    return dated[0]?.ref ?? null;
}

export function releaseRef(cwd: string, prefix: string, asOf: string): string | null {
    const result = gitResult(cwd, ["for-each-ref", "--format=%(refname:short)", "refs/remotes/origin"]);
    if (result.exitCode !== 0) {
        return null;
    }

    const refs = result.stdout
        .split("\n")
        .map((r) => r.trim())
        .filter(Boolean);

    return pickReleaseRef(refs, prefix, asOf);
}

/**
 * The refs the content check searches, in the order UAT, production, test, and which is which.
 * Production is the newest dated release branch when `releasePrefix` is set, else the configured
 * production branch, else the project's default branch.
 */
export function environmentRefs(options: {
    cwd: string;
    environments: EnvironmentBranches;
    defaultBranch: string;
    asOf: string;
}): { roles: ShippedRoles; refs: string[]; failures: string[] } {
    const { environments } = options;
    const failures: string[] = [];
    let production: string | null;

    if (environments.releasePrefix) {
        production = releaseRef(options.cwd, environments.releasePrefix, options.asOf);

        if (!production) {
            failures.push(
                `no origin/${environments.releasePrefix}<YYYY-MM-DD> branch found; the content check skips production`
            );
        }
    } else {
        production = `origin/${environments.production ?? options.defaultBranch}`;
    }

    const roles: ShippedRoles = {
        uat: environments.uat ? `origin/${environments.uat}` : null,
        production,
        test: environments.test ? `origin/${environments.test}` : null,
    };
    const refs = [...new Set([roles.uat, roles.production, roles.test].filter((r): r is string => r !== null))];

    return { roles, refs, failures };
}

interface NumstatRow {
    path: string;
    added: number;
    deleted: number;
}

function numstat(cwd: string, range: string[]): NumstatRow[] {
    const result = gitResult(cwd, ["diff", "--numstat", ...range]);
    if (result.exitCode !== 0) {
        return [];
    }

    return result.stdout
        .split("\n")
        .map((line) => line.split("\t"))
        .filter((parts) => parts.length === 3)
        .map(([added, deleted, path]) => ({
            path: path ?? "",
            added: Number(added) || 0,
            deleted: Number(deleted) || 0,
        }))
        .filter((row) => row.path && !row.path.includes(" => "));
}

export interface ShippedOptions {
    cwd: string;
    sourceRef: string;
    targetRef: string;
    /** Refs to search for the branch content, usually UAT, production and test. */
    checkRefs: string[];
    /** Check every significant added line of every file instead of 8 lines in 10 files. Needed before calling an MR superseded. */
    exhaustive?: boolean;
}

/**
 * Sample the lines the branch adds, then count them in each check ref. A file that the ref
 * does not have at all counts as zero matches, which is the honest answer for a new file.
 */
export function collectShipped(options: ShippedOptions): ShippedFacts {
    const { cwd, sourceRef, targetRef, checkRefs } = options;
    const empty: ShippedFacts = {
        mergeBase: null,
        filesChanged: 0,
        insertions: 0,
        deletions: 0,
        refs: [],
        files: [],
        verdict: "unknown",
        note: null,
    };
    const base = gitResult(cwd, ["merge-base", sourceRef, targetRef]);
    if (base.exitCode !== 0 || !base.stdout) {
        return {
            ...empty,
            note: `no merge base between ${sourceRef} and ${targetRef}`,
            exhaustive: options.exhaustive === true,
            filesChecked: 0,
        };
    }

    const mergeBase = base.stdout;
    const rows = numstat(cwd, [mergeBase, sourceRef]);
    const totals = {
        filesChanged: rows.length,
        insertions: rows.reduce((sum, r) => sum + r.added, 0),
        deletions: rows.reduce((sum, r) => sum + r.deleted, 0),
    };
    const own = ownFiles(cwd, mergeBase, sourceRef);
    const eligible = rows
        .filter((row) => !SKIP_PATH.test(row.path) && row.added > 0 && (own.size === 0 || own.has(row.path)))
        .sort((a, b) => b.added - a.added);
    const candidates = options.exhaustive ? eligible : eligible.slice(0, MAX_FILES);
    if (!candidates.length) {
        return {
            ...empty,
            ...totals,
            mergeBase,
            note: "no added lines to check",
            exhaustive: options.exhaustive === true,
            filesChecked: 0,
        };
    }

    const files: ShippedFileCheck[] = [];
    const totalsByRef = new Map<string, { matched: number; sampled: number }>(
        checkRefs.map((ref) => [ref, { matched: 0, sampled: 0 }])
    );

    for (const row of candidates) {
        const diff = gitResult(cwd, ["diff", "-U0", "--no-color", mergeBase, sourceRef, "--", row.path]);
        const allLines = addedLines(diff.stdout);
        const lines = options.exhaustive ? allLines : allLines.slice(0, MAX_LINES_PER_FILE);
        if (!lines.length) {
            continue;
        }

        const matched: Record<string, number> = {};
        const detail = lines.map((text) => ({ text, in: [] as string[] }));

        for (const ref of checkRefs) {
            const shown = gitResult(cwd, ["show", `${ref}:${row.path}`]);
            const content = shown.exitCode === 0 ? shown.stdout : "";
            let hits = 0;

            for (const entry of detail) {
                if (content.includes(entry.text)) {
                    entry.in.push(ref);
                    hits++;
                }
            }

            matched[ref] = hits;
            const totalsForRef = totalsByRef.get(ref);
            if (totalsForRef) {
                totalsForRef.matched += hits;
                totalsForRef.sampled += lines.length;
            }
        }

        files.push({ path: row.path, sampled: lines.length, matched, lines: detail });
    }

    const refs: ShippedRefCheck[] = checkRefs.map((ref) => {
        const t = totalsByRef.get(ref) ?? { matched: 0, sampled: 0 };

        return { ref, matched: t.matched, sampled: t.sampled, verdict: refVerdict(t.matched, t.sampled) };
    });

    return {
        ...totals,
        mergeBase,
        refs,
        files,
        verdict: overallVerdict(refs),
        note: files.length ? null : "no significant added lines to check",
        exhaustive: options.exhaustive === true,
        filesChecked: files.length,
    };
}

/**
 * Labels that claim a merge state the content check contradicts, for example
 * `NOT merged into develop` on a branch whose lines are present in `origin/develop`.
 * `pattern` captures an optional negation in group 1 and the branch name in group 2.
 */
export function labelConflicts(labels: string[], shipped: ShippedFacts, pattern: string): string[] {
    const regex = new RegExp(pattern, "i");
    const conflicts: string[] = [];

    for (const label of labels) {
        const match = label.match(regex);
        if (!match) {
            continue;
        }

        const claimsMerged = !match[1];
        const branch = match[2] ?? "";
        const check = shipped.refs.find((r) => r.ref.endsWith(`/${branch}`));
        if (!check || check.verdict === "unknown") {
            continue;
        }

        if (claimsMerged && check.verdict === "absent") {
            conflicts.push(`label "${label}" but no sampled line of the branch is in ${check.ref}`);
        }

        if (!claimsMerged && check.verdict === "present") {
            conflicts.push(
                `label "${label}" but ${check.matched} of ${check.sampled} sampled lines are in ${check.ref}`
            );
        }
    }

    return conflicts;
}
