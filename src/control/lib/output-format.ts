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
    if (options.format === undefined || options.format === true) {
        return options.json === true ? "json" : "table";
    }

    if ((OUTPUT_FORMATS as readonly string[]).includes(String(options.format))) {
        return String(options.format) as OutputFormat;
    }

    ui.err(suggestEnumFlag(command, "--format", [...OUTPUT_FORMATS]));
    process.exitCode = 1;
    return undefined;
}
