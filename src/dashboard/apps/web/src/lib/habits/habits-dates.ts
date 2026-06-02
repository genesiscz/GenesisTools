/**
 * Local-time day-key helpers for habits. The `day` column is a LOCAL
 * "YYYY-MM-DD" key — never UTC. Using `toISOString()` would shift the day
 * for users far from GMT and break "toggle today" vs. the heatmap's today
 * cell. All reads/writes go through these helpers so the key is consistent.
 */

/** Local "YYYY-MM-DD" for a Date (defaults to now). */
export function toDayKey(date: Date = new Date()): string {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
}

/** Today's local day key. */
export function todayKey(): string {
    return toDayKey(new Date());
}

/**
 * Build a contiguous list of local day keys ending at `end` (inclusive),
 * going back `days` total. Anchored at local noon and decremented so DST
 * midnight transitions never skip or double a day.
 */
export function dayKeyRange(days: number, end: Date = new Date()): string[] {
    const cursor = new Date(end.getFullYear(), end.getMonth(), end.getDate(), 12, 0, 0, 0);
    const keys: string[] = [];
    for (let i = days - 1; i >= 0; i--) {
        const d = new Date(cursor);
        d.setDate(cursor.getDate() - i);
        keys.push(toDayKey(d));
    }
    return keys;
}

/**
 * Monday-anchored start of the ISO week containing `date`, as a local day key.
 * Both the weekly progress count and the heatmap columns use Monday-start.
 */
export function weekStartKey(date: Date = new Date()): string {
    const noon = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12, 0, 0, 0);
    const dow = noon.getDay(); // 0 = Sun .. 6 = Sat
    const backToMonday = (dow + 6) % 7;
    noon.setDate(noon.getDate() - backToMonday);
    return toDayKey(noon);
}
