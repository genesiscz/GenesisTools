import { type RunRedactArgs, runRedact } from "@app/secrets/lib/redact/run-redact";
import { type RunRestoreArgs, runRestore } from "@app/secrets/lib/redact/run-restore";
import type { Command } from "commander";

/**
 * `redact` is a group with a default `run` subcommand instead of a command that owns the options itself. A
 * parent that declares `--in` and `--out` swallows them when they come after `restore`, because commander
 * lets a parent claim its options anywhere on the line unless every ancestor opts into positional options,
 * and the shared `secrets` root cannot: that would break `-v` after a subcommand.
 */
export function registerRedactCommand(parent: Command): void {
    const redactCommand = parent
        .command("redact")
        .description("Reversibly redact secrets/PII from text before pasting into an AI, then restore the reply.");

    redactCommand
        .command("run", { isDefault: true })
        .description("Redact secrets and PII in text (what `redact` does when no subcommand is named).")
        .option("-i, --in <file>", "Read input from a file ('-' for stdin)")
        .option("-c, --clipboard", "Read input from the clipboard")
        .option("-o, --out <file>", "Write output to a file ('-' for stdout)")
        .option("-m, --map <file>", "Write the mapping to this file (in addition to the default session)")
        .option("-t, --types <list>", "Comma-separated detectors: keys,tokens,emails,ips,paths")
        .option("--phones", "Also redact phone numbers")
        .option("--json", "Emit { redacted, mapping } as JSON")
        .action(async (options: RunRedactArgs) => {
            await runRedact(options);
        });

    redactCommand
        .command("restore")
        .description("Swap placeholders back to originals using a saved mapping.")
        .option("-i, --in <file>", "Read input from a file ('-' for stdin)")
        .option("-c, --clipboard", "Read input from the clipboard")
        .option("-o, --out <file>", "Write output to a file ('-' for stdout)")
        .option("-m, --map <file>", "Mapping file to restore from (default: latest session)")
        .option("--json", "Emit { restored } as JSON")
        .action(async (options: RunRestoreArgs) => {
            await runRestore(options);
        });
}
