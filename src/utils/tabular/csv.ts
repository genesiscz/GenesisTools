export type CSVValue = string | number | boolean | null | undefined;

export function formatCSVCell({ value, alwaysQuote = false }: { value: CSVValue; alwaysQuote?: boolean }): string {
    if (value === null || value === undefined) {
        return alwaysQuote ? '""' : "";
    }

    let text = typeof value === "boolean" ? (value ? "yes" : "no") : String(value);

    if (typeof value === "string" && /^[\t\r\n ]*[=+\-@]/.test(text)) {
        text = `'${text}`;
    }

    return alwaysQuote || /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
