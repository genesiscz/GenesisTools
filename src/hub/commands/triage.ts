import { out } from "@genesiscz/utils/logger";
import { createBoxTable, renderCliHeader, truncateDisplay } from "@genesiscz/utils/table";
import type { Command } from "commander";
import pc from "picocolors";
import { prChecks, prTriage } from "../lib/triage/index";

/**
 * `tools hub triage`: the open PRs of the configured projects with their readiness, as the phone's PR triage shows
 * them (`/api/gateway/prs`), and `tools hub triage checks <url>`, a PR's checks with the failing step's log tail.
 */
export function registerTriageCommand(program: Command): void {
    const triage = program
        .command("triage")
        .description("Open PRs with readiness (ready, waiting, blocked), unresolved threads and CI, ready ones first")
        .option("--mine", "only PRs I opened")
        .option("--limit <n>", "PRs per project", "30")
        .option("--json", "machine-readable output")
        .action(async (_opts: unknown, command: Command) => {
            const opts = command.optsWithGlobals<{ mine?: boolean; limit: string; json?: boolean }>();
            const result = await prTriage({ mine: opts.mine, limit: Number(opts.limit) || 30 });

            if (opts.json) {
                out.result(result);
                return;
            }

            renderCliHeader("PR triage", `${result.prs.length} open PR(s)`);
            const table = createBoxTable(["VERDICT", "PR", "CI", "THREADS", "TITLE"]);

            for (const pr of result.prs) {
                const verdict = pr.verdict ?? "unknown";
                table.push([
                    verdict === "ready" ? pc.green(verdict) : verdict === "blocked" ? pc.red(verdict) : verdict,
                    `${pr.repo}#${pr.number}`,
                    pr.ci ?? "",
                    String(pr.unresolved),
                    truncateDisplay(pr.title, 50),
                ]);
            }

            out.println(table.toString());

            for (const skipped of result.skipped) {
                out.log.warn(`${skipped.what}: ${skipped.reason}`);
            }
        });

    triage
        .command("checks <url>")
        .description("A PR's checks and the log tail of its first failed one")
        .option("--json", "machine-readable output")
        .action(async (url: string, _opts: unknown, command: Command) => {
            const opts = command.optsWithGlobals<{ json?: boolean }>();
            const result = await prChecks({ url });

            if (opts.json) {
                out.result(result);
                return;
            }

            for (const check of result.checks) {
                out.println(`${check.status ?? "?"}  ${check.name}`);
            }

            if (result.failing) {
                out.println(pc.red(`\n${result.failing.name}`));
                out.println(result.failing.lines.join("\n") || (result.failing.error ?? ""));
            }
        });
}
