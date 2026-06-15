#!/usr/bin/env bun
import { runTool } from "@app/utils/cli";
import { Command } from "commander";
import { type RedactCmdOptions, runRedactCommand } from "./commands/redact";
import { type RestoreCmdOptions, runRestoreCommand } from "./commands/restore";

const program = new Command();

program
    .name("redact")
    .description("Reversibly redact secrets/PII from text before pasting into an AI, then restore the reply.")
    .option("-i, --in <file>", "Read input from a file ('-' for stdin)")
    .option("-c, --clipboard", "Read input from the clipboard")
    .option("-o, --out <file>", "Write output to a file ('-' for stdout)")
    .option("-m, --map <file>", "Write the mapping to this file (in addition to the default session)")
    .option("-t, --types <list>", "Comma-separated detectors: keys,tokens,emails,ips,paths")
    .option("--phones", "Also redact phone numbers")
    .option("--json", "Emit { redacted, mapping } as JSON")
    .action(async (options: RedactCmdOptions) => {
        await runRedactCommand(options);
    });

program
    .command("restore")
    .description("Swap placeholders back to originals using a saved mapping.")
    .option("-i, --in <file>", "Read input from a file ('-' for stdin)")
    .option("-c, --clipboard", "Read input from the clipboard")
    .option("-o, --out <file>", "Write output to a file ('-' for stdout)")
    .option("-m, --map <file>", "Mapping file to restore from (default: latest session)")
    .option("--json", "Emit { restored } as JSON")
    .action(async (options: RestoreCmdOptions) => {
        await runRestoreCommand(options);
    });

await runTool(program, { tool: "redact" });
