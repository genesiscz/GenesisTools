import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { logger } from "@genesiscz/utils/logger";
import { profiler } from "@genesiscz/utils/profile";
import { alignOffset, type NormalizedCode, normalizeIdentifiers } from "./align.ts";
import { type BuildAtCommitOptions, buildAtCommit, buildFilesDir, git, resolveCommit } from "./build.ts";
import type { SourcemapCache } from "./cache.ts";
import { type DeployedFile, listJsFiles } from "./deployed.ts";
import { type CommitHint, findCommitHints } from "./hints.ts";
import { buildEnvFrom, envFlags, findInlinedEnv, type InlinedEnvValue } from "./inlined-env.ts";
import { type BuildScore, scoreBuild } from "./rank.ts";
import { repoPathsFor } from "./repo-paths.ts";
import type { LocalBuild } from "./resolvers/local-build.ts";
import { loadMap, localMapPath } from "./resolvers/shared.ts";
import { lineColumnAt } from "./source-map.ts";
import { rankCommitsByTokens, type TokenRank, type TokenRanking } from "./token-rank.ts";

const prof = profiler.scope("sourcemaps");

export { repoPathsFor, sourceTail } from "./repo-paths.ts";

const { log } = logger.scoped("ts:sourcemaps:find-commit");

const LOCKFILES = /(^|\/)(bun\.lockb?|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|npm-shrinkwrap\.json)$/;

/**
 * `tokens`: one reference build, every commit in the range ranked by the strings and property names it would
 * put into the bundle, then one build of the winner to confirm it. `rebuild`: trace the differing code to
 * source files and build every commit that touched them.
 */
export const FIND_COMMIT_STRATEGIES = ["tokens", "rebuild"] as const;
export type FindCommitStrategy = (typeof FIND_COMMIT_STRATEGIES)[number];

export type FindCommitEvent =
    | { type: "build"; commit: string; reused: boolean; durationMs: number }
    | { type: "build-start"; commit: string }
    | { type: "hints"; hints: CommitHint[] }
    | { type: "ranked"; top: TokenRank[]; tokens: number }
    | { type: "changed-files"; files: string[]; unmapped: number }
    | { type: "candidates"; commits: string[] }
    | { type: "scored"; commit: string; rate: number };

export interface FindCommitOptions extends Omit<BuildAtCommitOptions, "commit" | "onLine"> {
    deployed: { dir: string; files: DeployedFile[] };
    /** `A..B`: the deployed commit is assumed to be after A and at or before B. */
    range: string;
    /** The reference build. Default: the end of the range. */
    base?: string;
    /** Follow only the first parent (merges count as one step). Default true. */
    firstParent?: boolean;
    /** Default `tokens`. */
    strategy?: FindCommitStrategy;
    /** tokens: build the best-ranked commit to confirm it. Default true. */
    verify?: boolean;
    /** rebuild: upper bound on candidate builds besides the base. Default 8. */
    maxBuilds?: number;
    onEvent?(event: FindCommitEvent): void;
}

export interface CandidateScore {
    commit: string;
    subject: string;
    /** Probe hit rate: how much of the deployed code this build contains. */
    rate: number;
    deployedOnly: number;
    score: BuildScore;
}

/**
 * - `verified`: the best-ranked commit was built and contains more of the deployed code than the reference.
 * - `ranked`: the best-ranked commit is the reference itself (or ties with it), so no second build was needed.
 * - `rebuilt`: the rebuild strategy scored every candidate build.
 * - `weak`: the ranking and the builds disagree, or nothing could be ranked.
 */
export type FindCommitConfidence = "verified" | "ranked" | "rebuilt" | "weak";

export interface FindCommitResult {
    strategy: FindCommitStrategy;
    base: { commit: string; rate: number; deployedOnly: string[]; localOnly: string[] };
    /** tokens: every candidate commit, best first. */
    ranking: TokenRank[];
    rankingTokens: number;
    residual: TokenRanking["residual"];
    /** Builds that were scored against the deployment. */
    candidates: CandidateScore[];
    best: { commit: string; subject: string; error: number | null; rate: number | null } | null;
    /**
     * Commits the evidence cannot tell apart (same strings and names in the bundle), newest first. `best` is the
     * oldest of them: the commit that introduced the deployed code.
     */
    equivalent: string[];
    confidence: FindCommitConfidence;
    /** rebuild: repo paths whose code differs between the base build and the deployment. */
    changedFiles: string[];
    unmappedRegions: number;
    /** Commits of the repo whose full sha appears in the deployed JS. Evidence only, never the answer by itself. */
    hints: CommitHint[];
    /** Env values the bundle inlined; a build without them differs in strings and in dead-code removal. */
    env: InlinedEnvValue[];
    /** The newest Last-Modified of the deployed JS, when the server sent one: the build is no newer. */
    deployedAt: string | null;
    notes: string[];
    buildsUsed: number;
}

async function localBuildOf(cache: SourcemapCache, id: string, label: string): Promise<LocalBuild> {
    const dir = buildFilesDir(cache, id);
    return { dir, files: await listJsFiles(dir), label };
}

/**
 * The deployed files' newest Last-Modified bounds the build time from above, if the server reports upload time.
 * Commits after it cannot be the build; a best commit after it means the dates are rewritten or the ranking is off.
 */
async function noteLastModified(context: {
    options: FindCommitOptions;
    range: string;
    firstParent: string[];
    result: FindCommitResult;
}): Promise<void> {
    const dates = context.options.deployed.files
        .filter((file) => file.lastModified && /\.m?js$/.test(file.path))
        .map((file) => Date.parse(file.lastModified as string));
    if (dates.length === 0) {
        return;
    }

    const newest = Math.max(...dates);
    context.result.deployedAt = new Date(newest).toISOString();
    const history = await git(context.options.repo, ["log", ...context.firstParent, "--format=%H %cI", context.range]);
    const commitTimes = new Map(
        history
            .split("\n")
            .filter(Boolean)
            .map((line) => {
                const [sha, date] = line.split(" ");
                return [sha as string, Date.parse(date as string)] as const;
            })
    );
    const later = [...commitTimes.values()].filter((time) => time > newest).length;
    const at = context.result.deployedAt.slice(0, 16).replace("T", " ");
    context.result.notes.push(
        `the deployed JS was last modified ${at} UTC (newest Last-Modified); ${later} commit(s) in the range are newer, so they cannot be the build if the server keeps upload times`
    );
    const best = context.result.best ? commitTimes.get(context.result.best.commit) : undefined;
    if (best !== undefined && best > newest) {
        context.result.notes.push(
            "the best commit is NEWER than the deployed files: either the server rewrites Last-Modified, or the ranking is wrong; build the oldest commit of the span to check"
        );
    }
}

async function subjectOf(repo: string, commit: string): Promise<string> {
    return git(repo, ["log", "-1", "--format=%s", commit]);
}

/**
 * Finds the commit a deployment was built from. Default strategy: build ONE reference commit, rank every
 * commit in the range by how well its source explains the deployed strings and property names (no build per
 * commit), then build the winner to confirm it. Commit shas that the bundle itself names are reported as
 * evidence and compared with the ranking; they never decide alone.
 */
export async function findDeployedCommit(options: FindCommitOptions): Promise<FindCommitResult> {
    const stopProfile = prof.start("find-commit");
    try {
        const notes: string[] = [];
        const [from, to] = options.range.split("..");
        if (!from || !to) {
            throw new Error(`--range must look like A..B, got '${options.range}'`);
        }

        const strategy = options.strategy ?? "tokens";
        const end = await resolveCommit(options.repo, to);
        const firstParent = options.firstParent !== false ? ["--first-parent"] : [];
        const range = `${from}..${end}`;
        const order = (await git(options.repo, ["rev-list", ...firstParent, range])).split("\n").filter(Boolean);
        if (order.length === 0) {
            throw new Error(`the range ${options.range} has no commits`);
        }

        const hints = await findCommitHints({ repo: options.repo, deployed: options.deployed });
        options.onEvent?.({ type: "hints", hints });
        const env = await findInlinedEnv(options.deployed);
        const wanted = buildEnvFrom(env);
        const differs = Object.entries(wanted).filter(([name, value]) => options.env?.[name] !== value);
        if (differs.length > 0) {
            notes.push(
                `the bundle inlines ${differs.length} env value(s) this build did not get the same; pass them so the build matches: ${envFlags(Object.fromEntries(differs.slice(0, 6))).join(" ")}${differs.length > 6 ? ` (all of them: ${toolCommand("ts", "sourcemaps", "env")})` : ""}`
            );
        }

        let buildsUsed = 0;
        const build = async (commit: string): Promise<LocalBuild> => {
            options.onEvent?.({ type: "build-start", commit });
            const result = await buildAtCommit({ ...options, commit });
            buildsUsed++;
            options.onEvent?.({ type: "build", commit, reused: result.reused, durationMs: result.durationMs });
            return localBuildOf(options.cache, result.entry.id, `build ${commit.slice(0, 12)}`);
        };

        const baseCommit = await resolveCommit(options.repo, options.base ?? end);
        const baseBuild = await build(baseCommit);
        const baseScore = await scoreBuild({ deployed: options.deployed, build: baseBuild });
        if (baseScore.deployedOnly.length > 0) {
            notes.push(
                `${baseScore.deployedOnly.length} deployed chunk(s) have no counterpart in the base build (the chunk set changed in the range)`
            );
        }

        const result: FindCommitResult = {
            strategy,
            base: {
                commit: baseCommit,
                rate: baseScore.rate,
                deployedOnly: baseScore.deployedOnly,
                localOnly: baseScore.localOnly,
            },
            ranking: [],
            rankingTokens: 0,
            residual: [],
            candidates: [],
            best: null,
            equivalent: [],
            confidence: "weak",
            changedFiles: [],
            unmappedRegions: 0,
            hints,
            env,
            deployedAt: null,
            notes,
            buildsUsed: 0,
        };

        if (strategy === "tokens") {
            await rankAndVerify({ options, order, baseCommit, baseBuild, baseScore, build, result });
        } else {
            await narrowByRebuilds({
                options,
                order,
                range,
                firstParent,
                baseCommit,
                baseBuild,
                baseScore,
                build,
                result,
            });
        }

        for (const hint of hints) {
            const named = hint.commit.slice(0, 12);
            if (!order.includes(hint.commit)) {
                notes.push(`the bundle names commit ${named} ${hint.occurrences}x; it is outside the range`);
            } else if (result.equivalent.includes(hint.commit) || result.best?.commit === hint.commit) {
                notes.push(`the bundle names commit ${named} ${hint.occurrences}x; the code evidence agrees`);
            } else {
                notes.push(
                    `the bundle names commit ${named} ${hint.occurrences}x, but the code evidence points elsewhere; trust the code`
                );
            }
        }

        await noteLastModified({ options, range, firstParent, result });
        result.buildsUsed = buildsUsed;
        log.info(
            { strategy, best: result.best?.commit, confidence: result.confidence, builds: buildsUsed },
            "find-commit done"
        );
        return result;
    } finally {
        stopProfile();
    }
}

async function rankAndVerify(context: {
    options: FindCommitOptions;
    order: string[];
    baseCommit: string;
    baseBuild: LocalBuild;
    baseScore: BuildScore;
    build(commit: string): Promise<LocalBuild>;
    result: FindCommitResult;
}): Promise<void> {
    const { options, order, baseCommit, baseBuild, baseScore, result } = context;
    const candidates = order.includes(baseCommit) ? order : [...order, baseCommit];
    const preferDir = dirname(options.outputDir) === "." ? undefined : dirname(options.outputDir);
    const ranked = await rankCommitsByTokens({
        repo: options.repo,
        deployed: options.deployed,
        reference: { dir: baseBuild.dir, files: baseBuild.files, commit: baseCommit },
        candidates,
        preferDir,
    });
    options.onEvent?.({ type: "ranked", top: ranked.ranking.slice(0, 8), tokens: ranked.tokens });
    result.ranking = ranked.ranking;
    result.rankingTokens = ranked.tokens;
    result.residual = ranked.residual;
    result.notes.push(...ranked.notes);
    result.candidates.push({
        commit: baseCommit,
        subject: await subjectOf(options.repo, baseCommit),
        rate: baseScore.rate,
        deployedOnly: baseScore.deployedOnly.length,
        score: baseScore,
    });

    const top = ranked.ranking[0];
    if (!top || ranked.tokens === 0) {
        result.notes.push("no string or property name differs between the candidates; use --strategy rebuild");
        return;
    }

    const tied = ranked.ranking.filter((entry) => entry.error === top.error).map((entry) => entry.commit);
    result.equivalent = order.filter((commit) => tied.includes(commit));
    const runnerUp = ranked.ranking.find((entry) => entry.error > top.error);
    if (runnerUp && runnerUp.error - top.error < Math.max(3, 0.1 * top.error)) {
        result.notes.push(
            `the next commit fits almost as well (error ${top.error} vs ${runnerUp.error}); the confirming build decides`
        );
    }

    if (ranked.ranking.some((entry) => tied.includes(entry.commit) && entry.lockfileDiffers)) {
        result.notes.push(
            "a lockfile differs from the reference: dependency code is not ranked, only the build checks it"
        );
    }

    // Every commit of the span puts the same strings into the bundle; the oldest one introduced them.
    const introducing = result.equivalent.at(-1) ?? top.commit;
    result.best = {
        commit: introducing,
        subject: await subjectOf(options.repo, introducing),
        error: top.error,
        rate: tied.includes(baseCommit) ? baseScore.rate : null,
    };
    if (tied.includes(baseCommit)) {
        result.confidence = "ranked";
        return;
    }

    if (options.verify === false) {
        result.notes.push("not confirmed by a build (--no-verify)");
        return;
    }

    const local = await context.build(introducing);
    const score = await scoreBuild({ deployed: options.deployed, build: local });
    options.onEvent?.({ type: "scored", commit: introducing, rate: score.rate });
    result.candidates.push({
        commit: introducing,
        subject: result.best.subject,
        rate: score.rate,
        deployedOnly: score.deployedOnly.length,
        score,
    });
    result.best.rate = score.rate;
    const better =
        score.deployedOnly.length < baseScore.deployedOnly.length ||
        (score.deployedOnly.length === baseScore.deployedOnly.length && score.rate > baseScore.rate);
    if (better) {
        result.confidence = "verified";
        return;
    }

    result.notes.push(
        `the best-ranked commit builds no closer to the deployment than the reference (${(100 * score.rate).toFixed(3)}% vs ${(100 * baseScore.rate).toFixed(3)}%); check with --strategy rebuild`
    );
}

/**
 * The rebuild strategy: find the deployed code the base does not contain, trace it through the base's maps to
 * source files, ask git which commits in the range touched them, build only those, rank them.
 */
async function narrowByRebuilds(context: {
    options: FindCommitOptions;
    order: string[];
    range: string;
    firstParent: string[];
    baseCommit: string;
    baseBuild: LocalBuild;
    baseScore: BuildScore;
    build(commit: string): Promise<LocalBuild>;
    result: FindCommitResult;
}): Promise<void> {
    const { options, order, range, firstParent, baseCommit, baseBuild, baseScore, result } = context;
    const differing = baseScore.chunks.filter((chunk) => chunk.similarity.rate < 1);
    const tracked = (await git(options.repo, ["ls-files"])).split("\n").filter(Boolean);
    const preferDir = dirname(options.outputDir) === "." ? undefined : dirname(options.outputDir);
    const changed = new Set<string>();
    let unmapped = 0;
    let dependencyChange = false;
    const normalized = new Map<string, NormalizedCode>();
    const normalizedOf = async (path: string): Promise<{ raw: string; norm: NormalizedCode }> => {
        const raw = await readFile(path, "utf8");
        let norm = normalized.get(path);
        if (!norm) {
            norm = normalizeIdentifiers(raw);
            normalized.set(path, norm);
        }

        return { raw, norm };
    };

    for (const chunk of differing) {
        const deployed = await normalizedOf(join(options.deployed.dir, chunk.deployed));
        const local = await normalizedOf(join(baseBuild.dir, chunk.local));
        const mapPath = await localMapPath(baseBuild.dir, chunk.local, local.raw);
        if (!mapPath) {
            unmapped += chunk.similarity.missedAt.length;
            continue;
        }

        const map = await loadMap(mapPath);
        const sample = chunk.similarity.missedAt.filter((_, index, all) => index % Math.ceil(all.length / 40) === 0);
        const traceSide = (offsets: number[]): string | null => {
            for (const anchor of offsets) {
                if (anchor < 0 || anchor >= deployed.raw.length) {
                    continue;
                }

                const aligned = alignOffset({ from: deployed.norm, to: local.norm, offset: anchor });
                if (aligned.confidence !== "unique") {
                    continue;
                }

                const position = map.originalPositionFor(lineColumnAt(local.raw, aligned.offset));
                if (position) {
                    return position.source;
                }
            }

            return null;
        };
        for (const missed of sample) {
            // Only an INTERIOR difference (matching code on both sides) means the code changed. A miss with no
            // match before it is an injected prefix (a monitoring snippet); with none after it, a suffix.
            const before = traceSide([missed - 160, missed - 400]);
            const after = traceSide([missed + 260, missed + 600]);
            if (!before || !after) {
                unmapped++;
                continue;
            }

            for (const source of new Set([before, after])) {
                if (source.includes("node_modules/")) {
                    dependencyChange = true;
                }

                for (const path of repoPathsFor({ source, tracked, preferDir })) {
                    changed.add(path);
                }
            }
        }
    }

    if (dependencyChange) {
        for (const path of tracked.filter((candidate) => LOCKFILES.test(candidate))) {
            changed.add(path);
        }

        result.notes.push("some differing code comes from node_modules, so lockfile changes count as candidates");
    }

    const changedFiles = [...changed].sort();
    result.changedFiles = changedFiles;
    result.unmappedRegions = unmapped;
    options.onEvent?.({ type: "changed-files", files: changedFiles, unmapped });
    const touching: Array<{ commit: string; subject: string }> = [];
    for (let i = 0; i < changedFiles.length; i += 200) {
        const output = await git(options.repo, [
            "log",
            ...firstParent,
            "--format=%H%x09%s",
            range,
            "--",
            ...changedFiles.slice(i, i + 200),
        ]);
        for (const line of output.split("\n").filter(Boolean)) {
            const [commit, subject] = line.split("\t");
            if (!touching.some((entry) => entry.commit === commit)) {
                touching.push({ commit, subject: subject ?? "" });
            }
        }
    }

    touching.sort((a, b) => order.indexOf(a.commit) - order.indexOf(b.commit));
    const maxBuilds = options.maxBuilds ?? 8;
    if (touching.length > maxBuilds) {
        result.notes.push(
            `${touching.length} commits touch the changed files; only the newest ${maxBuilds} were built`
        );
    }

    const candidates = touching.slice(0, maxBuilds);
    if (!candidates.some((candidate) => candidate.commit === baseCommit) && order.includes(baseCommit)) {
        candidates.push({ commit: baseCommit, subject: await subjectOf(options.repo, baseCommit) });
    }

    options.onEvent?.({ type: "candidates", commits: candidates.map((candidate) => candidate.commit) });
    // With nothing differing, an empty key set would score no chunk at all and a perfect match would read as 0.
    const keys = differing.length > 0 ? new Set(differing.map((chunk) => chunk.key)) : undefined;
    const scored: CandidateScore[] = [];
    for (const candidate of candidates) {
        if (options.signal?.aborted) {
            result.notes.push("stopped early (aborted)");
            break;
        }

        const local = candidate.commit === baseCommit ? baseBuild : await context.build(candidate.commit);
        const score = await scoreBuild({ deployed: options.deployed, build: local, onlyKeys: keys });
        options.onEvent?.({ type: "scored", commit: candidate.commit, rate: score.rate });
        scored.push({ ...candidate, rate: score.rate, deployedOnly: score.deployedOnly.length, score });
    }

    scored.sort((a, b) => a.deployedOnly - b.deployedOnly || b.rate - a.rate);
    result.candidates = scored;
    const best = scored[0];
    if (!best) {
        return;
    }

    result.best = { commit: best.commit, subject: best.subject, error: null, rate: best.rate };
    result.confidence = "rebuilt";
    const bestIndex = order.indexOf(best.commit);
    const newerTouching = touching
        .map((entry) => order.indexOf(entry.commit))
        .filter((index) => index >= 0 && index < bestIndex);
    const stop = newerTouching.length > 0 ? Math.max(...newerTouching) + 1 : 0;
    result.equivalent = order.slice(stop, bestIndex + 1);
    if (scored[1] && Math.abs(scored[1].rate - best.rate) < 1e-6 && scored[1].deployedOnly === best.deployedOnly) {
        result.notes.push(
            `${best.commit.slice(0, 12)} and ${scored[1].commit.slice(0, 12)} score the same; the evidence cannot separate them`
        );
    }
}
