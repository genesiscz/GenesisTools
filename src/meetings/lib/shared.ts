import { formatMissingEnumHelp, isInteractive, suggestCommand } from "@genesiscz/utils/cli";
import { ui } from "@genesiscz/utils/cli/ui";
import { MeetingsConflictError, MeetingsStateError } from "@genesiscz/utils/meetings/conflict";
import * as p from "@genesiscz/utils/prompts/p";

export const TOOL = "tools meetings";

/**
 * `--json` is the short form of `--format json`, as on every other meetings command (MC19). The `--format` value for
 * `resolveEnum`, or undefined (exit 1) when `--json` comes with another format.
 */
export function formatFlag(opts: { format?: string | boolean; json?: boolean }): { format: unknown } | undefined {
    if (!opts.json) {
        return { format: opts.format };
    }

    if (opts.format !== undefined && opts.format !== "json") {
        const other = opts.format === true ? "--format" : `--format ${opts.format}`;
        ui.err(`--json means --format json, so it cannot go with ${other}`);
        process.exitCode = 1;
        return undefined;
    }

    return { format: "json" };
}

/**
 * An enumerated flag declared `--flag [value]`: a value is checked, a bare flag prompts in a
 * terminal, and anything else prints the possible values with a ready command.
 */
export async function resolveEnum<T extends string>(options: {
    value: unknown;
    fallback?: T;
    values: readonly T[];
    flag: string;
    subcommand: string[];
}): Promise<T | undefined> {
    const { value, values, flag, subcommand } = options;

    if (value === undefined && options.fallback !== undefined) {
        return options.fallback;
    }

    if (typeof value === "string" && (values as readonly string[]).includes(value)) {
        return value as T;
    }

    if ((value === true || value === undefined) && isInteractive()) {
        const picked = await p.select({ message: flag, options: values.map((v) => ({ value: v, label: v })) });

        if (p.isCancel(picked)) {
            process.exitCode = 1;
            return undefined;
        }

        return picked as T;
    }

    ui.err(enumHint({ flag, values, subcommand, given: typeof value === "string" ? value : undefined }));
    process.exitCode = 1;
    return undefined;
}

/**
 * The refusal of an enumerated value, with a command that runs: the subcommand words stay in it (`suggestCommand`
 * strips them from argv, so they belong in the tool name), and a positional value (`<mode>`) is replaced in place.
 */
export function enumHint(options: {
    flag: string;
    values: readonly string[];
    subcommand: string[];
    given?: string;
}): string {
    const { flag, values, subcommand, given } = options;
    const example = values[0] ?? "<value>";
    const positional = flag.startsWith("<");
    const suggestion = suggestCommand([TOOL, ...subcommand].join(" "), {
        subcommand,
        remove: positional ? (given ? [given] : []) : [flag],
        add: positional ? [example] : [flag, example],
    });

    return formatMissingEnumHelp({ flag, values, given, suggestion });
}

/** `YYYY-MM-DD-HHMM` in local time, for the name of a backup a person finds by its time. */
export function localStamp(at: Date): string {
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}`;
}

export function fail(message: string): void {
    ui.err(message);
    process.exitCode = 1;
}

/**
 * The error's sentence; a conflict or a meeting state leads with its code (`[export-edited] …`,
 * `[no-transcript-source] …`), which the window reads.
 */
export function errorText(err: unknown): string {
    if (err instanceof MeetingsConflictError || err instanceof MeetingsStateError) {
        return `[${err.code}] ${err.message}`;
    }

    return err instanceof Error ? err.message : String(err);
}
