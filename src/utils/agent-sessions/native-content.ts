/** Flatten values for textual matching; callers may retain legacy preview budgets explicitly. */
export function flattenToolInput(options: { input: unknown; fieldLimit?: number; totalLimit?: number }): string {
    const parts: string[] = [];
    let total = 0;
    function visit(value: unknown): void {
        if (total >= (options.totalLimit ?? Infinity)) {
            return;
        }
        if (typeof value === "string") {
            const slice = value.slice(0, options.fieldLimit ?? value.length);
            parts.push(slice);
            total += slice.length;
        } else if (Array.isArray(value)) {
            for (const nested of value) {
                visit(nested);
            }
        } else if (value && typeof value === "object") {
            for (const nested of Object.values(value)) {
                visit(nested);
            }
        }
    }
    visit(options.input);
    return parts.join(" ");
}
