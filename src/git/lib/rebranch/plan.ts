/**
 * The rebranch plan file: what `rebranch plan --json` prints and `rebranch apply --plan` reads.
 * The schema is the contract; everything else in the printed document (the per-commit table,
 * `unassigned`, `shared`) is information for the reader and is dropped on parse.
 */

import { existsSync } from "node:fs";
import { SafeJSON } from "@genesiscz/utils/json";
import { z } from "zod";
import { type Analysis, type CommitClass, classifyPaths, type HistoryCommit, type PathGroup } from "./classify";

export const DECISIONS = ["whole", "skip", "paths-only"] as const;
export type Decision = (typeof DECISIONS)[number];

const Sha = z.string().regex(/^[0-9a-f]{7,64}$/, "expected a commit sha (7 to 64 lowercase hex characters)");

const PlanCommitSchema = z.object({
    sha: Sha,
    /** Required for a MIXED commit; IN and OUTSIDE commits default to `whole`. */
    decision: z.enum(DECISIONS).nullable().optional(),
    subject: z.string().optional(),
    class: z.enum(["IN", "OUTSIDE", "MIXED"]).optional(),
    outsidePaths: z.array(z.string()).optional(),
});

const PlanGroupSchema = z.object({
    name: z.string().min(1),
    branch: z.string().min(1),
    paths: z.array(z.string().min(1)).min(1),
    commits: z.array(PlanCommitSchema),
});

export const RebranchPlanSchema = z.object({
    version: z.literal(1),
    source: z.string().min(1),
    base: z.string().min(1),
    sourceSha: Sha.optional(),
    baseSha: Sha.optional(),
    mergeBase: Sha.optional(),
    groups: z.array(PlanGroupSchema).min(1),
    /** Commits left out of every group on purpose; verify reports their paths as dropped, not lost. */
    skip: z.array(Sha).default([]),
});

export type RebranchPlan = z.infer<typeof RebranchPlanSchema>;
export type PlanGroup = z.infer<typeof PlanGroupSchema>;
export type PlanCommit = z.infer<typeof PlanCommitSchema>;

/** The plan as `plan --json` prints it: the schema plus the analysis it came from. */
export interface PlanDocument extends RebranchPlan {
    baseSource: string;
    commits: { sha: string; subject: string; paths: string[]; classes: Record<string, CommitClass> }[];
    unassigned: { sha: string; subject: string; paths: string[] }[];
    shared: { sha: string; subject: string; groups: string[] }[];
}

/** Parse and validate plan text; throws one error that lists every schema problem. */
export function parsePlanText(text: string, origin: string): RebranchPlan {
    let raw: unknown;

    try {
        raw = SafeJSON.parse(text);
    } catch (err) {
        throw new Error(`${origin}: not valid JSON (${err instanceof Error ? err.message : String(err)})`);
    }

    const parsed = RebranchPlanSchema.safeParse(raw);

    if (!parsed.success) {
        throw new Error(`${origin}: not a rebranch plan\n${z.prettifyError(parsed.error)}`);
    }

    return parsed.data;
}

/** Read a plan from a file, or from stdin for `-`. */
export async function readPlanFile(path: string): Promise<RebranchPlan> {
    if (path === "-") {
        return parsePlanText(await Bun.stdin.text(), "stdin");
    }

    if (!existsSync(path)) {
        throw new Error(`plan file ${path} does not exist`);
    }

    return parsePlanText(await Bun.file(path).text(), path);
}

export interface DraftPlanOptions {
    source: string;
    sourceSha: string;
    base: string;
    baseSha: string;
    baseSource: string;
    mergeBase: string;
    groups: PathGroup[];
    analysis: Analysis;
}

/**
 * The plan `rebranch plan --json` prints: each group lists its IN commits as `whole` and its
 * MIXED commits with `decision: null`, which apply refuses until a person or agent decides.
 */
export function draftPlan(opts: DraftPlanOptions): PlanDocument {
    const { analysis } = opts;

    return {
        version: 1,
        source: opts.source,
        sourceSha: opts.sourceSha,
        base: opts.base,
        baseSha: opts.baseSha,
        baseSource: opts.baseSource,
        mergeBase: opts.mergeBase,
        groups: opts.groups.map((g) => ({
            name: g.name,
            branch: `${opts.source}-${g.name}`,
            paths: g.patterns,
            commits: analysis.commits
                .filter((c) => c.classes[g.name].class !== "OUTSIDE")
                .map((c): PlanCommit => {
                    const cls = c.classes[g.name];

                    if (cls.class === "MIXED") {
                        return {
                            sha: c.sha,
                            subject: c.subject,
                            class: cls.class,
                            decision: null,
                            outsidePaths: cls.outsidePaths,
                        };
                    }

                    return { sha: c.sha, subject: c.subject, class: cls.class, decision: "whole" };
                }),
        })),
        skip: [],
        commits: analysis.commits.map((c) => ({
            sha: c.sha,
            subject: c.subject,
            paths: c.paths,
            classes: Object.fromEntries(Object.entries(c.classes).map(([name, cls]) => [name, cls.class])),
        })),
        unassigned: analysis.unassigned.map((c) => ({ sha: c.sha, subject: c.subject, paths: c.paths })),
        shared: analysis.shared.map((c) => ({ sha: c.sha, subject: c.subject, groups: c.groups })),
    };
}

export interface ResolvedPick {
    sha: string;
    subject: string;
    decision: Decision;
    class: CommitClass;
    /** The commit's paths outside this group's patterns: what `paths-only` restores. */
    outsidePaths: string[];
}

export interface ResolvedGroup {
    name: string;
    branch: string;
    patterns: string[];
    /** In source order, `skip` decisions included. */
    picks: ResolvedPick[];
}

export interface ResolvedPlan {
    source: string;
    base: string;
    groups: ResolvedGroup[];
    /** Full shas of the top-level skip list. */
    skip: string[];
    /** Groups whose commit list was not in source order; apply picks in source order anyway. */
    reordered: string[];
    /** Source commits that are in no group and not in the skip list. */
    unassigned: HistoryCommit[];
}

export interface ResolveResult {
    resolved: ResolvedPlan;
    problems: string[];
}

const short = (sha: string): string => sha.slice(0, 9);

/**
 * Check a plan against the source history (the commits since the merge-base, oldest first) and
 * resolve every sha to a full one. Pure: the caller reads the history. Every problem is
 * collected, so one run names them all.
 */
export function resolvePlan(plan: RebranchPlan, history: HistoryCommit[]): ResolveResult {
    const problems: string[] = [];
    const index = new Map(history.map((c, i) => [c.sha, i]));

    const lookup = (sha: string, where: string): HistoryCommit | null => {
        const hits = history.filter((c) => c.sha.startsWith(sha));

        if (hits.length === 1) {
            return hits[0];
        }

        problems.push(
            hits.length === 0
                ? `${where}: ${sha} is not a commit of ${plan.source} since the merge-base`
                : `${where}: ${sha} is ambiguous (${hits.map((h) => short(h.sha)).join(", ")})`
        );
        return null;
    };

    const skip: string[] = [];

    for (const sha of plan.skip) {
        const hit = lookup(sha, "skip");

        if (hit) {
            skip.push(hit.sha);
        }
    }

    const seenNames = new Set<string>();
    const seenBranches = new Set<string>();
    const listed = new Set<string>();
    const reordered: string[] = [];
    const groups: ResolvedGroup[] = [];

    for (const g of plan.groups) {
        if (seenNames.has(g.name)) {
            problems.push(`group ${g.name} is named twice`);
        }

        if (seenBranches.has(g.branch)) {
            problems.push(`branch ${g.branch} is used by two groups`);
        }

        seenNames.add(g.name);
        seenBranches.add(g.branch);

        const picks: ResolvedPick[] = [];
        const inGroup = new Set<string>();

        for (const entry of g.commits) {
            const commit = lookup(entry.sha, `group ${g.name}`);

            if (!commit) {
                continue;
            }

            if (inGroup.has(commit.sha)) {
                problems.push(`group ${g.name}: ${short(commit.sha)} is listed twice`);
                continue;
            }

            inGroup.add(commit.sha);
            listed.add(commit.sha);
            const cls = classifyPaths(commit.paths, g.paths);
            const decision = entry.decision ?? null;
            const label = `group ${g.name}: ${short(commit.sha)} "${commit.subject}"`;

            if (decision === null && cls.class === "MIXED") {
                problems.push(
                    `${label} is MIXED (outside the group: ${cls.outsidePaths.join(", ")}); set decision to whole, skip or paths-only`
                );
                continue;
            }

            if (decision === "paths-only" && cls.class === "OUTSIDE") {
                problems.push(`${label} changes no path of the group, so paths-only would keep nothing`);
                continue;
            }

            if (decision !== "skip" && skip.includes(commit.sha)) {
                problems.push(`${label} is picked here and also listed in skip`);
            }

            picks.push({
                sha: commit.sha,
                subject: commit.subject,
                decision: decision ?? "whole",
                class: cls.class,
                outsidePaths: cls.outsidePaths,
            });
        }

        const ordered = [...picks].sort((a, b) => (index.get(a.sha) ?? 0) - (index.get(b.sha) ?? 0));

        if (ordered.some((p, i) => p.sha !== picks[i].sha)) {
            reordered.push(g.name);
        }

        if (picks.length > 0 && ordered.every((p) => p.decision === "skip")) {
            problems.push(`group ${g.name} picks nothing (every commit is skip); remove the group`);
        } else if (g.commits.length === 0) {
            problems.push(`group ${g.name} lists no commits; remove the group`);
        }

        groups.push({ name: g.name, branch: g.branch, patterns: g.paths, picks: ordered });
    }

    return {
        resolved: {
            source: plan.source,
            base: plan.base,
            groups,
            skip,
            reordered,
            unassigned: history.filter((c) => !listed.has(c.sha) && !skip.includes(c.sha)),
        },
        problems,
    };
}

/** The picks that become commits: everything but `skip`. */
export function activePicks(group: ResolvedGroup): ResolvedPick[] {
    return group.picks.filter((p) => p.decision !== "skip");
}
