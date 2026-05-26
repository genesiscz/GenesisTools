export function formatSessionDatetimeSuffix(date = new Date(), includeMs = false): string {
    const pad = (value: number, length = 2): string => {
        return String(value).padStart(length, "0");
    };

    const y = date.getFullYear();
    const mo = pad(date.getMonth() + 1);
    const d = pad(date.getDate());
    const h = pad(date.getHours());
    const mi = pad(date.getMinutes());
    const s = pad(date.getSeconds());
    const base = `${y}-${mo}-${d}-${h}-${mi}-${s}`;

    if (!includeMs) {
        return base;
    }

    const ms = pad(date.getMilliseconds(), 3);
    return `${base}-${ms}`;
}

export function buildTimestampedSessionName(base: string, date = new Date(), includeMs = false): string {
    return `${base}-${formatSessionDatetimeSuffix(date, includeMs)}`;
}
