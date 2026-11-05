#!/usr/bin/env bun
/**
 * The brief for an independent read-only review round, which runs when the user asks for one (SKILL.md 7a): on an
 * open PR, or on a PR that already merged. Its findings become the next fix round (`fill-brief --judge`)
 * or, after a merge, a follow-up PR. Writes `<run>/steer-review-<pr>.md`, prints its path, then the
 * `tools codex spawn --mode review` line that starts the reviewer with it.
 *
 *   bun review-brief.ts --run <dir> --pr 517 --wt <worktree> [--base master] [--post-merge] [--swift] [--fresh]
 *   bun review-brief.ts --run <dir> --pr 517 --wt <worktree> --delegate [--effort high|xhigh|max]
 *
 * `--delegate`: for a reviewer started WITHOUT the review harness (a T3 Code `delegate_task` child). The brief then
 * carries what `--mode review` would inject: the diff manifest (one `git diff base...head -- <path>` per file) and
 * the tier's review contract from `@genesiscz/utils/worker/contract`, so the reviewer reads hunks, not whole files
 * (2026-11-05: reviewers told to "read the touched files" covered about 10 of 155 files).
 *
 * The depth rules (read every file, probe each finding, the coverage line) are not in this brief: `--mode review`
 * gives the worker its tier's contract and the diff manifest, and gates the depth after the turn
 * (`tools codex reviews --pr <N>` lists every run).
 *
 * `--fresh`: a PR opened minutes ago, reviewed next to the bots (the first round of a newly cut PR).
 *
 * Hand-edited copies of this text sent a reviewer to another PR's description (2026-10-14: a sed pass left
 * `gh pr view 504` in the #498 and #500 briefs), so every PR reference comes from one value here.
 */

import { join } from "node:path";
import { defaultReviewEffort } from "@app/codex/lib/review/prepare";
import { resolveOpenAiSubModel } from "@genesiscz/utils/ai/openai/sub-models";
import { createGit } from "@genesiscz/utils/git";
import { SafeJSON } from "@genesiscz/utils/json";
import { shellWord } from "@genesiscz/utils/shell/quote";
import {
    manifestLines,
    REVIEW_EFFORTS,
    type ReviewEffort,
    type ReviewManifest,
    reviewLines,
} from "@genesiscz/utils/worker/contract";
import { flag, has, loadRun, reviewScratch } from "./run";

export interface ReviewBriefInput {
    pr: number;
    title: string;
    wt: string;
    base: string;
    scratch: string;
    postMerge: boolean;
    swift: boolean;
    /** A PR opened minutes ago: the bots review it at the same time, so there are no earlier threads yet. */
    fresh?: boolean;
    /** A reviewer without the review harness: the brief carries the diff manifest and the tier's contract. */
    delegate?: { manifest: ReviewManifest; effort: ReviewEffort };
}

export function reviewBrief({
    pr,
    title,
    wt,
    base,
    scratch,
    postMerge,
    swift,
    fresh,
    delegate,
}: ReviewBriefInput): string {
    const why = postMerge
        ? `PR #${pr} ("${title}") already merged into master, and the user asked for one more review. This is an independent review of the MERGED code; your findings become a follow-up PR.`
        : fresh
          ? `PR #${pr} ("${title}") was just opened, and the reviewer bots read it at the same time as you. The lead wants an independent review next to theirs; your findings join the bots' threads in the first fix round.`
          : `The reviewer bot found nothing more to fix on PR #${pr} ("${title}"), so the lead wants an independent review. Your findings become the next fix round.`;
    const read = delegate
        ? "Read the change FILE BY FILE from the manifest at the end of this brief, each file with the diff command it names, never a whole file. To judge a hunk, open only the code around it, and the callers and the tests of the function it changes (git diff, show and log need `--no-textconv --no-ext-diff`, blame and grep need `--no-textconv`, or the read waits for the lead)."
        : postMerge
          ? `It is detached at current master, which contains the PR. Read what the PR changed with \`gh pr diff ${pr}\`, then read the CURRENT version of each touched file in this folder (later PRs may have changed them).`
          : `Base: \`origin/${base}\`. Read the diff with \`git diff --no-textconv --no-ext-diff origin/${base}...HEAD\` (git diff, show and log need both flags, blame and grep need \`--no-textconv\`, or the read waits for the lead), then read the touched files in full where needed.`;
    const lines = [
        `## Independent review of PR #${pr} (read-only)`,
        "",
        `${why} Quality over count: only REAL defects (wrong behaviour, a missed case, a broken contract, a data-loss or security risk, a test that does not test what it claims, a broken repository rule). No style, naming or "consider" notes. "No findings" is a good and acceptable result: do not invent one.`,
        "",
        `- Working folder: \`${wt}\` (cd there first). ${read} Read the area rule files (\`.claude/rules/*.md\`) for those files, and the PR description: \`gh pr view ${pr} --json body --jq .body\`.`,
        fresh
            ? `- The PR has no answered threads yet. Do not wait for the bots and do not read their threads: review the code on your own.`
            : `- Earlier review threads were already answered; read them with \`tools github review ${pr} --llm\` so you do not report a finding that was fixed or deliberately declined (a declined one is fair game only with new evidence).`,
        `- Tests in this repository run as \`timeout 600 bun scripts/test.ts <test files>\`; put any read-only probe under \`${scratch}\`.`,
        ...(swift
            ? [
                  "- Swift: do not run `swift build` or `swift test` (the lead runs them); a Swift claim needs a code quote as evidence.",
              ]
            : []),
        `- Write \`${join(wt, ".claude/work/babysit", `${pr}-review.md`)}\` (create the folder): the same numbered findings, \`Ran\`, \`Files reviewed\` and \`Not reviewed\` lines as your final message, with the evidence under each finding, then a one-line verdict.`,
        "- Change NO source file, commit nothing, post nothing to GitHub. Do NOT run `git checkout`, `git switch`, `bun install` or the hook installer. No app builds, installs, launches or relaunches. Another reviewer may read this same folder, so write only your own review file.",
        "",
        "Then stop with a report: the finding count by severity and the review file path, then RESULT / AT / CHANGED / VERIFY / OPEN.",
        ...(delegate
            ? [
                  "",
                  "## The diff, file by file",
                  "",
                  ...manifestLines(delegate.manifest),
                  "",
                  `## Review contract (the review mode's, \`${delegate.effort}\` tier)`,
                  "",
                  ...reviewLines(delegate.effort),
              ]
            : []),
    ];
    return `${lines.join("\n")}\n`;
}

export interface ReviewSpawnInput {
    pr: number;
    wt: string;
    /** The PR's base branch, without `origin/`. */
    base: string;
    briefPath: string;
    /** After a merge the worktree sits at master: the manifest is the PR's files since its merge commit's parent. */
    postMerge?: { mergeCommit: string; files: string[] };
}

/**
 * The reviewer's spawn line: `--mode review` with the base, so the harness computes the manifest and gates the depth.
 * Every value is one shell word: a file name, branch or path from the repository may hold a space or `$(...)`, and
 * the lead runs this line as printed.
 */
export function reviewSpawnCommand({ pr, wt, base, briefPath, postMerge }: ReviewSpawnInput): string {
    const target = postMerge
        ? ["--base", `${postMerge.mergeCommit}^`, "--paths", ...postMerge.files]
        : ["--base", `origin/${base}`];
    const argv = [
        ...["tools", "codex", "spawn", "--mode", "review", "--pr", String(pr), ...target],
        ...["--name", `bs-${pr}-review`, "--model", resolveOpenAiSubModel("sol"), "--write", "ask", "--cwd", wt],
        ...["--label", `babysit pr${pr} review`, "--prompt-file", briefPath],
    ];

    return argv.map(shellWord).join(" ");
}

interface PrView {
    title: string;
    baseRefName?: string;
    mergeCommit?: { oid?: string } | null;
    files?: Array<{ path: string }>;
}

/** The manifest and tier a reviewer without the review harness gets: the PR's diff from its merge base, per file. */
async function delegateReview(input: {
    wt: string;
    base: string;
    postMerge: boolean;
}): Promise<{ manifest: ReviewManifest; effort: ReviewEffort }> {
    if (input.postMerge) {
        throw new Error("--delegate reviews an open PR; a merged PR's review runs through the spawn line");
    }

    const git = createGit({ cwd: input.wt });
    const head = await git.getSha("HEAD");
    const mergeBase = await git.mergeBase(`origin/${input.base}`, head);
    const entries = await git.numstat({ from: mergeBase, to: head });
    const manifest: ReviewManifest = {
        base: mergeBase,
        head,
        files: entries.map((entry) => ({
            path: entry.path,
            added: entry.insertions,
            deleted: entry.deletions,
            ...(entry.binary ? { binary: true } : {}),
        })),
        added: entries.reduce((sum, entry) => sum + entry.insertions, 0),
        deleted: entries.reduce((sum, entry) => sum + entry.deletions, 0),
    };
    const asked = flag("--effort");
    const effort = REVIEW_EFFORTS.find((tier) => tier === asked) ?? defaultReviewEffort(manifest);

    return { manifest, effort };
}

if (import.meta.main) {
    const run = loadRun();
    const pr = Number(flag("--pr"));
    const wt = flag("--wt");

    if (!Number.isInteger(pr) || pr <= 0 || !wt) {
        console.error(
            "usage: review-brief.ts --run <dir> --pr <N> --wt <worktree> [--base master] [--post-merge] [--swift] [--fresh] [--delegate [--effort high|xhigh|max]]"
        );
        process.exit(2);
    }

    const view = Bun.spawnSync(
        ["gh", "pr", "view", String(pr), "--repo", run.repo, "--json", "title,baseRefName,mergeCommit,files"],
        { stdout: "pipe", stderr: "pipe" }
    );

    if (view.exitCode !== 0) {
        console.error(`✖ gh pr view ${pr}: ${view.stderr.toString().trim()}`);
        process.exit(1);
    }

    const { title, baseRefName, mergeCommit, files } = SafeJSON.parse(view.stdout.toString(), {
        strict: true,
    }) as PrView;
    const base = flag("--base") ?? baseRefName ?? "master";
    const postMerge = has("--post-merge");
    const delegate = has("--delegate") ? await delegateReview({ wt, base, postMerge }) : undefined;
    const out = join(run.dir, `steer-review-${pr}.md`);
    await Bun.write(
        out,
        reviewBrief({
            pr,
            title,
            wt,
            base,
            scratch: reviewScratch(run.dir, pr),
            postMerge,
            swift: has("--swift"),
            fresh: has("--fresh"),
            delegate,
        })
    );
    console.log(out);

    if (delegate) {
        console.log(
            `Start the reviewer with delegate_task (isolation "shared", effort ${delegate.effort}); its task is the text of ${out}. ${delegate.manifest.files.length} files, +${delegate.manifest.added} -${delegate.manifest.deleted}.`
        );
        process.exit(0);
    }

    if (postMerge && !mergeCommit?.oid) {
        console.error(`✖ PR #${pr} has no merge commit, so a post-merge review has no base.`);
        process.exit(1);
    }

    console.log(
        reviewSpawnCommand({
            pr,
            wt,
            base,
            briefPath: out,
            ...(postMerge && mergeCommit?.oid
                ? { postMerge: { mergeCommit: mergeCommit.oid, files: (files ?? []).map((file) => file.path) } }
                : {}),
        })
    );
}
