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
 * The shorthand flags and `--format` resolve to one value. `--format` wins when both are given,
 * because naming the format explicitly is the more deliberate of the two.
 */
export function resolveFormat(flags: FormatFlags): OutputFormat {
    if (flags.format !== undefined) {
        const wanted = flags.format.toLowerCase();

        if (!OUTPUT_FORMATS.includes(wanted as OutputFormat)) {
            throw new Error(`Unknown --format ${flags.format}. Use one of: ${OUTPUT_FORMATS.join(", ")}`);
        }

        return wanted as OutputFormat;
    }

    if (flags.jsonCompact) {
        return "json-compact";
    }

    if (flags.json) {
        return "json";
    }

    if (flags.md) {
        return "md";
    }

    if (flags.toon) {
        return "toon";
    }

    return "text";
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
        const text = toToon((rendered.compact ?? rendered.json)() as never);

        out.print(text);

        return text;
    }

    const lines = rendered.text();

    for (const line of lines) {
        out.println(line);
    }

    return lines.join("\n");
}
