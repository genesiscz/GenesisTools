export type MoodValue = 1 | 2 | 3 | 4 | 5;

export interface MoodScaleEntry {
    value: MoodValue;
    emoji: string;
    label: string;
    /** Hex color — semantic data color, shared by picker, chart, and history. */
    color: string;
    /** Tailwind text class for the same color (theme-independent data color). */
    textClass: string;
}

/**
 * The single source of truth for the 1-5 mood scale. Imported by the check-in
 * picker, the trend chart series/dots, and the history rows so the color+emoji
 * mapping is identical everywhere.
 */
export const MOOD_SCALE: Record<MoodValue, MoodScaleEntry> = {
    1: { value: 1, emoji: "😢", label: "Awful", color: "#f43f5e", textClass: "text-rose-400" },
    2: { value: 2, emoji: "😕", label: "Low", color: "#fb923c", textClass: "text-orange-400" },
    3: { value: 3, emoji: "😐", label: "Okay", color: "#facc15", textClass: "text-yellow-400" },
    4: { value: 4, emoji: "🙂", label: "Good", color: "#a3e635", textClass: "text-lime-400" },
    5: { value: 5, emoji: "😄", label: "Great", color: "#34d399", textClass: "text-emerald-400" },
};

export const MOOD_VALUES: MoodValue[] = [1, 2, 3, 4, 5];

export function moodMeta(value: number): MoodScaleEntry {
    const clamped = Math.min(5, Math.max(1, Math.round(value))) as MoodValue;
    return MOOD_SCALE[clamped];
}

/** Energy uses a calmer single-hue ramp (sky) so it reads distinct from mood. */
export const ENERGY_COLOR = "#38bdf8";

export const ENERGY_LABELS: Record<MoodValue, string> = {
    1: "Drained",
    2: "Tired",
    3: "Steady",
    4: "Lively",
    5: "Energized",
};

/** Local-day key "YYYY-MM-DD" for the user's timezone (never UTC). */
export function localDayKey(date: Date = new Date()): string {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
}

/** Add `days` to a "YYYY-MM-DD" key, returning a new key. */
export function addDays(dayKey: string, days: number): string {
    const [y, m, d] = dayKey.split("-").map(Number);
    const date = new Date(y, m - 1, d);
    date.setDate(date.getDate() + days);
    return localDayKey(date);
}

/** Short human label for a day key, e.g. "Jun 2". */
export function formatDayShort(dayKey: string): string {
    const [y, m, d] = dayKey.split("-").map(Number);
    const date = new Date(y, m - 1, d);
    return date.toLocaleDateString("default", { month: "short", day: "numeric" });
}
