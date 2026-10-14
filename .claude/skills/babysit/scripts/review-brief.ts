#!/usr/bin/env bun
/**
 * The brief for an independent read-only review round: when the reviewer bot has nothing left on a PR that still
 * needs rounds, or a PR merged with fewer than three. Its findings become the next fix round (`fill-brief --judge`)
 * or, after a merge, a follow-up PR. Writes `<run>/steer-review-<pr>.md` and prints the path for steer.ts.
 *
 *   bun review-brief.ts --run <dir> --pr 517 --wt <worktree> [--base master] [--post-merge] [--swift]
 *
 * Hand-edited copies of this text sent a reviewer to another PR's description (2026-10-14: a sed pass left
 * `gh pr view 504` in the #498 and #500 briefs), so every PR reference comes from one value here.
 */
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { flag, has, loadRun } from "./run";

export interface ReviewBriefInput {
    pr: number;
    title: string;
    wt: string;
    base: string;
    scratch: string;
    postMerge: boolean;
    swift: boolean;
}

export function reviewBrief({ pr, title, wt, base, scratch, postMerge, swift }: ReviewBriefInput): string {
    const why = postMerge
        ? `PR #${pr} ("${title}") merged into master with fewer than three review rounds. This is an independent review of the MERGED code; your findings become a follow-up PR.`
        : `The reviewer bot found nothing more to fix on PR #${pr} ("${title}"), so the lead wants an independent review. Your findings become the next fix round.`;
    const read = postMerge
        ? `It is detached at current master, which contains the PR. Read what the PR changed with \`gh pr diff ${pr}\`, then read the CURRENT version of each touched file in this folder (later PRs may have changed them).`
        : `Base: \`origin/${base}\`. Read the diff with \`git diff origin/${base}...HEAD\`, then read the touched files in full where needed.`;
    const lines = [
        `## Independent review of PR #${pr} (read-only)`,
        "",
        `${why} Quality over count: only REAL defects (wrong behaviour, a missed case, a broken contract, a data-loss or security risk, a test that does not test what it claims, a broken repository rule). No style, naming or "consider" notes. "No findings" is a good and acceptable result: do not invent one.`,
        "",
        `- Working folder: \`${wt}\` (cd there first). ${read} Read the area rule files (\`.claude/rules/*.md\`) for those files, and the PR description: \`gh pr view ${pr} --json body --jq .body\`.`,
        `- Earlier review threads were already answered; read them with \`tools github review ${pr} --llm\` so you do not report a finding that was fixed or deliberately declined (a declined one is fair game only with new evidence).`,
        `- Check every claim: run the relevant tests (\`timeout 600 bun scripts/test.ts <test files>\`) or a small read-only probe under \`${scratch}\`, and paste the real output. A finding without evidence is a guess; say so.`,
        ...(swift
            ? [
                  "- Swift: do not run `swift build` or `swift test` (the lead runs them); a Swift claim needs a code quote as evidence.",
              ]
            : []),
        `- Write \`${join(wt, ".claude/work/babysit", `${pr}-review.md`)}\` (create the folder): one section per finding with severity (Critical, High, Medium, Low), file:line, the defect, the evidence, why it matters, and the smallest fix. End with a one-line verdict.`,
        "- Change NO source file, commit nothing, post nothing to GitHub. Do NOT run `git checkout`, `git switch`, `bun install` or the hook installer. No app builds, installs, launches or relaunches. Another reviewer may read this same folder, so write only your own review file.",
        "",
        "Then stop with a report: the finding count by severity and the review file path, then RESULT / AT / CHANGED / VERIFY / OPEN.",
    ];
    return `${lines.join("\n")}\n`;
}

if (import.meta.main) {
    const run = loadRun();
    const pr = Number(flag("--pr"));
    const wt = flag("--wt");

    if (!Number.isInteger(pr) || pr <= 0 || !wt) {
        console.error(
            "usage: review-brief.ts --run <dir> --pr <N> --wt <worktree> [--base master] [--post-merge] [--swift]"
        );
        process.exit(2);
    }

    const view = Bun.spawnSync(["gh", "pr", "view", String(pr), "--repo", run.repo, "--json", "title"], {
        stdout: "pipe",
        stderr: "pipe",
    });

    if (view.exitCode !== 0) {
        console.error(`✖ gh pr view ${pr}: ${view.stderr.toString().trim()}`);
        process.exit(1);
    }

    const { title } = SafeJSON.parse(view.stdout.toString(), { strict: true }) as { title: string };
    const out = join(run.dir, `steer-review-${pr}.md`);
    await Bun.write(
        out,
        reviewBrief({
            pr,
            title,
            wt,
            base: flag("--base") ?? "master",
            scratch: join(run.dir, "..", `review-${pr}`),
            postMerge: has("--post-merge"),
            swift: has("--swift"),
        })
    );
    console.log(out);
}
