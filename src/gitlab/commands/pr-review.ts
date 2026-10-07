/**
 * `gitlab pr review`: the reviewer's twin of `fetch-review`. The facts a review of someone else's
 * MR needs, as JSON (default), markdown (`--md`), a compact ref view (`--llm`, drill down with
 * `--expand f1,t2`), only a summary on stderr (`--format summary`), or a review proposal skeleton
 * (`--proposal-skeleton`). Read-only on GitLab; git is fetched only by `--impact-source git`. Writes
 * `<tmp>/gitlab-pr-<project>-<host+project hash>-<iid>.{json,md}` unless `--out` names the report.
 * The `gt:review-proposal` skill says how to fill the proposal and push it with `tools hub proposal push`.
 *
 * `gitlab give-review` is the same command with older defaults: `--impact-source git`, only the
 * summary (on stderr, like every progress line), and `<tmp>/gitlab-give-review-<iid>.{md,json}`.
 *
 *   tools gitlab pr review 42 --repo ~/code/app
 *   tools gitlab pr review 42 --llm
 *   tools gitlab pr review 42 --expand f3,t1
 *   tools gitlab pr review 42 --drafts-only --md
 *   tools gitlab pr review 42 --proposal-skeleton > proposal.json
 *   tools gitlab give-review 42 --cwd ~/code/app-feature --print
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { progress, type TargetOptions, withProject } from "@app/gitlab/commands/shared";
import { resolveProjectApi } from "@app/gitlab/lib/client";
import { loadConfig } from "@app/gitlab/lib/config";
import { gitResult } from "@app/gitlab/lib/git";
import {
    checkoutOf,
    collectPrReviewFacts,
    DEFAULT_IMPACT_LIMIT,
    IMPACT_SOURCES,
    type ImpactSource,
    type PrReviewFacts,
} from "@app/gitlab/lib/pr-review";
import {
    expandRefs,
    formatPrReviewLLM,
    proposalSkeleton,
    type ReportExtras,
    renderDraftsOnlyMarkdown,
    renderPrReviewMarkdown,
} from "@app/gitlab/lib/pr-review-output";
import { collectThreadContext } from "@app/gitlab/lib/review-render";
import { isInteractive, suggestEnumFlag } from "@genesiscz/utils/cli";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger, out } from "@genesiscz/utils/logger";
import * as p from "@genesiscz/utils/prompts/p";
import type { Command } from "commander";

const FORMATS = ["json", "md", "llm", "summary"] as const;
type Format = (typeof FORMATS)[number];

interface Options extends TargetOptions {
    repo?: string;
    cwd?: string;
    worktree?: string;
    format?: string | true;
    json?: boolean;
    md?: boolean;
    llm?: boolean;
    print?: boolean;
    out?: string;
    expand?: string;
    refresh?: boolean;
    proposalSkeleton?: boolean;
    agent: string;
    contextLines: string;
    impact?: boolean;
    impactLimit: string;
    impactSource?: string | true;
    draftsOnly?: boolean;
    threads?: boolean;
}

interface FactsKey {
    host: string;
    /** The project as resolved: a path, or a numeric id the saved facts name by its path. */
    project: string;
    iid: number;
}

/** One registration of the review command: its name and the defaults that differ between doors. */
interface ReviewDoor {
    /** Command words after `gitlab`, also used in hints. */
    words: string[];
    format: Format;
    impactSource: ImpactSource;
    /** `--cwd` also pins the worktree, as the older door did. */
    cwdIsWorktree: boolean;
    /** The report path when `--out` is not given. */
    defaultReport: (key: FactsKey, draftsOnly: boolean) => string;
}

const PR_REVIEW: ReviewDoor = {
    words: ["pr", "review"],
    format: "json",
    impactSource: "api",
    cwdIsWorktree: false,
    defaultReport: (key, draftsOnly) => join(tmpdir(), `${factsBaseName(key)}${draftsOnly ? "-drafts" : ""}.md`),
};

const GIVE_REVIEW: ReviewDoor = {
    words: ["give-review"],
    format: "summary",
    impactSource: "git",
    cwdIsWorktree: true,
    defaultReport: (key, draftsOnly) =>
        join(tmpdir(), `gitlab-give-review-${key.iid}${draftsOnly ? "-drafts" : ""}.md`),
};

function reviewOptions(cmd: Command, door: ReviewDoor): Command {
    return withProject(
        cmd
            .argument("<mr-iid>", "MR IID (the small number in the URL)")
            .option(
                "--repo <checkout>",
                "Local checkout of the project: file links, the MR worktree, and a git diff with --context-lines (default: the current checkout when --project is not given)"
            )
            .option(
                "--cwd <checkout>",
                door.cwdIsWorktree
                    ? "The MR worktree, used as given even when its HEAD is on another branch (same as --repo X --worktree X)"
                    : "Same as --repo"
            )
            .option("--worktree <dir>", "Use this directory as the MR worktree even when its HEAD is on another branch")
            .option("--format [fmt]", `stdout: ${FORMATS.join(" | ")} (default ${door.format})`)
            .option("--json", "Same as --format json")
            .option("--md", "Same as --format md: the markdown report")
            .option("--llm", "Same as --format llm: a compact view with refs (f1 files, t1 threads, d1 drafts, m1 MRs)")
            .option("--print", "Print the markdown report to stdout (same as --md)")
            .option("--out <file>", "Write the markdown report here, the facts JSON beside it")
            .option("--expand <refs>", "Print these refs in full, e.g. f2,t1 (reads the saved facts)")
            .option("--refresh", "With --expand: collect the facts again instead of reading the saved ones")
            .option("--proposal-skeleton", "Print a review proposal JSON pre-filled from the facts")
            .option("--agent <name>", "author.agent in the proposal skeleton", "agent")
            .option("--context-lines <n>", "Unchanged lines around each hunk when the diff comes from local git", "8")
            .option("--no-impact", "Skip the scan of other open MRs")
            .option(
                "--impact-limit <n>",
                "With --impact-source api: read the diffs of at most <n> other open MRs, the most recently updated first",
                String(DEFAULT_IMPACT_LIMIT)
            )
            .option(
                "--impact-source [source]",
                `${IMPACT_SOURCES.join(" | ")} (default ${door.impactSource}): api reads each MR's diff from GitLab; git fetches every open branch and diffs locally (needs a checkout, no cap)`
            )
            .option(
                "--drafts-only",
                "Only my pending drafts, each in full with the code at its anchor; no impact scan (critique your own review)"
            )
            .option(
                "--threads",
                "Add every unresolved diff thread in full: all notes, the local code and the reviewer's frozen view"
            )
    ).action((mrIid: string, opts: Options) => runPrReview(mrIid, opts, door));
}

export function registerPrReview(parent: Command): Command {
    const pr = parent.command("pr").description("Review someone else's merge request");

    reviewOptions(
        pr
            .command("review")
            .description(
                "Facts for reviewing an MR: hunks with line numbers, threads, my drafts, affected open MRs, gates"
            ),
        PR_REVIEW
    );

    return pr;
}

/** The same command under its older name, with its older defaults. */
export function registerGiveReview(parent: Command): Command {
    return reviewOptions(
        parent
            .command("give-review")
            .description(
                "Same as `pr review` with older defaults: git impact scan, only a summary (stderr), $TMPDIR/gitlab-give-review-<iid>.md"
            ),
        GIVE_REVIEW
    );
}

async function pickEnum<T extends string>(
    values: readonly T[],
    value: string | true,
    door: ReviewDoor,
    flag: string
): Promise<T | null> {
    const match = values.find((candidate) => candidate === value);

    if (match) {
        return match;
    }

    if (value === true && isInteractive()) {
        const picked = await p.select({ message: flag, options: values.map((v) => ({ value: v, label: v })) });

        return p.isCancel(picked) ? null : (values.find((v) => v === picked) ?? null);
    }

    out.log.error(
        suggestEnumFlag(toolCommand(`gitlab ${door.words.join(" ")}`), flag, values, {
            subcommand: door.words,
            given: typeof value === "string" ? value : undefined,
        })
    );

    return null;
}

async function pickFormat(opts: Options, door: ReviewDoor): Promise<Format | null> {
    const flags = [opts.json && "json", (opts.md || opts.print) && "md", opts.llm && "llm"].filter(
        (value): value is Format => typeof value === "string"
    );
    const given = typeof opts.format === "string" ? opts.format : undefined;
    const requested = new Set([...flags, ...(given ? [given] : [])]);

    if (requested.size > 1) {
        out.log.error(`Pick one output: ${[...requested].join(", ")} were all requested.`);
        return null;
    }

    const value = [...requested][0];

    if (value === undefined && opts.format !== true) {
        return door.format;
    }

    return pickEnum(FORMATS, value ?? true, door, "--format");
}

/** The checkout at `cwd`, or null outside a git repository. */
function currentCheckout(cwd: string): string | null {
    const root = gitResult(cwd, ["rev-parse", "--show-toplevel"]);

    return root.exitCode === 0 && root.stdout ? root.stdout : null;
}

function isFacts(value: unknown, key: FactsKey): value is PrReviewFacts {
    return (
        typeof value === "object" &&
        value !== null &&
        "provider" in value &&
        value.provider === "gitlab" &&
        "iid" in value &&
        value.iid === key.iid &&
        "host" in value &&
        value.host === key.host &&
        "project" in value &&
        (value.project === key.project || /^\d+$/.test(key.project))
    );
}

function savedFacts(path: string, key: FactsKey): PrReviewFacts | null {
    if (!existsSync(path)) {
        return null;
    }

    try {
        const parsed: unknown = SafeJSON.parse(readFileSync(path, "utf-8"), { strict: true });

        return isFacts(parsed, key) ? parsed : null;
    } catch (error) {
        logger.debug({ error, path }, "gitlab pr review: saved facts unreadable");
        return null;
    }
}

/**
 * The saved-facts file name. The slug keeps it readable; the hash of host and project keeps two
 * hosts with one project path, or `group/a-b` and `group-a/b`, from sharing one file.
 */
export function factsBaseName({ host, project, iid }: FactsKey): string {
    const key = createHash("sha256").update(`${host}\n${project}`).digest("hex").slice(0, 12);
    return `gitlab-pr-${project.replace(/[^\w.-]+/g, "-")}-${key}-${iid}`;
}

/** The facts JSON that goes beside a report: `x.md` becomes `x.json`, any other name gets `.json` appended. */
export function factsPathOf(reportPath: string): string {
    return `${reportPath.replace(/\.md$/, "")}.json`;
}

export function summaryLines(facts: PrReviewFacts): string[] {
    const additions = facts.files.reduce((sum, file) => sum + file.additions, 0);
    const deletions = facts.files.reduce((sum, file) => sum + file.deletions, 0);
    const importers = facts.impact?.filter((entry) => entry.imports.length > 0).length ?? 0;

    return [
        `files ${facts.files.length} (+${additions} −${deletions}) · threads ${facts.discussions.length} · your drafts ${facts.drafts.length}`,
        facts.impact === null
            ? "open-MR scan: not run"
            : `open-MR scan: ${facts.impactScanned} scanned, ${facts.impact.length} affected (${importers} import a removed module)`,
    ];
}

function wholeNumber(value: string, flag: string): number {
    const n = Number(value);

    if (!Number.isInteger(n) || n < 0) {
        throw new Error(`${flag} must be a non-negative integer; got "${value}".`);
    }

    return n;
}

async function runPrReview(mrIid: string, opts: Options, door: ReviewDoor): Promise<void> {
    if (!/^\d+$/.test(mrIid)) {
        throw new Error(`MR IID must be a positive integer; got "${mrIid}".`);
    }

    const contextLines = wholeNumber(opts.contextLines, "--context-lines");
    const impactLimit = wholeNumber(opts.impactLimit, "--impact-limit");

    if (opts.repo && opts.cwd) {
        throw new Error("--cwd is another name for --repo; give one of them.");
    }

    const format = await pickFormat(opts, door);
    const impactSource =
        opts.impactSource === undefined
            ? door.impactSource
            : await pickEnum(IMPACT_SOURCES, opts.impactSource, door, "--impact-source");

    if (!format || !impactSource) {
        process.exitCode = 1;
        return;
    }

    const iid = Number(mrIid);
    const checkoutFlag = opts.repo ?? opts.cwd;
    const pinned = opts.worktree ?? (door.cwdIsWorktree ? opts.cwd : undefined);
    const repoPath = checkoutFlag
        ? checkoutOf(resolve(checkoutFlag))
        : opts.project
          ? null
          : currentCheckout(process.cwd());
    const api = await resolveProjectApi({ host: opts.host, project: opts.project, cwd: repoPath ?? process.cwd() });
    const key = { host: api.host, project: api.project, iid };
    const draftsOnly = Boolean(opts.draftsOnly);
    const reportPath = opts.out ? resolve(opts.out) : door.defaultReport(key, draftsOnly);
    const jsonPath = factsPathOf(reportPath);
    const cached = opts.expand && !opts.refresh && !draftsOnly ? savedFacts(jsonPath, key) : null;
    const render = draftsOnly ? renderDraftsOnlyMarkdown : renderPrReviewMarkdown;
    logger.debug(
        { iid, project: api.project, host: api.host, repoPath, pinned, format, impactSource, cached: Boolean(cached) },
        "pr review"
    );

    const config = cached ? null : await loadConfig();
    const facts =
        cached ??
        (await collectPrReviewFacts({
            api,
            iid,
            repoPath,
            worktree: pinned ? resolve(pinned) : null,
            contextLines,
            impact: !draftsOnly && opts.impact !== false,
            impactLimit,
            impactSource,
            gates: config?.review.gates ?? [],
            gateRunner: config?.review.runner ?? "list",
            onProgress: (message) => progress(`ℹ  ${message}`),
        }));

    const extras: ReportExtras = {};

    if (opts.threads) {
        const cwd = facts.worktree ?? facts.repoPath ?? process.cwd();
        const context = await collectThreadContext({
            api,
            iid: String(iid),
            cwd,
            fetchRemote: true,
            onWarn: (message) => progress(`⚠  ${message}`),
        });
        extras.threads = {
            discussions: context.discussions,
            opts: { mrIid: String(iid), project: facts.project, cwd, contextLines, anchorViews: context.anchorViews },
        };
    }

    if (!cached) {
        writeFileSync(jsonPath, SafeJSON.stringify(facts, null, 2));
        writeFileSync(reportPath, render(facts, extras));

        for (const warning of facts.warnings) {
            progress(`⚠  ${warning}`);
        }

        for (const line of summaryLines(facts)) {
            progress(`ℹ  ${line}`);
        }

        progress(`ℹ  report → ${reportPath}`);
        progress(`ℹ  facts  → ${jsonPath}`);
    }

    const target = [opts.host ? `--host ${opts.host}` : "", opts.project ? `--project ${opts.project}` : ""]
        .filter(Boolean)
        .join(" ");
    const command = `${toolCommand(`gitlab ${door.words.join(" ")}`)} ${iid}${target ? ` ${target}` : ""}`;

    if (opts.expand) {
        out.print(expandRefs(facts, opts.expand.split(",").filter(Boolean)));
        return;
    }

    if (opts.proposalSkeleton) {
        out.result(proposalSkeleton(facts, opts.agent));
        return;
    }

    if (format === "md") {
        out.print(render(facts, extras));
    } else if (format === "llm") {
        out.print(formatPrReviewLLM(facts, command));
    } else if (format === "json") {
        out.result(facts);
    }
}
