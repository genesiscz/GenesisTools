import { logger, out } from "@app/logger";
import { runTool } from "@app/utils/cli";
import { Command } from "commander";
import { runEnvdiff } from "./lib/driver";

interface Options {
    actual?: string;
    example?: string;
    showValues?: boolean;
    sync?: boolean;
    json?: boolean;
}

const program = new Command();

program
    .name("envdiff")
    .description("Diff .env against .env.example — missing/extra/changed keys, masked values, --sync to scaffold.")
    .argument("[args...]", "[dir] OR <actualFile> <exampleFile>")
    .option("--actual <path>", "Path to the actual env file (default: <dir>/.env)")
    .option("--example <path>", "Path to the reference file (default: <dir>/.env.example)")
    .option("--show-values", "Reveal values instead of masking them")
    .option("--sync", "Append missing keys to the actual file (existing keys untouched)")
    .option("--json", "Emit the diff as JSON")
    .action((argsList: string[], options: Options) => {
        const color = process.stdout.isTTY === true && options.json !== true;

        const result = runEnvdiff({
            positionals: argsList ?? [],
            actual: options.actual,
            example: options.example,
            showValues: options.showValues === true,
            sync: options.sync === true,
            json: options.json === true,
            color,
            cwd: process.cwd(),
            now: new Date(),
        });

        for (const line of result.status) {
            out.log.warn(line);
        }

        if (result.exitCode === 2) {
            out.error(result.status[0] ?? "envdiff failed.");
            process.exitCode = 2;
            return;
        }

        if (result.stdout.length > 0) {
            out.println(result.stdout);
        }

        logger.debug({ exitCode: result.exitCode }, "envdiff done");
        process.exitCode = result.exitCode;
    });

await runTool(program, { tool: "envdiff" });
