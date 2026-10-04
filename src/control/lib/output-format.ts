import { suggestEnumFlag } from "@genesiscz/utils/cli";
import { ui } from "@genesiscz/utils/cli/ui";
import type { Command } from "commander";

export const OUTPUT_FORMATS = ["table", "json"] as const;
export type OutputFormat = (typeof OUTPUT_FORMATS)[number];

export interface FormatOptions {
    format?: string | boolean;
    json?: boolean;
}

/**
 * `--format table|json` on a command that renders a table.
 *
 * Declared with `[format]` rather than `<format>` because commander answers a missing required
 * value with a generic error that never lists the possible ones; the empty case is handled here
 * instead. `--json` stays as an alias, since it is what these commands shipped with.
 */
export function addFormatOption(command: Command): Command {
    return command
        .option("--format [format]", `output format: ${OUTPUT_FORMATS.join(" or ")}`)
        .option("--json", "raw JSON output (same as --format json)");
}

/** The chosen format, or `undefined` after reporting an invalid one and setting the exit code. */
export function resolveFormat(options: FormatOptions, command: string): OutputFormat | undefined {
    // Only an ABSENT flag defaults. Commander gives `true` for a bare `--format` with no value,
    // and treating that as absent silently printed a table to someone who asked for a format and
    // mistyped it; it must reach the invalid-format handler and list the values instead.
    if (options.format === undefined) {
        return options.json === true ? "json" : "table";
    }

    if ((OUTPUT_FORMATS as readonly string[]).includes(String(options.format))) {
        return String(options.format) as OutputFormat;
    }

    ui.err(suggestEnumFlag(command, "--format", [...OUTPUT_FORMATS]));
    process.exitCode = 1;
    return undefined;
}

/**
 * Content widths for a boxed table, cut only as far as the terminal needs. Columns shrink in
 * `shrinkOrder`, each down to `minimum`, so the column worth reading in full (the identity in
 * `doctor`) is cut last. Without a terminal width, a pipe or a file, nothing is cut at all.
 */
export function fitColumnWidths({
    natural,
    available,
    shrinkOrder,
    minimum = 12,
}: {
    natural: number[];
    available: number | undefined;
    shrinkOrder: number[];
    minimum?: number;
}): number[] {
    const widths = [...natural];

    if (available === undefined) {
        return widths;
    }

    const borders = 3 * widths.length + 1;
    let excess = widths.reduce((sum, width) => sum + width, 0) + borders - available;

    for (const column of shrinkOrder) {
        if (excess <= 0) {
            break;
        }

        const cut = Math.min(excess, Math.max(0, widths[column] - minimum));
        widths[column] -= cut;
        excess -= cut;
    }

    return widths;
}

/** The width a table may use on stdout, or undefined when stdout is not a terminal. */
export function stdoutTableWidth(): number | undefined {
    return process.stdout.isTTY ? process.stdout.columns : undefined;
}
