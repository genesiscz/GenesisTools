/**
 * `tools git rebranch plan | apply | verify`: the non-interactive split. `plan` classifies the
 * source's commits against path groups and prints a plan file, `apply` builds one branch per
 * group from that file, and `verify` proves the split lost nothing. The interactive split stays
 * the default `rebranch` command.
 */

import { type ApplyFlowIo, type ApplyOptions, runApplyFlow } from "@app/git/lib/rebranch/apply-flow";
import { analyseCommits, parseGroupSpec } from "@app/git/lib/rebranch/classify";
import { mergeRefusal, proveSplit, readSourceHistory } from "@app/git/lib/rebranch/history";
import { draftPlan, readPlanFile, resolvePlan } from "@app/git/lib/rebranch/plan";
import { analysisDetails, analysisTable, reportLines } from "@app/git/lib/rebranch/render";
import * as p from "@clack/prompts";
import { isInteractive } from "@genesiscz/utils/cli";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import {
    BaseNotFoundError,
    createGit,
    describeBase,
    detectBase,
    getCurrentBranch,
    loadRepoConfig,
    originDriver,
} from "@genesiscz/utils/git";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger, out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import pc from "picocolors";

const log = logger.scoped("rebranch").log;
const say = (line: string): void => out.println(line);
const short = (sha: string): string => sha.slice(0, 9);

function collectRepeatable(value: string, previous: string[]): string[] {
    return [...previous, value];
}

// ─── plan ────────────────────────────────────────────────────────────

interface PlanOptions {
    groups: string[];
    source?: string;
    base?: string;
    json?: boolean;
    offline?: boolean;
    cwd?: string;
}

async function runPlan(opts: PlanOptions): Promise<number> {
    const cwd = opts.cwd ?? process.cwd();

    if (opts.groups.length === 0) {
        out.log.error("Pass one --groups name=path,path per group.");
        out.log.info(toolCommand("git rebranch plan", "--groups", "api=src/api/**", "--groups", "web=src/web/**"));
        return 2;
    }

    const groups = opts.groups.map(parseGroupSpec);
    const git = createGit({ cwd });
    const source = opts.source ?? (await getCurrentBranch(cwd));

    if (!source) {
        out.log.error("Detached HEAD: pass --source <branch>.");
        return 2;
    }

    const loaded = await loadRepoConfig(cwd);

    for (const problem of loaded.problems) {
        out.log.warn(`config ${loaded.path}: ${problem}`);
    }

    const driver = opts.offline ? null : await originDriver(cwd);
    const base = await detectBase({ cwd, branch: source, flag: opts.base, config: loaded.config, driver });
    const history = await readSourceHistory(git, { source, base: base.ref });

    if (history.merges.length > 0) {
        out.log.error(mergeRefusal(history));
        return 1;
    }

    if (history.commits.length === 0) {
        out.log.error(`${source} has no commits since its merge-base with ${base.ref}.`);
        return 1;
    }

    if (base.source === "inferred") {
        out.log.warn(`the base was inferred (${base.detail}); confirm it, or pass --base to pin it`);
    }

    const analysis = analyseCommits(history.commits, groups);
    log.debug(
        { source, base: base.ref, commits: analysis.commits.length, unassigned: analysis.unassigned.length },
        "rebranch plan: analysed"
    );

    if (opts.json) {
        const doc = draftPlan({
            source,
            sourceSha: history.sourceSha,
            base: base.ref,
            baseSha: history.baseSha,
            baseSource: describeBase(base),
            mergeBase: history.mergeBase,
            groups,
            analysis,
        });
        out.result(SafeJSON.stringify(doc, null, 2));
        return 0;
    }

    const moved = history.baseAhead > 0 ? `, the base gained ${history.baseAhead} commit(s) since` : "";
    say(`source  ${source} (${short(history.sourceSha)}), ${history.commits.length} commit(s)`);
    say(`base    ${describeBase(base)}, merge-base ${short(history.mergeBase)}${moved}`);
    say(`groups  ${groups.map((g) => `${g.name} = ${g.patterns.join(", ")}`).join("  ·  ")}`);
    say(analysisTable(analysis, groups));

    for (const line of analysisDetails(analysis, groups)) {
        say(line);
    }

    const groupArgs = opts.groups.flatMap((g) => ["--groups", `'${g}'`]);
    say("");
    say(pc.bold("Next:"));
    say(`  ${toolCommand("git rebranch plan", ...groupArgs, "--base", base.ref, "--json")} > plan.json`);
    say("  set a decision (whole, skip or paths-only) on every MIXED commit, add or skip the commits in no group");
    say(`  ${toolCommand("git rebranch apply", "--plan", "plan.json", "--dry-run")}`);
    return 0;
}

// ─── apply ───────────────────────────────────────────────────────────

function applyIo(): ApplyFlowIo {
    return {
        say,
        error: (message) => out.log.error(message),
        warn: (message) => out.log.warn(message),
        info: (message) => out.log.info(message),
        success: (message) => out.log.success(message),
        confirm: isInteractive()
            ? async (message) => {
                  const ok = await p.confirm({ message, initialValue: false });

                  return !p.isCancel(ok) && ok;
              }
            : null,
    };
}

// ─── verify ──────────────────────────────────────────────────────────

interface VerifyOptions {
    plan?: string;
    json?: boolean;
    cwd?: string;
}

async function runVerifyCommand(opts: VerifyOptions): Promise<number> {
    if (!opts.plan) {
        out.log.error("Pass --plan <file> (or - for stdin).");
        return 2;
    }

    const cwd = opts.cwd ?? process.cwd();
    const git = createGit({ cwd });
    const plan = await readPlanFile(opts.plan);
    const history = await readSourceHistory(git, { source: plan.source, base: plan.base });

    if (history.merges.length > 0) {
        out.log.error(mergeRefusal(history));
        return 1;
    }

    const { resolved, problems } = resolvePlan(plan, history.commits);

    for (const g of resolved.groups) {
        if (!(await git.branchExists(g.branch))) {
            problems.push(`branch ${g.branch} of group ${g.name} does not exist`);
        }
    }

    if (problems.length > 0) {
        out.log.error(`cannot verify (${problems.length} problem(s)):`);

        for (const problem of problems) {
            say(`  ${problem}`);
        }

        return 1;
    }

    const starts = new Set<string>();

    for (const g of resolved.groups) {
        starts.add(await git.mergeBase(history.baseSha, `refs/heads/${g.branch}`));
    }

    if (starts.size > 1) {
        out.log.error(
            `the group branches start from different commits of ${plan.base} (${[...starts].map(short).join(", ")}); verify them one plan at a time`
        );
        return 1;
    }

    const [baseSha] = starts;
    const proof = await proveSplit({ git, plan: resolved, history, baseSha });

    if (opts.json) {
        out.result({ ...proof.report, expectedFrom: proof.expectedFrom, baseSha });
    } else {
        for (const line of reportLines(proof.report, proof.expectedFrom)) {
            say(line);
        }
    }

    return proof.report.ok ? 0 : 1;
}

// ─── registration ────────────────────────────────────────────────────

async function guarded(name: string, fn: () => Promise<number>): Promise<void> {
    try {
        process.exitCode = await fn();
    } catch (err) {
        if (err instanceof BaseNotFoundError) {
            out.log.error(err.message);
            process.exitCode = 2;
            return;
        }

        log.error({ error: err }, `rebranch ${name} failed`);
        out.log.error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
    }
}

export function registerRebranchSplitCommands(rebranch: Command): void {
    rebranch
        .command("plan")
        .description("Classify the source's commits IN / OUTSIDE / MIXED per path group; writes nothing")
        .option("-g, --groups <name=paths>", "A group: name=pattern,pattern (repeatable)", collectRepeatable, [])
        .option("-s, --source <branch>", "Branch to split (default: the current one)")
        .option("-b, --base <ref>", `Base ref (default: what ${toolCommand("git base")} detects)`)
        .option("--json", "Print the plan file instead of the table")
        .option("--offline", "Skip the PR/MR lookup for the base")
        .option("-C, --cwd <path>", "Repository path")
        .action(async (opts: PlanOptions) => guarded("plan", () => runPlan(opts)));

    rebranch
        .command("apply")
        .description("Build one branch per group from a plan file with git cherry-pick -x, then verify the split")
        .option("-p, --plan <file>", "The plan file, or - for stdin")
        .option("--dry-run", "Print the exact git commands and write nothing")
        .option("--yes", "Skip the single confirmation")
        .option("--continue", "Carry on after a cherry-pick conflict was resolved")
        .option("--abort", "Remove every branch this run created (tagged first) and return to the start")
        .option("-C, --cwd <path>", "Repository path")
        .action(async (opts: ApplyOptions) => guarded("apply", () => runApplyFlow(opts, applyIo())));

    rebranch
        .command("verify")
        .description("Prove existing group branches hold every change of the source; exit 1 naming each loss")
        .option("-p, --plan <file>", "The plan file, or - for stdin")
        .option("--json", "Print the report as JSON")
        .option("-C, --cwd <path>", "Repository path")
        .action(async (opts: VerifyOptions) => guarded("verify", () => runVerifyCommand(opts)));
}
