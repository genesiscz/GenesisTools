#!/usr/bin/env bun
/**
 * Fill references/brief-self-fetch.md for one PR round: the worker fetches and expands the threads itself, fixes
 * them in one commit and writes the reply file. Use it for a worker's FIRST brief; a later round of the same worker
 * is a short steer (SKILL.md, "The run ledger").
 *
 *   bun fill-brief.ts --run <dir> --pr 499 --round 1 --model "GPT-6 Astra" --scopes "GenesisKit, markdown"
 *                     [--swift] [--judge <findings.md>] [--out <file>]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { flag, has, loadRun, worktreeFor } from "./run";

const run = loadRun();
const pr = flag("--pr") ?? "";
const round = Number(flag("--round") ?? "1");
const judgeFile = flag("--judge");
const view = Bun.spawnSync(["gh", "pr", "view", pr, "--repo", run.repo, "--json", "title,headRefName,baseRefName"], {
    stdout: "pipe",
    stderr: "pipe",
});

if (!pr || view.exitCode !== 0) {
    console.error(`cannot read PR ${pr || "(none)"}: ${view.stderr.toString().slice(0, 200)}`);
    process.exit(2);
}

const meta = SafeJSON.parse(view.stdout.toString(), { strict: true }) as {
    title: string;
    headRefName: string;
    baseRefName: string;
};
const policy =
    round <= 2
        ? `Round ${round}: fix EVERY valid finding, critical, high, medium and low.`
        : `Round ${round}: fix only critical and high findings. A new medium or low finding gets a verdict and a reply (no code change unless it is a one-line obvious fix), so the lead can resolve it.`;
// Another repository's run card names its own checks: GenesisTools' commands do not exist there (2026-10-14,
// GenesisPlayground #94 round 2 got `bun scripts/test.ts` and lint-rules in its brief).
const verify = run.verify ? run.verify.map((line) => `   - ${line}`).join("\n") : defaultVerify();

function defaultVerify(): string {
    return [
        "   - `bun scripts/test.ts <the test file of every file you changed>` (never bare `bun test`; it must end with `[test] suite complete`)",
        "   - `./node_modules/@typescript/native-preview-darwin-arm64/lib/tsgo --noEmit` (not `bunx tsgo`: it hangs in /tmp worktrees)",
        "   - `bunx biome check <each changed file>`",
        "   - `bun run lint:rules` and `bun scripts/ci/check-tool-commands.ts`",
        ...(has("--swift") && codexWorker()
            ? [
                  "   - Swift: write the change and its test, but do NOT run `swift build` or `swift test`: the Codex sandbox cannot write clang's module cache (`~/.cache/clang/ModuleCache`), so every attempt fails. Read the area rule files for the package first. Name the Swift tests you added in your report; the lead builds and runs them after your commit.",
              ]
            : []),
        ...(has("--swift") && !codexWorker()
            ? [
                  "   - Swift: build and test the package that holds the changed Swift files (`swift build`, then `swift test --filter <the suites you touched>`, in the folder with its Package.swift). Read the area rule files for the package first. Never launch, quit or touch the user's running apps or windows; no screenshots of the user's screen. One heavy Swift build at a time on this Mac: before each `swift build` or `swift test`, wait until no other one runs (`timeout 1800 sh -c 'while ps -axo comm= | grep -Eq \"/(swift-build|swift-test|swift-package|swift-frontend|xctest)$\"; do sleep 20; done'`; it matches executable paths, because `pgrep -x` misses a build whose process name reads swift-package and `pgrep -f swift` matches this waiting shell itself).",
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
