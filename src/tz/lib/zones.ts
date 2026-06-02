const ALIAS_MAP: Record<string, string> = {
    pst: "America/Los_Angeles",
    pdt: "America/Los_Angeles",
    mst: "America/Denver",
    mdt: "America/Denver",
    cst: "America/Chicago",
    cdt: "America/Chicago",
    est: "America/New_York",
    edt: "America/New_York",
    gmt: "Etc/GMT",
    bst: "Europe/London",
    cet: "Europe/Prague",
    cest: "Europe/Prague",
    eet: "Europe/Athens",
    utc: "UTC",
    prague: "Europe/Prague",
    london: "Europe/London",
    paris: "Europe/Paris",
    berlin: "Europe/Berlin",
    "new york": "America/New_York",
    newyork: "America/New_York",
    nyc: "America/New_York",
    la: "America/Los_Angeles",
    "los angeles": "America/Los_Angeles",
    tokyo: "Asia/Tokyo",
    sydney: "Australia/Sydney",
};

function isValidIanaZone(zone: string): boolean {
    try {
        new Intl.DateTimeFormat("en-US", { timeZone: zone });
        return true;
    } catch (err) {
        if (err instanceof RangeError) {
            return false;
        }

        throw err;
    }
}

export function resolveZone(token: string): string {
    const trimmed = token.trim();
    const alias = ALIAS_MAP[trimmed.toLowerCase()];
    if (alias) {
        return alias;
    }

    if (isValidIanaZone(trimmed)) {
        return trimmed;
    }

    throw new Error(`Unknown timezone: "${token}"`);
}
