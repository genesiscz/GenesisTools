/**
 * Git Health Command
 *
 * Repo health as a clean, professional report. Shares the analysis core with
 * `git monster`; only the rendering differs (a ranked leaderboard table and
 * totals instead of ASCII art).
 */

import { resolve } from "node:path";
import { analyze } from "@app/git/lib/monster/analyze";
import { renderHealth } from "@app/git/lib/monster/render";
import { out } from "@app/logger";
import type { Storage } from "@app/utils/storage";
import type { Command } from "commander";

interface HealthOptions {
    top: string;
    json?: boolean;
}

export function registerHealthCommand(parent: Command, _storage: Storage): void {
    parent
        .command("health")
        .description("Repo health as a clean report: a ranked file leaderboard with score, size, age, and imports.")
        .argument("[dir]", "Directory to analyze", ".")
        .option("-t, --top <n>", "How many files to show in the leaderboard", "5")
        .option("--json", "Emit the report as JSON to stdout")
        .action(async (dir: string, options: HealthOptions) => {
            const top = Number.parseInt(options.top, 10);
            if (!Number.isInteger(top) || top < 1) {
                out.error(`--top must be a positive integer (got "${options.top}").`);
                process.exitCode = 1;
                return;
            }

            const absDir = resolve(process.cwd(), dir);
            const report = await analyze({ dir: absDir, now: Date.now(), top });

            if (options.json) {
                out.result(report);
                return;
            }

            out.result(renderHealth(report));
        });
}
