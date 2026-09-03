// Indexed by JS Date.getDay(): 0=Sunday, 1=Monday, ..., 6=Saturday
// Clarity weeks start on Monday — output naturally starts with "Po" because dates sort ascending
const CZECH_DAYS = ["Ne", "Po", "Út", "St", "Čt", "Pá", "So"] as const;

export interface CommentEntry {
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
        const d = new Date(`${date}T00:00:00`);
        const dayName = CZECH_DAYS[d.getDay()];
        const day = d.getDate();
        const month = d.getMonth() + 1;

        lines.push(`${dayName}, ${day}.${month}.:`);

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

/**
 * Build the note for one timesheet period. `periodFinishInclusive` is Clarity's `timePeriodFinish`,
 * which names the LAST day of the period, so the filter has to include it. Using the carousel's
 * exclusive `finish_date` here would pull the next week's first day into this note.
 */
export function buildPeriodComment({
    entries,
    periodStart,
    periodFinishInclusive,
}: {
    entries: CommentEntry[];
    periodStart: string;
    periodFinishInclusive: string;
}): string {
    const start = periodStart.split("T")[0];
    const finish = periodFinishInclusive.split("T")[0];

    return buildWeekComment(
        entries.filter((entry) => entry.date.split("T")[0] >= start && entry.date.split("T")[0] <= finish)
    );
}
