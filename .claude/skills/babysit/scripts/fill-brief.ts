#!/usr/bin/env bun
/**
 * Fill references/brief-self-fetch.md for one PR round: the worker fetches and expands the threads itself, fixes
 * them in one commit and writes the reply file. Use it for a worker's FIRST brief; a later round of the same worker
 * is a short steer (SKILL.md, "The run ledger").
 *
 *   bun fill-brief.ts --run <dir> --pr 499 --round 1 --model "GPT-6 Astra" --scopes "GenesisKit, markdown"
 *                     [--swift] [--judge <findings.md>] [--dedicated-review] [--out <file>]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { formatStack, type StackPr } from "./fill-brief-stack";
import { roundPolicy } from "./policy";
import { flag, has, loadRun, worktreeFor } from "./run";

const run = loadRun();
const pr = flag("--pr") ?? "";
const round = Number(flag("--round") ?? "1");
const judgeFile = flag("--judge");
const view = Bun.spawnSync(
    ["gh", "pr", "view", pr, "--repo", run.repo, "--json", "number,title,headRefName,baseRefName,changedFiles"],
    {
        stdout: "pipe",
        stderr: "pipe",
    }
);

if (!pr || view.exitCode !== 0) {
    console.error(`cannot read PR ${pr || "(none)"}: ${view.stderr.toString().slice(0, 200)}`);
    process.exit(2);
}

const meta = SafeJSON.parse(view.stdout.toString(), { strict: true }) as {
    number: number;
    title: string;
    headRefName: string;
    baseRefName: string;
    changedFiles: number;
};
const policy = roundPolicy({ round, changedFiles: meta.changedFiles, dedicatedReview: has("--dedicated-review") }).text;
const ghApi = (endpoint: string, args: string[] = []): string => {
    const result = Bun.spawnSync(["gh", "api", endpoint, ...args], {
        stdout: "pipe",
        stderr: "pipe",
    });
    if (result.exitCode !== 0) {
        console.error(`cannot read GitHub API ${endpoint}: ${result.stderr.toString().slice(0, 200)}`);
        process.exit(2);
    }

    return result.stdout.toString();
};
const defaultBranch = ghApi(`repos/${run.repo}`, ["--jq", ".default_branch"]).trim();
interface ApiPull {
    number: number;
    head: { ref: string };
    base: { ref: string };
}
const pages: ApiPull[][] = SafeJSON.parse(
    ghApi(`repos/${run.repo}/pulls?state=open&per_page=100`, ["--paginate", "--slurp"]),
    { strict: true }
);
const openPrs: StackPr[] = pages.flat().map((pull) => ({
    number: pull.number,
    headRefName: pull.head.ref,
    baseRefName: pull.base.ref,
}));
const filePages: { filename: string }[][] = SafeJSON.parse(
    ghApi(`repos/${run.repo}/pulls/${meta.number}/files?per_page=100`, ["--paginate", "--slurp"]),
    { strict: true }
);
const files =
    filePages
        .flat()
        .map((file) => `- \`${file.filename}\``)
        .join("\n") || "No changed files.";
const stack = formatStack({
    pr: { number: meta.number, headRefName: meta.headRefName, baseRefName: meta.baseRefName },
    openPrs,
    defaultBranch,
});
// Another repository's run card names its own checks: GenesisTools' commands do not exist there (2026-10-14,
// GenesisPlayground #94 round 2 got `bun scripts/test.ts` and lint-rules in its brief).
const verify = run.verify ? run.verify.map((line) => `   - ${line}`).join("\n") : defaultVerify();

function defaultVerify(): string {
    return [
        "   - `bun scripts/test.ts <the test file of every file you changed>` (never bare `bun test`; it must end with `[test] suite complete`)",
        "   - `./node_modules/@typescript/typescript-darwin-arm64/lib/tsc --noEmit` (TypeScript 7; not `bunx tsc`: it hangs in /tmp worktrees)",
        "   - `bunx biome check <each changed file>`",
        "   - `bun run lint:rules` and `bun scripts/ci/check-tool-commands.ts`",
        ...(has("--swift") && codexWorker()
            ? [
                  "   - Swift: write the change and its test, but do NOT run `swift build` or `swift test`: the Codex sandbox cannot write clang's module cache (`~/.cache/clang/ModuleCache`), so every attempt fails. Read the area rule files for the package first. Name the Swift tests you added in your report; the lead builds and runs them after your commit.",
              ]
            : []),
        ...(has("--swift") && !codexWorker()
            ? [
                  `   - Swift: from the folder with Package.swift, use the kernel-locked slot for BOTH commands: \`bun ${join(import.meta.dir, "swift-slot.ts")} --wait-minutes 40 -- swift build\`, then \`bun ${join(import.meta.dir, "swift-slot.ts")} --wait-minutes 40 -- swift test --filter <the suites you touched>\`. Read the package area rules first. Never launch, quit or touch running apps or windows; no screenshots of the screen. Never run a heavy Swift command outside the slot.`,
              ]
            : []),
    ].join("\n");
}
/** Codex workers (GPT models) run in a sandbox that cannot build Swift (2026-10-16: #533 round 1 stopped on it). */
function codexWorker(): boolean {
    return /gpt|sol|astra|luna|codex/i.test(flag("--model") ?? "GPT-6.1 Sol");
}

const judgeSection = judgeFile
    ? `## The lead's judge findings on your earlier commit (fix these in this round too)\n\n${readFileSync(judgeFile, "utf8").trim()}\n\nTreat each like a review finding: fix it, test it where behaviour changes, and add one reply item per finding with no threadId and reviewer "lead".\n\n`
    : "";
const text = readFileSync(join(import.meta.dir, "../references/brief-self-fetch.md"), "utf8")
    .replaceAll("{{ROUND}}", String(round))
    .replaceAll("{{PR}}", pr)
    .replaceAll("{{REPO}}", run.repo)
    // --wt for a worktree not named after its PR (2026-10-14: #517 lived in bs-hooks, the brief said bs-517, and
    // the worker rightly stopped to ask).
    .replaceAll("{{CWD}}", flag("--wt") ?? worktreeFor(run, pr))
    .replaceAll("{{BRANCH}}", meta.headRefName)
    .replaceAll("{{BASE}}", meta.baseRefName)
    .replaceAll("{{TITLE}}", meta.title)
    .replaceAll("{{STACK}}", stack)
    .replaceAll("{{FILES}}", files)
    .replaceAll("{{SCOPES}}", flag("--scopes") ?? "tools")
    .replaceAll("{{MODEL_LABEL}}", flag("--model") ?? "GPT-6.1 Sol")
    .replaceAll("{{ROUND_POLICY}}", policy)
    .replaceAll("{{VERIFY}}", verify)
    .replace("## 2. Fix", `${judgeSection}## 2. Fix`)
    // Another repository (run.json `verify`) has no GenesisTools install in its worktree.
    .replace("; `node_modules` is installed.", run.verify ? "." : "; `node_modules` is installed.");

if (text.includes("{{")) {
    console.error(`unfilled placeholder left: ${text.match(/\{\{[A-Z_]+\}\}/)?.[0]}`);
    process.exit(2);
}

const out = flag("--out") ?? join(run.dir, `brief-${pr}-r${round}.md`);
writeFileSync(out, text);
console.log(out);
