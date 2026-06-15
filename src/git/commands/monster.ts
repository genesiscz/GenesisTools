/**
 * Git Monster Command
 *
 * Repo health as a feedable ASCII monster. The scariest file becomes a monster
 * you shrink by deleting cruft. Shares its implementation with the standalone
 * `tools monster` entry point.
 */

import { resolve } from "node:path";
import { analyze } from "@app/git/lib/monster/analyze";
import { render } from "@app/git/lib/monster/render";
import { out } from "@app/logger";
import type { Storage } from "@app/utils/storage";
import type { Command } from "commander";

interface MonsterOptions {
    top: string;
    json?: boolean;
}

export function registerMonsterCommand(parent: Command, _storage: Storage): void {
    parent
        .command("monster")
        .description(
            "Repo health as a feedable ASCII monster. The scariest file becomes a monster you shrink by deleting cruft."
        )
        .argument("[dir]", "Directory to analyze", ".")
        .option("-t, --top <n>", "How many files to show in the leaderboard", "5")
        .option("--json", "Emit the report as JSON to stdout (no ASCII art)")
        .action(async (dir: string, options: MonsterOptions) => {
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

            out.print(render(report));
        });
}
