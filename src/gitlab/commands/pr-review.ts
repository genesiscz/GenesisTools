/**
 * `gitlab pr <iid> review`: the facts for one of the two review modes.
 *
 * `--receive` (someone reviewed my MR): every thread with the code at its anchor, as JSON or the
 * per-thread markdown report.
 *
 * `--give` (I review someone else's MR): hunks with line numbers, threads, my drafts, the open MRs
 * this one affects and the gates, as JSON (default), markdown (`--md`), a compact ref view (`--llm`,
 * drill down with `--expand f1,t2`), only a summary on stderr (`--format summary`), or a review
 * proposal skeleton (`--proposal-skeleton`). Read-only on GitLab. Git fetches only into the object
 * store: `refs/merge-requests/<iid>/head` when a thread's commit is missing from the checkout (both
 * modes; `--receive --no-anchors` skips it), and every open MR branch with `--impact-source git`.
 * No local branch, HEAD or working tree changes. Writes `<tmp>/gitlab-pr-<project>-<host+project hash>-<iid>.{json,md}` unless
 * `--out` names the report.
 * The `gt:review-proposal` skill says how to fill the proposal and push it with `tools hub proposal push`.
 *
 * No mode flag: the token's owner is the MR's author → receive, anyone else → give.
 *
 *   tools gitlab pr 42 review --receive --md
 *   tools gitlab pr 42 review --give --repo ~/code/app
 *   tools gitlab pr 42 review --give --llm
 *   tools gitlab pr 42 review --give --expand f3,t1
 *   tools gitlab pr 42 review --give --mine-only --md
 *   tools gitlab pr 42 review --give --proposal-skeleton > proposal.json
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type FetchReviewOptions, runFetchReview } from "@app/gitlab/commands/fetch-review";
import { progress, type TargetOptions, withProject } from "@app/gitlab/commands/shared";
import { currentUser, type ProjectApi, resolveProjectApi } from "@app/gitlab/lib/client";
import { FETCH_FORMATS, loadConfig } from "@app/gitlab/lib/config";
import { gitResult } from "@app/gitlab/lib/git";
import { applyRefs, idMapPath, loadIdMap, saveIdMap } from "@app/gitlab/lib/ids";
import { fetchMr } from "@app/gitlab/lib/merge-requests";
import {
    checkoutOf,
    collectPrReviewFacts,
    DEFAULT_IMPACT_LIMIT,
    IMPACT_SOURCES,
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
import { collectThreadContext, type Discussion } from "@app/gitlab/lib/review-render";
import { isInteractive, suggestEnumFlag } from "@genesiscz/utils/cli";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger, out } from "@genesiscz/utils/logger";
import * as p from "@genesiscz/utils/prompts/p";
import type { Command } from "commander";

const FORMATS = ["json", "md", "llm", "summary"] as const;
type Format = (typeof FORMATS)[number];

interface Options extends TargetOptions {
    receive?: boolean;
    give?: boolean;
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
    mineOnly?: boolean;
    threads?: boolean;
    anchors?: boolean;
    schemaFormat?: string;
    schemaFile?: boolean;
    reportFile?: boolean;
    confirm?: boolean;
}

interface FactsKey {
    host: string;
    /** The project as resolved: a path, or a numeric id the saved facts name by its path. */
    project: string;
    iid: number;
}

/** The defaults of the give mode. */
interface ReviewDoor {
    format: Format;
    /** The report path when `--out` is not given. */
    defaultReport: (key: FactsKey, draftsOnly: boolean) => string;
}

const PR_REVIEW: ReviewDoor = {
    format: "json",
    defaultReport: (key, draftsOnly) => join(tmpdir(), `${factsBaseName(key)}${draftsOnly ? "-drafts" : ""}.md`),
};

/** Options that only one mode reads; passing one to the other mode is an error, never ignored. */
const GIVE_ONLY = [
    "repo",
    "worktree",
    "print",
    "refresh",
    "proposalSkeleton",
    "agent",
    "impact",
    "impactLimit",
    "impactSource",
    "mineOnly",
    "threads",
] as const;
const RECEIVE_ONLY = ["anchors", "schemaFormat", "schemaFile", "reportFile", "confirm"] as const;

function reviewCommand(iid: string | number = "<iid>"): string {
    return toolCommand("gitlab pr", String(iid), "review");
}

function flagOf(cmd: Command, key: string): string {
    return cmd.options.find((option) => option.attributeName() === key)?.flags ?? key;
}

/** The options of `names` the user passed on the command line (a default does not count). */
function passed(cmd: Command, names: readonly string[]): string[] {
    return names.filter((name) => cmd.getOptionValueSource(name) === "cli").map((name) => flagOf(cmd, name));
}

/** `pr review` with its verbs; a bare `pr <iid> review` runs `facts`. */
export function registerPrReview(pr: Command): Command {
    const review = pr
        .command("review")
        .description("A review: facts (default), then skeleton, check and render of the judgements file");

    withProject(
        review
            .command("facts")
            .description(
                "Facts for a review: --receive (threads on my MR) or --give (someone else's MR); no flag picks by author"
            )
            .argument("<iid>", "MR iid (the number after `pr`)")
            .option("--receive", "Someone reviewed my MR: every thread with the code at its anchor")
            .option("--give", "I review someone else's MR: hunks, threads, my drafts, affected MRs, gates")
            .option("--cwd <checkout>", "Local checkout of the project (code excerpts, git, the origin remote)")
            .option(
                "--format [fmt]",
                `stdout. --give: ${FORMATS.join(" | ")} (default ${PR_REVIEW.format}); --receive: ${FETCH_FORMATS.join(" | ")}`
            )
            .option("--json", "Same as --format json")
            .option("--md", "Same as --format md: the markdown report")
            .option(
                "--out <file>",
                "--give: the markdown report here, the facts JSON beside it; --receive: the JSON here"
            )
            .option(
                "--context-lines <n>",
                "--give: unchanged lines around each hunk (default 8); --receive: lines around each anchor (default from the config)"
            )
            .option(
                "--repo <checkout>",
                "--give: local checkout for file links, the MR worktree and a git diff (default: the current checkout when --project is not given)"
            )
            .option(
                "--worktree <dir>",
                "--give: use this directory as the MR worktree even when its HEAD is on another branch"
            )
            .option(
                "--llm",
                "A compact view with ids (F01 files, T01 threads, Y01 my threads, D01 drafts, M01 MRs); only when the user asks for it"
            )
            .option("--print", "--give: print the markdown report to stdout (same as --md)")
            .option("--expand <ids>", "Print these ids in full, e.g. F02,T01 (--give reads the saved facts)")
            .option("--refresh", "--give: with --expand, collect the facts again instead of reading the saved ones")
            .option("--proposal-skeleton", "--give: print a review proposal JSON pre-filled from the facts")
            .option("--agent <name>", "--give: author.agent in the proposal skeleton", "agent")
            .option("--no-impact", "--give: skip the scan of other open MRs")
            .option(
                "--impact-limit <n>",
                "--give: with --impact-source api, read the diffs of at most <n> other open MRs, the most recently updated first",
                String(DEFAULT_IMPACT_LIMIT)
            )
            .option(
                "--impact-source [source]",
                `--give: ${IMPACT_SOURCES.join(" | ")} (default: review.impactSource in the config, else api); api reads each MR's diff from GitLab, git fetches every open branch and diffs locally (needs a checkout, no cap)`
            )
            .option(
                "--mine-only",
                "--give: only my comments: pending drafts in full with the code at the anchor, and my published threads; no impact scan"
            )
            .option(
                "--threads",
                "--give: add every unresolved diff thread in full: all notes, the local code and the reviewer's frozen view"
            )
            .option(
                "--no-anchors",
                "--receive: skip the API fallback for the reviewer's frozen view; views whose sha is in local history still come from git"
            )
            .option(
                "--schema-format <fmt>",
                "--receive: print the inferred discussions schema: schema | skeleton | typescript | none"
            )
            .option(
                "--no-schema-file",
                "--receive: don't write <out>.schema.json, a JSON Schema describing the shape of the discussions JSON"
            )
            .option("--no-report-file", "--receive: don't write <out>.md, the markdown report, next to the JSON")
            .option("--no-confirm", "--receive: skip the confirm prompt in a terminal")
    ).action(runReview);

    return review;
}

/** The mode the flags ask for, or by authorship: the token's owner wrote the MR → receive. */
export async function pickMode(
    iid: string,
    opts: TargetOptions & { receive?: boolean; give?: boolean; cwd?: string; repo?: string; api?: ProjectApi }
): Promise<"receive" | "give"> {
    if (opts.receive && opts.give) {
        throw new Error("Pick one: --receive (threads on my MR) or --give (someone else's MR).");
    }

    if (opts.receive || opts.give) {
        return opts.receive ? "receive" : "give";
    }

    if (!/^\d+$/.test(iid)) {
        throw new Error(`The MR iid must be a positive integer; got "${iid}".`);
    }

    // The project the run itself uses: both modes resolve with a checkout, so origin wins over the
    // configured default here too. A caller that already resolved its project passes it.
    const api =
        opts.api ??
        (await resolveProjectApi({
            host: opts.host,
            project: opts.project,
            cwd: resolve(opts.cwd ?? opts.repo ?? process.cwd()),
        }));
    const [mr, me] = await Promise.all([fetchMr(api, Number(iid)), currentUser(api)]);
    const mode = mr.author.username === me.username ? "receive" : "give";
    progress(
        `mode: ${mode} (${mode === "receive" ? "you are" : `@${mr.author.username} is`} the author of !${iid}; pass --receive or --give to choose)`
    );

    return mode;
}

async function runReview(iid: string, opts: Options, cmd: Command): Promise<void> {
    const mode = await pickMode(iid, opts);
    const foreign = passed(cmd, mode === "receive" ? GIVE_ONLY : RECEIVE_ONLY);

    if (foreign.length > 0) {
        throw new Error(
            `${foreign.join(", ")} ${foreign.length === 1 ? "belongs" : "belong"} to the ${mode === "receive" ? "--give" : "--receive"} mode.`
        );
    }

    if (mode === "give") {
        await runPrReview(iid, { ...opts, contextLines: opts.contextLines ?? "8" }, PR_REVIEW);

        return;
    }

    // `--format` with no value asks, as it does in give mode, instead of falling back to the configured format.
    const receiveFormat =
        opts.format === true
            ? await pickEnum({ values: FETCH_FORMATS, value: true, flag: "--format", mode: "--receive" })
            : null;

    if (opts.format === true && !receiveFormat) {
        return;
    }

    const receive: FetchReviewOptions = {
        host: opts.host,
        project: opts.project,
        cwd: opts.cwd,
        out: opts.out,
        format: typeof opts.format === "string" ? opts.format : opts.json ? "json" : (receiveFormat ?? undefined),
        md: opts.md,
        contextLines: opts.contextLines,
        anchors: opts.anchors,
        schemaFormat: opts.schemaFormat,
        schemaFile: opts.schemaFile,
        reportFile: opts.reportFile,
        confirm: opts.confirm,
        llm: opts.llm,
        expand: opts.expand,
    };

    await runFetchReview(iid, receive);
}

/** The facts with their ids from this MR's stored map (new items get new ids, the map is saved). */
async function withStoredRefs(api: ProjectApi, key: FactsKey, facts: PrReviewFacts): Promise<PrReviewFacts> {
    const me = await currentUser(api);
    const path = idMapPath(key);
    const map = loadIdMap(path);
    const withIds = applyRefs({ ...facts, me: me.username }, map);
    saveIdMap(path, map);

    return withIds;
}

async function pickEnum<T extends string>(options: {
    values: readonly T[];
    value: string | true;
    flag: string;
    mode: "--give" | "--receive";
}): Promise<T | null> {
    const { values, value, flag } = options;
    const match = values.find((candidate) => candidate === value);

    if (match) {
        return match;
    }

    if (value === true && isInteractive()) {
        const picked = await p.select({ message: flag, options: values.map((v) => ({ value: v, label: v })) });

        return p.isCancel(picked) ? null : (values.find((v) => v === picked) ?? null);
    }

    out.log.error(
        suggestEnumFlag(toolCommand("gitlab pr"), flag, values, {
            subcommand: ["<iid>", "review", options.mode],
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

    return pickEnum({ values: FORMATS, value: value ?? true, flag: "--format", mode: "--give" });
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
        logger.debug({ error, path }, "gitlab pr <iid> review: saved facts unreadable");
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
            ? (await loadConfig()).review.impactSource
            : await pickEnum({
                  values: IMPACT_SOURCES,
                  value: opts.impactSource,
                  flag: "--impact-source",
                  mode: "--give",
              });

    if (!format || !impactSource) {
        process.exitCode = 1;
        return;
    }

    const iid = Number(mrIid);
    const checkoutFlag = opts.repo ?? opts.cwd;
    const pinned = opts.worktree;
    const repoPath = checkoutFlag
        ? checkoutOf(resolve(checkoutFlag))
        : opts.project
          ? null
          : currentCheckout(process.cwd());
    const api = await resolveProjectApi({ host: opts.host, project: opts.project, cwd: repoPath ?? process.cwd() });
    const key = { host: api.host, project: api.project, iid };
    const draftsOnly = Boolean(opts.mineOnly);
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
        (await withStoredRefs(
            api,
            key,
            await collectPrReviewFacts({
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
                worktreeHint: config?.review.worktreeHint ?? null,
                onProgress: (message) => progress(`ℹ  ${message}`),
            })
        ));

    const extras: ReportExtras = {};
    const cwd = facts.worktree ?? facts.repoPath ?? process.cwd();
    const refs = new Map(facts.discussions.flatMap((d) => (d.ref ? [[d.id, d.ref] as const] : [])));
    const contextOf = async (include?: (d: Discussion) => boolean) => {
        const context = await collectThreadContext({
            api,
            iid: String(iid),
            cwd,
            fetchRemote: true,
            onWarn: (message) => progress(`⚠  ${message}`),
            include,
        });

        return {
            discussions: context.selected,
            opts: {
                mrIid: String(iid),
                project: facts.project,
                cwd,
                contextLines,
                anchorViews: context.anchorViews,
                tip: context.tip,
                refs,
            },
        };
    };

    if (opts.threads) {
        const unresolved = await contextOf();
        // threadSections picks the unresolved ones itself from every discussion it is given.
        extras.threads = { discussions: unresolved.discussions, opts: unresolved.opts };
    }

    const mine = new Set(facts.discussions.filter((d) => d.ref?.startsWith("Y")).map((d) => d.id));

    if (mine.size > 0 && !cached) {
        extras.mine = await contextOf((d) => mine.has(d.id ?? ""));
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
    const command = `${reviewCommand(iid)} --give${target ? ` ${target}` : ""}`;

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
