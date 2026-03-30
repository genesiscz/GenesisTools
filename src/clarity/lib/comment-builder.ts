// Indexed by JS Date.getDay(): 0=Sunday, 1=Monday, ..., 6=Saturday
// Clarity weeks start on Monday — output naturally starts with "Po" because dates sort ascending
const CZECH_DAYS = ["Ne", "Po", "Út", "St", "Čt", "Pá", "So"] as const;

interface CommentEntry {
    workItemId: number;
    timeTypeDescription: string;
    comment: string | null;
    date: string; // YYYY-MM-DD or YYYY-MM-DDTHH:mm:ss
}

export function buildWeekComment(entries: CommentEntry[]): string {
    if (entries.length === 0) {
        return "";
    }

    const byDate = new Map<string, CommentEntry[]>();

    for (const entry of entries) {
        const date = entry.date.split("T")[0];
        const group = byDate.get(date);

        if (group) {
            group.push(entry);
        } else {
            byDate.set(date, [entry]);
        }
    }

    const sortedDates = [...byDate.keys()].sort();
    const lines: string[] = [];

    for (const date of sortedDates) {
        const d = new Date(date + "T00:00:00");
        const dayName = CZECH_DAYS[d.getDay()];
        const day = d.getDate();
        const month = d.getMonth() + 1;

        lines.push(`${dayName}, ${day}.${month}:`);

        for (const entry of byDate.get(date)!) {
            const parts = [`#${entry.workItemId}`];

            if (entry.timeTypeDescription) {
                parts.push(entry.timeTypeDescription);
            }

            if (entry.comment) {
                parts.push(entry.comment);
            }

            lines.push(` - ${parts.join(" - ")}`);
        }
    }

    return lines.join("\n");
}
