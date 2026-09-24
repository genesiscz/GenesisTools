import { toToon } from "@app/json/lib/toon";
import { SafeJSON } from "@genesiscz/utils/json";
import { type Block, json2md } from "@genesiscz/utils/json2md";
import { out } from "@genesiscz/utils/logger";

/**
 * `json` is the readable object form, one named key per field. `json-compact` is the columnar
 * form: the field names are stated once in `cols` and every row is positional, which removes
 * roughly 80 characters of repeated keys per symbol.
 *
 * 🛑 `--json` used to BE the columnar form. It was renamed to `--json-compact` on 2026-09-22 so
 * that `--json` means what a reader expects it to mean across every subcommand here. A script
 * that parsed the old `--json` reads `cols` and positional arrays, so it must move to
 * `--json-compact` or to `--format json-compact`.
 */
export type OutputFormat = "text" | "md" | "json" | "json-compact" | "toon";

export const OUTPUT_FORMATS: OutputFormat[] = ["text", "md", "json", "json-compact", "toon"];

export interface FormatFlags {
    format?: string;
    md?: boolean;
    json?: boolean;
    jsonCompact?: boolean;
    toon?: boolean;
}

/** A format is machine-readable when a parser, rather than a person, is the consumer. */
export function isMachineFormat(format: OutputFormat): boolean {
    return format === "json" || format === "json-compact" || format === "toon";
}

/**
 * A mistake in how the command was called, as opposed to a bug. The command layer prints its
 * message as a one-line usage error instead of letting it escape as a stack trace.
 */
export class UsageError extends Error {}

/**
 * The shorthand flags and `--format` resolve to one value.
 *
 * 🛑 Two different answers are a usage error, not a precedence rule. `--md --json` used to print
 * JSON silently, so a caller that asked for both learned nothing about which one it got.
 * Repeating the same answer (`--format json --json`) is fine.
 */
export function resolveFormat(flags: FormatFlags): OutputFormat {
    const asked: OutputFormat[] = [];

    if (flags.format !== undefined) {
        const wanted = flags.format.toLowerCase();

        if (!OUTPUT_FORMATS.includes(wanted as OutputFormat)) {
            throw new UsageError(`Unknown --format ${flags.format}. Use one of: ${OUTPUT_FORMATS.join(", ")}`);
        }

        asked.push(wanted as OutputFormat);
    }

    if (flags.jsonCompact) {
        asked.push("json-compact");
    }

    if (flags.json) {
        asked.push("json");
    }

    if (flags.md) {
        asked.push("md");
    }

    if (flags.toon) {
        asked.push("toon");
    }

    const distinct = [...new Set(asked)];

    if (distinct.length > 1) {
        throw new UsageError(`Pick one output format; got ${distinct.join(" and ")}`);
    }

    return distinct[0] ?? "text";
}

export interface Rendered {
    /** Coloured lines for a terminal. */
    text: () => string[];
    /** json2md blocks; the caller never assembles markdown by hand. */
    md: () => Block[];
    /** The readable object form, and the source of the compact form when none is given. */
    json: () => unknown;
    /** The columnar form. Falls back to `json` when a report has no tabular shape. */
    compact?: () => unknown;
    /**
     * The object rows reshaped for TOON, whose tables only hold scalars: a nested array in one
     * column turns the whole table back into a list of separate objects. Falls back to `json`.
     */
    toon?: () => unknown;
}

/**
 * One exit for every subcommand, so `--md`, `--json`, `--json-compact` and `--toon` cannot
 * drift apart between them. Returns the plain text that was printed, which the caller measures
 * for its token-saving line.
 */
export function emit(format: OutputFormat, rendered: Rendered): string {
    if (format === "md") {
        const text = json2md(rendered.md());

        out.print(text);

        return text;
    }

    if (format === "json") {
        const text = SafeJSON.stringify(rendered.json());

        out.print(text);

        return text;
    }

    if (format === "json-compact") {
        const text = SafeJSON.stringify((rendered.compact ?? rendered.json)());

        out.print(text);

        return text;
    }

    if (format === "toon") {
        // TOON gets the OBJECT rows, never the positional ones. TOON turns an array of objects
        // that share their keys into one table with the keys named once, which is exactly what
        // the columnar form does by hand; feeding it positional arrays defeated that and cost
        // 15% more tokens than `--json-compact` (measured 2026-09-22 on src/utils: 493k tokens
        // against 428k). From the object rows it lands at 433k, level with the columnar form.
        const text = toToon((rendered.toon ?? rendered.json)());

        out.print(text);

        return text;
    }

    const lines = rendered.text();

    for (const line of lines) {
        out.println(line);
    }

    return lines.join("\n");
}
