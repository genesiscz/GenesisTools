import { resolve } from "node:path";
import { out } from "@app/logger";
import { runTool } from "@app/utils/cli";
import { Command } from "commander";
import { analyze } from "./lib/analyze";
import { render } from "./lib/render";

interface Options {
    top: string;
    json?: boolean;
}

const program = new Command();

program
    .name("monster")
    .description(
        "Repo health as a feedable ASCII monster. The scariest file becomes a monster you shrink by deleting cruft."
    )
    .argument("[dir]", "Directory to analyze", ".")
    .option("-t, --top <n>", "How many files to show in the leaderboard", "5")
    .option("--json", "Emit the report as JSON to stdout (no ASCII art)")
    .action(async (dir: string, options: Options) => {
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

await runTool(program, { tool: "monster" });
