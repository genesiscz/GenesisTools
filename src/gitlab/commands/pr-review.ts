/**
 * `gitlab pr review` — the reviewer's twin of `fetch-review`: the facts a review of someone else's
 * MR needs, as JSON (default), markdown (`--md`), a compact ref view (`--llm`, drill down with
 * `--expand f1,t2`), or a `gt:review-proposal` skeleton for `tools hub proposal push`.
 * Read-only on GitLab and git. Always writes `<tmp>/gitlab-pr-<project>-<host+project hash>-<iid>.{json,md}`.
 *
 *   tools gitlab pr review 42 --repo ~/code/app
 *   tools gitlab pr review 42 --llm
 *   tools gitlab pr review 42 --expand f3,t1
 *   tools gitlab pr review 42 --proposal-skeleton > proposal.json
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { progress, type TargetOptions, withProject } from "@app/gitlab/commands/shared";
import { resolveProjectApi } from "@app/gitlab/lib/client";
import { loadConfig } from "@app/gitlab/lib/config";
import { gitResult } from "@app/gitlab/lib/git";
import { checkoutOf, collectPrReviewFacts, DEFAULT_IMPACT_LIMIT, type PrReviewFacts } from "@app/gitlab/lib/pr-review";
import {
    expandRefs,
    formatPrReviewLLM,
    proposalSkeleton,
    renderPrReviewMarkdown,
} from "@app/gitlab/lib/pr-review-output";
import { isInteractive, suggestEnumFlag } from "@genesiscz/utils/cli";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger, out } from "@genesiscz/utils/logger";
import * as p from "@genesiscz/utils/prompts/p";
import type { Command } from "commander";

const FORMATS = ["json", "md", "llm"] as const;
type Format = (typeof FORMATS)[number];

interface Options extends TargetOptions {
    repo?: string;
    format?: string | true;
    json?: boolean;
    md?: boolean;
    llm?: boolean;
    expand?: string;
    refresh?: boolean;
    proposalSkeleton?: boolean;
    agent: string;
    contextLines: string;
    impact?: boolean;
    impactLimit: string;
}

export function registerPrReview(parent: Command): Command {
    const pr = parent.command("pr").description("Review someone else's merge request");

    withProject(
        pr
            .command("review")
            .description(
                "Facts for reviewing an MR: hunks with line numbers, threads, my drafts, affected open MRs, gates"
            )
            .argument("<mr-iid>", "MR IID (the small number in the URL)")
            .option(
                "--repo <checkout>",
                "Local checkout of the project: file links, the MR worktree, and a git diff with --context-lines (default: the current checkout when --project is not given)"
            )
            .option("--format [fmt]", `stdout: ${FORMATS.join(" | ")} (default json)`)
            .option("--json", "Same as --format json")
            .option("--md", "Same as --format md: the markdown report")
            .option("--llm", "Same as --format llm: a compact view with refs (f1 files, t1 threads, d1 drafts, m1 MRs)")
            .option("--expand <refs>", "Print these refs in full, e.g. f2,t1 (reads the saved facts)")
            .option("--refresh", "With --expand: collect the facts again instead of reading the saved ones")
            .option("--proposal-skeleton", "Print a gt:review-proposal JSON pre-filled from the facts")
            .option("--agent <name>", "author.agent in the proposal skeleton", "agent")
            .option("--context-lines <n>", "Unchanged lines around each hunk when the diff comes from local git", "8")
            .option("--no-impact", "Skip the scan of other open MRs")
            .option(
                "--impact-limit <n>",
                "Read the diffs of at most <n> other open MRs, the most recently updated first",
                String(DEFAULT_IMPACT_LIMIT)
            )
    ).action(runPrReview);

    return pr;
}

async function pickFormat(opts: Options): Promise<Format | null> {
    const flags = [opts.json && "json", opts.md && "md", opts.llm && "llm"].filter(
        (value): value is Format => typeof value === "string"
    );
    const given = typeof opts.format === "string" ? opts.format : undefined;
    const requested = new Set([...flags, ...(given ? [given] : [])]);

    if (requested.size > 1) {
        out.log.error(`Pick one output: ${[...requested].join(", ")} were all requested.`);
        return null;
    }

    const value = [...requested][0];
    const match = FORMATS.find((format) => format === value);

    if (match) {
        return match;
    }

    if (value === undefined && opts.format !== true) {
        return "json";
    }

    if (isInteractive()) {
        const picked = await p.select({
            message: "--format",
            options: FORMATS.map((format) => ({ value: format, label: format })),
        });

        return p.isCancel(picked) ? null : (FORMATS.find((format) => format === picked) ?? null);
    }

    out.log.error(
        suggestEnumFlag("tools gitlab pr review", "--format", FORMATS, { subcommand: ["pr", "review"], given: value })
    );
    return null;
}

/** The checkout at `cwd`, or null outside a git repository. */
function currentCheckout(cwd: string): string | null {
    const root = gitResult(cwd, ["rev-parse", "--show-toplevel"]);

    return root.exitCode === 0 && root.stdout ? root.stdout : null;
}

interface FactsKey {
    host: string;
    /** The project as resolved: a path, or a numeric id the saved facts name by its path. */
    project: string;
    iid: number;
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

async function runPrReview(mrIid: string, opts: Options): Promise<void> {
    if (!/^\d+$/.test(mrIid)) {
        throw new Error(`MR IID must be a positive integer; got "${mrIid}".`);
    }

    const contextLines = Number(opts.contextLines);

    if (!Number.isInteger(contextLines) || contextLines < 0) {
        throw new Error(`--context-lines must be a non-negative integer; got "${opts.contextLines}".`);
    }

    const impactLimit = Number(opts.impactLimit);

    if (!Number.isInteger(impactLimit) || impactLimit < 0) {
        throw new Error(`--impact-limit must be a non-negative integer; got "${opts.impactLimit}".`);
    }

    const format = await pickFormat(opts);

    if (!format) {
        process.exitCode = 1;
        return;
    }

    const iid = Number(mrIid);
    const repoPath = opts.repo ? checkoutOf(resolve(opts.repo)) : opts.project ? null : currentCheckout(process.cwd());
    const api = await resolveProjectApi({ host: opts.host, project: opts.project, cwd: repoPath ?? process.cwd() });
    const key = { host: api.host, project: api.project, iid };
    const base = join(tmpdir(), factsBaseName(key));
    const jsonPath = `${base}.json`;
    const cached = opts.expand && !opts.refresh ? savedFacts(jsonPath, key) : null;
    logger.debug({ iid, project: api.project, host: api.host, repoPath, format, cached: Boolean(cached) }, "pr review");

    const facts =
        cached ??
        (await collectPrReviewFacts({
            api,
            iid,
            repoPath,
            contextLines,
            impact: opts.impact !== false,
            impactLimit,
            gates: (await loadConfig()).review.gates,
            onProgress: (message) => progress(`ℹ  ${message}`),
        }));

    if (!cached) {
        writeFileSync(jsonPath, SafeJSON.stringify(facts, null, 2));
        writeFileSync(`${base}.md`, renderPrReviewMarkdown(facts));

        for (const warning of facts.warnings) {
            progress(`⚠  ${warning}`);
        }

        progress(`ℹ  facts  → ${jsonPath}`);
        progress(`ℹ  report → ${base}.md`);
    }

    const target = [opts.host ? `--host ${opts.host}` : "", opts.project ? `--project ${opts.project}` : ""]
        .filter(Boolean)
        .join(" ");
    const command = `tools gitlab pr review ${iid}${target ? ` ${target}` : ""}`;

    if (opts.expand) {
        out.print(expandRefs(facts, opts.expand.split(",").filter(Boolean)));
        return;
    }

    if (opts.proposalSkeleton) {
        out.result(proposalSkeleton(facts, opts.agent));
        return;
    }

    if (format === "md") {
        out.print(renderPrReviewMarkdown(facts));
    } else if (format === "llm") {
        out.print(formatPrReviewLLM(facts, command));
    } else {
        out.result(facts);
    }
}
