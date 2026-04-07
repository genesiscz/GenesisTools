export function parseDate(input: string): Date {
    const d = new Date(input);

    if (Number.isNaN(d.getTime())) {
        throw new Error(`Invalid date: ${input}`);
    }

    return d;
}

export function formatDateTime(iso: string): string {
    const d = new Date(iso);
    return d.toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
    });
}
