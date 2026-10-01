import { out } from "@genesiscz/utils/logger";
import { maxCacheAgeOption, resolveMaxCacheAge } from "@genesiscz/utils/storage/cache-flag";
import { type DotStatusKind, formatDotStatus } from "@genesiscz/utils/table";
import type { Command } from "commander";
import pc from "picocolors";
import { type PrReadiness, prReadinessMany, type ReadinessVerdict } from "../lib/pr-readiness";

const DOT: Record<ReadinessVerdict, DotStatusKind> = { ready: "ok", waiting: "warn", blocked: "err", closed: "dim" };

function render(readiness: PrReadiness): void {
    const label = readiness.provider === "gitlab" ? `!${readiness.number}` : `#${readiness.number}`;
    out.println(
        `${formatDotStatus(DOT[readiness.verdict], readiness.verdict)} ${pc.white(label)} ${readiness.title ?? ""}`
    );
    out.println(`  ${readiness.summary}`);
    const facts = [
        `CI ${readiness.ci ?? "none"}`,
        `${readiness.unresolved} unresolved${readiness.outdatedUnresolved ? ` (+${readiness.outdatedUnresolved} outdated)` : ""}`,
        readiness.lastReviewAt ? `last review ${readiness.lastReviewAt} by ${readiness.lastReviewBy}` : "no review",
        readiness.lastPushAt ? `last push ${readiness.lastPushAt}` : null,
        readiness.staleReviewers.length ? `re-review due from ${readiness.staleReviewers.join(", ")}` : null,
        readiness.cached ? "cached" : null,
    ].filter((part) => part !== null);
    out.println(pc.dim(`  ${facts.join(" · ")}`));

    for (const reason of readiness.reasons.slice(1)) {
        out.println(pc.dim(`  also: ${reason}`));
    }
}

/** `tools hub pr readiness`: the PR list's "ready to merge?" verdict, with the reason. */
export function registerReadinessCommand(pr: Command): void {
    pr.command("readiness")
        .description(
            "Ready to merge? Unresolved non-outdated threads (every reviewer), CI, last review vs last push, conflicts; read-only, cached per head SHA"
        )
        .argument(
            "<refs...>",
            "PR/MR URLs, <repoPath>#<n>, or <n> for this folder's repo; append @<headSha> when the head is known, so a cached answer for it is used"
        )
        .addOption(
            maxCacheAgeOption(
                "answer, never older than 10 min for a ref@head of that head or 60 s (and not 'ready') for a bare ref,"
            )
        )
        .option("--fresh", "the default; kept for old callers (same as --max-cache-age 0)")
        .option("--json", "machine-readable output: one {input, readiness, error} per ref")
        .action(async (refs: string[], opts: { fresh?: boolean; maxCacheAge?: number; json?: boolean }) => {
            const outcomes = await prReadinessMany({ inputs: refs, maxCacheAgeSeconds: resolveMaxCacheAge(opts) });

            if (outcomes.some((outcome) => outcome.error)) {
                process.exitCode = 1;
            }

            if (opts.json) {
                out.result(outcomes);
                return;
            }

            for (const outcome of outcomes) {
                if (outcome.readiness) {
                    render(outcome.readiness);
                } else {
                    out.log.error(`${outcome.input}: ${outcome.error}`);
                }
            }
        });
}
