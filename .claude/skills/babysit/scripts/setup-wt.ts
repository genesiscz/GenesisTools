#!/usr/bin/env bun
/**
 * A worker worktree for one PR, ready to test without a full install:
 * detached at the PR head; dependencies installed with --ignore-scripts plus the repo's patches; the test wrapper's
 * install stamp written (else `scripts/test.ts` runs a full `bun install`); native files linked to the main checkout's
 * already-assessed copies (link-native.ts); nested app node_modules linked to the main checkout's.
 *
 *   bun setup-wt.ts --run <dir> --pr 499 [--branch <head branch>]
 *
 * An existing worktree moves to the fetched PR head only when clean and its HEAD is reachable from that head, or
 * every commit it holds is in that head by patch (a restack).
 * Unpublished, divergent or unverifiable history stops for an explicit recovery decision; no worker commit is discarded.
 */
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { linkNativeFiles } from "./link-native";
import { flag, loadRun, worktreeFor } from "./run";
import { ensureConfigHooks, HOOKS_OFF } from "./versions";

const run = loadRun();
const pr = flag("--pr") ?? "";
const branch =
    flag("--branch") ??
    (
        SafeJSON.parse(
            Bun.spawnSync(["gh", "pr", "view", pr, "--repo", run.repo, "--json", "headRefName"], {
                stdout: "pipe",
            }).stdout.toString(),
            { strict: true }
        ) as { headRefName: string }
    ).headRefName;
const wt = worktreeFor(run, pr);
const logs = join(run.dir, "logs");
mkdirSync(logs, { recursive: true });
const log: string[] = [];

function step(cmd: string[], cwd: string, label: string): void {
    const p = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe", env: env.getProcessEnv() });
    log.push(`$ ${cmd.join(" ")} → ${p.exitCode}`, p.stdout.toString(), p.stderr.toString());

    if (p.exitCode !== 0) {
        writeFileSync(join(logs, `setup-${pr}.log`), log.join("\n"));
        console.error(`✖ ${label} failed (log: ${join(logs, `setup-${pr}.log`)})`);
        process.exit(1);
    }
}

if (!pr || !branch) {
    console.error("usage: setup-wt.ts --run <dir> --pr <N> [--branch <head branch>]");
    process.exit(2);
}

step(["git", "fetch", "-q", "origin", branch], run.main, "fetch");
// The repo's hooks would lock or index the throwaway worktree; it gets none.
if (existsSync(wt)) {
    const dirty = Bun.spawnSync(["git", "status", "--porcelain", "--untracked-files=no"], { cwd: wt, stdout: "pipe" });

    if (dirty.exitCode !== 0 || dirty.stdout.toString().trim() !== "") {
        console.error(`✖ ${wt} has tracked changes (or is no worktree): commit or move them, then run again`);
        process.exit(1);
    }

    const published = Bun.spawnSync(["git", "merge-base", "--is-ancestor", "HEAD", `origin/${branch}`], {
        cwd: wt,
        stdout: "pipe",
        stderr: "pipe",
        env: env.getProcessEnv(),
        timeout: 30_000,
    });
    // A restack (rebase plus force-push) leaves the old HEAD off the new head's ancestry while every one of its
    // commits is there by patch; `git cherry` marks such commits "-", and one "+" means real unpublished work.
    const cherry =
        published.exitCode === 1
            ? Bun.spawnSync(["git", "cherry", `origin/${branch}`, "HEAD"], {
                  cwd: wt,
                  stdout: "pipe",
                  stderr: "pipe",
                  env: env.getProcessEnv(),
                  timeout: 30_000,
              })
            : null;
    const restacked =
        cherry?.exitCode === 0 &&
        !cherry.stdout
            .toString()
            .split("\n")
            .some((line) => line.startsWith("+"));

    if (published.exitCode !== 0 && !restacked) {
        const reason =
            published.exitCode === 1
                ? "has unpublished or divergent commits relative to origin/" + branch
                : "cannot verify HEAD is published in origin/" + branch;
        console.error("✖ " + wt + " " + reason + "; preserve or recover that HEAD before running setup again");
        if (published.stderr.length > 0) {
            console.error(published.stderr.toString().trim());
        }
        process.exit(1);
    }

    step(["git", ...HOOKS_OFF, "checkout", "-q", "--detach", `origin/${branch}`], wt, "checkout the new head");
} else {
    step(["git", ...HOOKS_OFF, "worktree", "add", "-q", "--detach", wt, `origin/${branch}`], run.main, "worktree add");
}
step(["bun", "install", "--ignore-scripts"], wt, "bun install");
console.log(`hooks: ${ensureConfigHooks(run.main)}`);

if (existsSync(join(wt, "scripts/apply-patches.ts"))) {
    step(["bun", "scripts/apply-patches.ts"], wt, "apply-patches");
}

const testDeps = join(wt, "scripts/test-deps.ts");

if (existsSync(testDeps)) {
    const { lockStamp, STAMP_FILE } = (await import(testDeps)) as {
        lockStamp: (root: string) => string;
        STAMP_FILE: string;
    };
    writeFileSync(join(wt, "node_modules", STAMP_FILE), lockStamp(wt));
}

const native = linkNativeFiles({ worktree: wt, main: run.main });

for (const nested of ["apps/eve"]) {
    const target = join(run.main, nested, "node_modules");

    if (existsSync(join(wt, nested)) && !existsSync(join(wt, nested, "node_modules")) && existsSync(target)) {
        symlinkSync(target, join(wt, nested, "node_modules"));
    }
}

writeFileSync(join(logs, `setup-${pr}.log`), log.join("\n"));
const head = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], { cwd: wt, stdout: "pipe" })
    .stdout.toString()
    .trim();
console.log(`ready bs-${pr} at ${head} (${branch}); native files linked ${native.linked}, differ ${native.differ}`);
