import { parseDate } from "@genesiscz/utils/date";

export function parseHistoryDate({ value, now = new Date() }: { value: string; now?: Date }): Date {
    const normalized = value.trim().toLowerCase();
    const relative = normalized.match(/^(\d+)\s*(day|week|month|hour|minute)s?\s*ago$/);
    if (relative) {
        const amount = Number(relative[1]);
        const result = new Date(now);
        switch (relative[2]) {
            case "minute":
                result.setMinutes(result.getMinutes() - amount);
                break;
            case "hour":
                result.setHours(result.getHours() - amount);
                break;
            case "day":
                result.setDate(result.getDate() - amount);
                break;
            case "week":
                result.setDate(result.getDate() - amount * 7);
                break;
            case "month": {
                // setMonth clamps by rolling FORWARD into the next month when the day does not
                // exist in the target: from 31 March, minus one month landed on 3 March, so
                // `--since '1 month ago'` moved the window 28 days the WRONG way and silently
                // dropped almost everything it was meant to include.
                const day = result.getDate();
                result.setDate(1);
                result.setMonth(result.getMonth() - amount);
                const lastDay = new Date(result.getFullYear(), result.getMonth() + 1, 0).getDate();
                result.setDate(Math.min(day, lastDay));
                break;
            }
        }
        if (Number.isNaN(result.getTime())) {
            throw new Error(`Invalid history date: ${value}`);
        }
        return result;
    }
    if (normalized === "today" || normalized === "yesterday") {
        const result = new Date(now);
        if (normalized === "yesterday") {
            result.setDate(result.getDate() - 1);
        }
        result.setHours(0, 0, 0, 0);
        return result;
    }
    // `today` and `yesterday` above resolve to LOCAL midnight, but `parseDate` reads a bare
    // YYYY-MM-DD as UTC midnight, so the two spellings of the same day differed by the UTC offset
    // (two hours here) and `--since <today's date>` silently lost the start of the day. A calendar
    // day someone types is their local day, not a UTC one.
    const isoDay = normalized.match(/^(\d{4})-(\d{2})-(\d{2})$/);

    if (isoDay) {
        return new Date(Number(isoDay[1]), Number(isoDay[2]) - 1, Number(isoDay[3]));
    }

    return parseDate(value);
}
