import { type Command, Option } from "commander";

/**
 * The shared window flags on a commander verb (design section 5): `--since`, `--until`, `--tz`,
 * plus the older spellings as hidden aliases so a door that moves onto this grammar keeps its
 * scripts working. `resolveWindow` reads them all and refuses two spellings of one bound.
 *
 * Read the values with `command.optsWithGlobals()`: under `tools ai usage`, the parent already
 * declares `--range` and takes it even when it is typed after the subcommand.
 */
export function addWindowOptions(command: Command, defaults: { since: string }): Command {
    return command
        .option(
            "--since <when>",
            `Start: a duration (90m 6h 7d 4w), a date YYYY-MM-DD (local midnight in --tz), an ISO instant with an offset, or today | yesterday | week | month (default ${defaults.since})`
        )
        .option("--until <when>", "End, in the same forms as --since (default now)")
        .option("--tz <zone>", "IANA time zone for dates, keywords and day boundaries (default: the system zone)")
        .addOption(new Option("--from <when>", "Alias of --since").hideHelp())
        .addOption(new Option("--to <when>", "Alias of --until").hideHelp())
        .addOption(new Option("--range <when>", "Alias of --since").hideHelp())
        .addOption(new Option("--hours <n>", "Alias of --since <n>h").hideHelp())
        .addOption(new Option("--timezone <zone>", "Alias of --tz").hideHelp());
}

/** `--harness`, declared hidden on verbs that refuse it, so the refusal names the right command. */
export function addReservedHarnessOption(command: Command): Command {
    return command.addOption(
        new Option("--harness [list...]", "Spend only: the agent that wrote the transcripts").hideHelp()
    );
}
