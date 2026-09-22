import type { Command } from "commander";
import type { FormatFlags } from "../lib/format";

export interface FormatCliFlags extends FormatFlags {}

export interface ScanCliFlags {
    tests?: boolean;
    ignore?: string[];
}

/**
 * The output flags every `tools ts` subcommand shares. Registering them in one place is what
 * stops `--md` from meaning one thing under `skeleton` and another under `refactors`.
 */
export function addFormatOptions(command: Command): Command {
    return command
        .option("--format <format>", "Output format: text, md, json, json-compact, toon")
        .option("--md", "Markdown, for a pull request or a note")
        .option("--json", "Readable JSON, one named key per field")
        .option("--json-compact", "Columnar JSON: the field names once in `cols`, positional rows")
        .option("--toon", "TOON: the compact data, roughly 40% fewer tokens again");
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
