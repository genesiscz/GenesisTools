/** One markdown table cell: pipes escaped, newlines flattened, null as empty. */
export function markdownCell(value: unknown): string {
    if (value === null || value === undefined) {
        return "";
    }

    return String(value).replaceAll("|", "\\|").replaceAll(/\r?\n/g, " ");
}
