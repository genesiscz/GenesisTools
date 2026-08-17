/**
 * CSV serialisation for the export paths (`top --csv`, `export --out`).
 *
 * Quoting follows RFC 4180: a field is quoted only when it holds a comma, a quote or a line
 * break, and an embedded quote is doubled. Track and artist names contain all of those —
 * including a bare `\r`, which a parser that accepts CR as a record terminator would
 * otherwise read as the end of the row.
 */

/**
 * Excel, Sheets and LibreOffice execute a cell whose text begins with `=`, `+`, `-` or `@`,
 * so a track named `=HYPERLINK("http://evil","click")` runs when the export is opened.
 * Artists name their own releases, which makes every name in this data untrusted text.
 *
 * Only STRINGS are neutralised. A number is structurally not a formula, and prefixing one
 * would turn a legitimate `-5` into the text `'-5` and break the column for every reader.
 */
function neutralizeFormula(s: string): string {
    return /^[\t\r\n ]*[=+\-@]/.test(s) ? `'${s}` : s;
}

export function csvCell(value: string | number | boolean | null | undefined): string {
    if (value === null || value === undefined) {
        return "";
    }

    const s =
        typeof value === "boolean"
            ? value
                ? "yes"
                : "no"
            : typeof value === "string"
              ? neutralizeFormula(value)
              : String(value);

    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(headers: string[], rows: (string | number | boolean | null | undefined)[][]): string {
    return `${[headers.join(","), ...rows.map((r) => r.map(csvCell).join(","))].join("\n")}\n`;
}
