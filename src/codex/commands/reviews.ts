import { sessionCostSummary } from "@app/ai-spend/lib/workers/ledger";
import { isInteractive, suggestEnumFlag } from "@genesiscz/utils/cli";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { formatDuration, formatTokens } from "@genesiscz/utils/format";
import { logger, out } from "@genesiscz/utils/logger";
import * as p from "@genesiscz/utils/prompts/p";
import { createBoxTable, formatDotStatus, renderCliHeader, truncateDisplay } from "@genesiscz/utils/table";
import {
    isReviewEffort,
    manifestChangedLines,
    REVIEW_EFFORTS,
    type ReviewEffort,
} from "@genesiscz/utils/worker/contract";
import type { Command } from "commander";
import pc from "picocolors";
import { checkReview, type ReviewGateChecks } from "../lib/review/gate";
import { importReviewSessions, lastAgentMessage } from "../lib/review/import";
import { type ReviewGateRecord, readReviewRecords, reviewLedgerPath } from "../lib/review/ledger";
import { buildManifest, defaultReviewGitReaders } from "../lib/review/prepare";
import {
    currentReviewRecords,
    filterReviews,
    gateCheckRows,
    parseReviewSince,
    type ReviewSummary,
    reviewTotals,
    summarizeReviews,
} from "../lib/review/report";
import { REVIEW_VERDICTS } from "../lib/review/types";
import { type CodexSessionMeta, CodexSessionStore } from "../lib/store";

const { log } = logger.scoped("codex-reviews");

const VERDICT_FILTERS = [...REVIEW_VERDICTS, "open"] as const;

interface ReviewsOptions {
    since?: string;
    pr?: string;
    label?: string;
    effort?: string | true;
    verdict?: string | true;
    name?: string;
    json?: boolean;
}

function plural(count: number, noun: string): string {
    return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function money(usd: number | null): string {
    return usd === null ? "unpriced" : `$${usd.toFixed(2)}`;
}

function verdictCell(verdict: ReviewSummary["verdict"]): string {
    const tone = verdict === "pass" ? "ok" : verdict === "shallow" ? "err" : verdict === "open" ? "dim" : "warn";
    return formatDotStatus(tone, verdict);
}

/**
 * A closed-set flag given without a value or with an unknown one: a TTY picks from the values, anything else gets
 * the values and a filled command line, and the run stops with exit 1.
 */
async function enumFilter(flag: string, raw: string | true | undefined, values: readonly string[]) {
    if (raw === undefined) {
        return { ok: true as const, value: undefined };
    }

    if (raw !== true && values.includes(raw)) {
        return { ok: true as const, value: raw };
    }

    if (isInteractive()) {
        const picked = await p.select({
            message: `${flag}`,
            options: values.map((value) => ({ value, label: value })),
        });

        if (!p.isCancel(picked) && typeof picked === "string") {
            return { ok: true as const, value: picked };
        }
    }

    out.log.error(suggestEnumFlag("tools codex", flag, values, raw === true ? {} : { given: raw }));
    process.exitCode = 1;
    return { ok: false as const };
}

async function runReviews(options: ReviewsOptions): Promise<void> {
    const effort = await enumFilter("--effort", options.effort, REVIEW_EFFORTS);
    const verdict = await enumFilter("--verdict", options.verdict, VERDICT_FILTERS);

    if (!effort.ok || !verdict.ok) {
        return;
    }

    const since = options.since === undefined ? undefined : parseReviewSince(options.since);

    if (since === null) {
        out.log.error(`--since ${options.since} is not a duration (24h, 90m, 7d), a time (HH:MM) or a date.`);
        process.exitCode = 1;
        return;
    }

    const pr = options.pr === undefined ? undefined : Number(options.pr.replace(/^#/, ""));

    if (pr !== undefined && !Number.isInteger(pr)) {
        out.log.error(`--pr ${options.pr} is not a PR number.`);
        process.exitCode = 1;
        return;
    }

    const path = reviewLedgerPath();
    const { records, skipped } = readReviewRecords(path);
    const reviews = filterReviews(summarizeReviews(records), {
        ...(since ? { since } : {}),
        ...(pr === undefined ? {} : { pr }),
        ...(options.label ? { label: options.label } : {}),
        ...(effort.value ? { effort: effort.value } : {}),
        ...(verdict.value ? { verdict: verdict.value } : {}),
        ...(options.name ? { name: options.name } : {}),
    });
    const totals = reviewTotals(reviews);
    log.debug({ path, records: records.length, skipped, shown: reviews.length }, "codex reviews read");

    if (options.json) {
        out.result({ ledger: path, skipped, reviews, totals });
        return;
    }

    if (skipped > 0) {
        out.log.warn(`${skipped} ledger line(s) in ${path} did not parse and were skipped.`);
    }

    if (reviews.length === 0) {
        out.log.info(`No review runs match${records.length === 0 ? `: ${path} has none yet` : ""}.`);
        return;
    }

    renderCliHeader("Codex reviews", `${reviews.length} review(s) · ledger ${path}`);
    const table = createBoxTable([
        "NAME",
        "PR",
        "FILES",
        "EFFORT",
        "TIME",
        "TOOLS",
        "RSN/100L",
        "COVERAGE",
        "VERDICT",
        "COST",
    ]);

    for (const review of reviews) {
        table.push([
            truncateDisplay(review.label ? `${review.name} ${pc.dim(review.label)}` : review.name, 36),
            review.pr === undefined ? (review.branch ? truncateDisplay(review.branch, 18) : "—") : `#${review.pr}`,
            review.files === null ? "—" : `${review.files} (${review.lines}L)`,
            review.effort,
            formatDuration(review.durationMs),
            String(review.toolCalls),
            review.reasoningPer100Lines === null ? "—" : String(review.reasoningPer100Lines),
            review.coverage ?? "—",
            review.escalatedTo ? `${verdictCell(review.verdict)} → ${review.escalatedTo}` : verdictCell(review.verdict),
            money(review.costUsd),
        ]);
    }

    out.println(table.toString());
    const verdicts = Object.entries(totals.verdicts)
        .map(([name, count]) => `${count} ${name}`)
        .join(", ");
    out.println(
        `Totals: ${plural(totals.reviews, "review")} (${verdicts}) · ${plural(totals.turns, "turn")} · ${formatDuration(totals.durationMs)} · ${totals.toolCalls} tool calls · ${formatTokens(totals.reasoningTokens)} reasoning · $${totals.costUsd.toFixed(2)} API-equivalent${totals.unpricedReviews > 0 ? ` (+${totals.unpricedReviews} unpriced)` : ""}`
    );
    out.println(pc.dim(`One review in depth: ${toolCommand("codex review-depth")} <name>`));
}

interface ImportOptions {
    base?: string;
    cwdFromSession: boolean;
    json?: boolean;
}

/** Exported for the test of both output formats; the CLI reaches it through `reviews import`. */
export async function runImport(names: string[], options: ImportOptions): Promise<void> {
    const results = await importReviewSessions({
        names,
        ...(options.base ? { base: options.base } : {}),
        cwdFromSession: options.cwdFromSession,
    });

    // Before either output: automation reading --json needs the same exit status as a person reading the table.
    if (results.some((result) => result.status === "missing" || result.status === "failed")) {
        process.exitCode = 1;
    }

    if (options.json) {
        out.result({ ledger: reviewLedgerPath(), results });
        return;
    }

    const table = createBoxTable(["NAME", "STATUS", "VERDICT", "MANIFEST", "NOTES"]);

    for (const result of results) {
        table.push([
            result.name,
            result.status,
            result.verdict ? verdictCell(result.verdict) : "—",
            result.manifest
                ? `${result.manifest.files} files, ${result.manifest.lines}L (${result.manifest.base}...${result.manifest.head.slice(0, 10)})`
                : "—",
            truncateDisplay(result.notes.join("; "), 70),
        ]);
    }

    out.println(table.toString());
    const imported = results.filter((result) => result.status === "imported").length;
    out.println(`${imported} imported, ${results.length - imported} not, into ${reviewLedgerPath()}`);
}

interface DepthOptions {
    base?: string;
    json?: boolean;
}

function checkLine(label: string, ok: boolean, detail: string): string {
    return `${ok ? pc.green("✓") : pc.red("✗")} ${label.padEnd(9)} ${detail}`;
}

function gateLines(gate: ReviewGateRecord): string[] {
    return gateCheckRows(gate).map((row) => checkLine(row.label, row.ok, row.detail));
}

function checksLines(checks: ReviewGateChecks): string[] {
    return [
        checkLine("coverage", checks.coverage.ok, checks.coverage.detail),
        checkLine("reasoning", checks.reasoning.ok, checks.reasoning.detail),
        checkLine("shape", checks.shape.ok, checks.shape.detail),
    ];
}

/** A session spawned without `--mode review`: the gate's checks against a manifest computed now from `--base`. */
async function adHocDepth(store: CodexSessionStore, meta: CodexSessionMeta, options: DepthOptions): Promise<void> {
    if (!options.base) {
        out.log.error(
            `${meta.name} was not spawned with --mode review, so it has no manifest. Pass --base <ref> to measure it against git diff <base>...HEAD in ${meta.cwd}.`
        );
        process.exitCode = 1;
        return;
    }

    const readers = defaultReviewGitReaders();
    const manifest = buildManifest(options.base, await readers.numstat(meta.cwd, options.base));
    const effort: ReviewEffort = isReviewEffort(meta.effort) ? meta.effort : "high";
    const cost = sessionCostSummary({ backend: "codex", name: meta.name, sessionId: meta.threadId });
    const reasoning = cost ? cost.session.tokens.reasoning : null;
    const checks = checkReview({
        report: await lastAgentMessage(store, meta),
        manifest,
        effort,
        reasoningTokens: reasoning,
    });

    if (options.json) {
        out.result({ name: meta.name, review: null, base: options.base, effort, manifest, checks, cost });
        return;
    }

    out.println(`${pc.bold(meta.name)} ${pc.dim("not a --mode review session; measured now")} · effort ${effort}`);
    out.println(
        `manifest ${manifest.files.length} files, +${manifest.added} -${manifest.deleted} against ${options.base}`
    );

    if (cost) {
        out.println(
            `spent ${cost.session.turns} turns · ${formatDuration(cost.session.durationMs)} · ${cost.session.toolCalls} tool calls · ${formatTokens(cost.session.tokens.reasoning)} reasoning · $${cost.session.apiEquivalentUsd.toFixed(2)}`
        );
    }

    for (const line of checksLines(checks)) {
        out.println(line);
    }
}

async function runReviewDepth(name: string, options: DepthOptions): Promise<void> {
    const store = new CodexSessionStore();
    const meta = await store.readMeta(name);

    if (!meta) {
        out.log.error(`No codex session named ${name}. ${toolCommand("codex sessions")} lists them.`);
        process.exitCode = 1;
        return;
    }

    const review = meta.review;

    if (!review) {
        await adHocDepth(store, meta, options);
        return;
    }

    const records = currentReviewRecords(readReviewRecords().records, name, review.chain);
    const gates = records.filter((record): record is ReviewGateRecord => record.kind === "gate");
    const lastGate = gates.at(-1);

    if (options.json) {
        out.result({ name, review, gates, turns: records.filter((record) => record.kind === "turn") });
        return;
    }

    const spent = review.spent;
    const lines = manifestChangedLines(review.manifest);
    out.println(
        `${pc.bold(name)} review · effort ${review.effort} (${review.effortSource === "flag" ? "--effort" : "diff size"}) · ${verdictCell(review.verdict ?? "open")}${review.escalatedTo ? ` → ${review.escalatedTo}` : ""}`
    );
    out.println(
        `base ${review.base} (${review.baseSource}: ${review.baseDetail})${review.branch ? ` · branch ${review.branch}` : ""}${review.pr === undefined ? "" : ` · PR #${review.pr}`}${review.parent ? ` · escalated from ${review.parent}` : ""}`
    );
    out.println(
        `manifest ${review.manifest.files.length} files, +${review.manifest.added} -${review.manifest.deleted} (${lines} lines)`
    );

    if (spent) {
        out.println(
            `spent ${spent.turns} turns · ${formatDuration(spent.durationMs)} · ${spent.toolCalls} tool calls · ${formatTokens(spent.reasoningTokens)} reasoning · ${money(spent.costUsd)}`
        );
    }

    if (lastGate) {
        for (const line of gateLines(lastGate)) {
            out.println(line);
        }
    }

    if (review.reason) {
        out.println(`reason: ${review.reason}`);
    }

    if (gates.length > 1) {
        out.println(pc.dim("gate history:"));

        for (const gate of gates) {
            // Local time, like every time this tool prints; the ledger keeps UTC.
            out.println(
                pc.dim(
                    `  ${new Date(gate.ts).toLocaleString("sv-SE")} step ${gate.step} ${gate.verdict}: ${gate.reason}`
                )
            );
        }
    }
}

export function registerReviewsCommands(program: Command): void {
    const reviews = program
        .command("reviews")
        .description("Every --mode review run from the review ledger: one row per review, with totals")
        .option("--since <when>", "Only reviews active since: a duration back (24h, 7d), HH:MM today, or a date")
        .option("--pr <n>", "Only reviews of this PR number")
        .option("--label <text>", "Only reviews whose spawn --label contains this text")
        .option("--effort [tier]", `Only reviews at this tier: ${REVIEW_EFFORTS.join(" | ")}`)
        .option("--verdict [verdict]", `Only reviews with this gate verdict: ${VERDICT_FILTERS.join(" | ")}`)
        .option("--name <text>", "Only reviews whose session or chain name contains this text")
        .option("--json", "Emit the reviews and totals as JSON")
        .action(async (options: ReviewsOptions) => {
            await runReviews(options);
        });

    reviews
        .command("import <name...>")
        .description(
            "Backfill the ledger from codex sessions that ran before it: start, turns from the cost ledger, and a gate line whose verdict the final Files reviewed line implies"
        )
        .option("--base <ref>", "The base of every named session; default each branch's PR target, else its upstream")
        .option("--cwd-from-session", "Read the manifest in each session's own cwd (the default)", true)
        .option("--no-cwd-from-session", "Leave every manifest null")
        .option("--json", "Emit the import results as JSON")
        .action(async (names: string[], options: ImportOptions) => {
            await runImport(names, options);
        });

    program
        .command("review-depth <name>")
        .description(
            "One review's depth: manifest, effort, spend, coverage, reasoning per 100 lines and the gate verdict"
        )
        .option("--base <ref>", "For a session spawned without --mode review: the base to measure it against")
        .option("--json", "Emit as JSON")
        .action(async (name: string, options: DepthOptions) => {
            await runReviewDepth(name, options);
        });
}
