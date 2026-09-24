import { type Command, InvalidArgumentError, Option } from "commander";
import type { CollectOptions } from "../lib/collect";
import { type FormatFlags, OUTPUT_FORMATS, UsageError } from "../lib/format";

export interface FormatCliFlags extends FormatFlags {}

export type ScanCliFlags = CollectOptions;

interface NumberRule {
    min?: number;
    max?: number;
    integer?: boolean;
}

/**
 * A commander argument parser that refuses a value the analysis cannot use.
 *
 * 🛑 These used to be `Number(raw)` with only a NaN check, and a NaN escaped as an uncaught throw
 * with a Bun stack dump. Worse, the in-range cases passed silently: `--similarity 5` reported zero
 * groups and `--similarity -1` grouped everything, and both read like a real answer. Commander
 * prints an `InvalidArgumentError` as a one-line usage error and exits 1.
 */
export function numberArg(rule: NumberRule): (raw: string) => number {
    return (raw: string): number => {
        const value = Number(raw);

        if (raw.trim() === "" || Number.isNaN(value)) {
            throw new InvalidArgumentError("Not a number.");
        }

        if (rule.integer && !Number.isInteger(value)) {
            throw new InvalidArgumentError("Must be a whole number.");
        }

        if (rule.min !== undefined && value < rule.min) {
            throw new InvalidArgumentError(`Must be at least ${rule.min}.`);
        }

        if (rule.max !== undefined && value > rule.max) {
            throw new InvalidArgumentError(`Must be at most ${rule.max}.`);
        }

        return value;
    };
}

/**
 * Run an action and print a `UsageError` the way commander prints its own: one line, exit 1.
 * Any other error is a bug and keeps its stack.
 */
export async function runUsage(command: Command, action: () => Promise<void>): Promise<void> {
    try {
        await action();
    } catch (error) {
        if (error instanceof UsageError) {
            command.error(`error: ${error.message}`);
        }

        throw error;
    }
}

/**
 * The output flags every `tools ts` subcommand except `imports` shares. Registering them in one
 * place is what stops `--md` from meaning one thing under `skeleton` and another under `refactors`.
 */
export function addFormatOptions(command: Command): Command {
    return command
        .addOption(new Option("--format <format>", "Output format").choices(OUTPUT_FORMATS))
        .option("--md", "Markdown, for a pull request or a note")
        .option("--json", "Readable JSON, one named key per field")
        .option("--json-compact", "Columnar JSON: the field names once in `cols`, positional rows")
        .option("--toon", "TOON: tables with the keys named once; about a third fewer tokens than --json");
}

/** The input flags every subcommand shares. */
export function addScanOptions(command: Command): Command {
    return command
        .option("--tests", "Include *.test.ts and *.spec.ts (skipped by default)")
        .option(
            "--ignore <substring>",
            "Skip any path containing this; repeatable",
            (value: string, previous: string[] = []) => [...previous, value],
            [] as string[]
        );
}
