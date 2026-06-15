import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { logger, out } from "@app/logger";
import { runTool } from "@app/utils/cli";
import { Command, Option } from "commander";
import { buildReport, type GroupBy } from "./lib/aggregate";
import { renderTable } from "./lib/render";
import { scanDirectory } from "./lib/walk";

interface Options {
    top?: string;
    by: GroupBy;
    json?: boolean;
    gitignore: boolean;
    includeHidden?: boolean;
}

const program = new Command();

program
    .name("loc")
    .description("Count files, code/blank/comment lines by language in a directory, respecting .gitignore.")
    .argument("[dir]", "Directory to scan", ".")
    .option("--top <n>", "Show only the top N rows by code lines")
    .addOption(new Option("--by <key>", "Group rows by language or extension").choices(["lang", "ext"]).default("lang"))
    .option("--json", "Emit the report as JSON instead of a table")
    .option("--no-gitignore", "Do not honour .gitignore (still skips .git/node_modules/dotfiles)")
    .option("--include-hidden", "Include dotfiles and dot-directories")
    .action(async (dir: string, options: Options) => {
        const root = resolve(dir);

        let isDirectory = false;
        try {
            isDirectory = existsSync(root) && statSync(root).isDirectory();
        } catch (err) {
            logger.debug({ root, error: err }, "loc: failed to stat target path");
        }

        if (!isDirectory) {
            out.error(`Not a directory: ${root}`);
            process.exit(1);
        }

        const top = parseTop(options.top);
        logger.debug({ root, by: options.by, gitignore: options.gitignore, top }, "loc: scanning");

        const files = await scanDirectory({
            root,
            gitignore: options.gitignore,
            includeHidden: Boolean(options.includeHidden),
        });

        const report = buildReport({ root, by: options.by, files, now: new Date(), top });

        if (options.json) {
            out.result(report);
            return;
        }

        out.println(renderTable(report));
    });

function parseTop(value: string | undefined): number | undefined {
    if (value === undefined) {
        return undefined;
    }

    if (!/^\d+$/.test(value)) {
        out.error(`--top must be a positive integer, got: ${value}`);
        process.exit(1);
    }

    const n = Number(value);
    if (n < 1) {
        out.error(`--top must be a positive integer, got: ${value}`);
        process.exit(1);
    }

    return n;
}

await runTool(program, { tool: "loc" });
