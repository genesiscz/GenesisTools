export const DATE_STYLES = ["iso", "dmy"] as const;
export type DateStyle = (typeof DATE_STYLES)[number];

let currentStyle: DateStyle = "iso";

/** Set once per process from the tool config; every report and comment renders dates in this style. */
export function setDateStyle(style: DateStyle): void {
    currentStyle = style;
}

export function getDateStyle(): DateStyle {
    return currentStyle;
}

/** `2026-09-08` (iso) or `8.9.2026` (dmy) from an ISO timestamp, in UTC; the input when it does not parse. */
export function formatDate(iso: string | null | undefined, style: DateStyle = currentStyle): string {
    if (!iso) {
        return "";
    }

    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) {
        return iso;
    }

    if (style === "dmy") {
        return `${d.getUTCDate()}.${d.getUTCMonth() + 1}.${d.getUTCFullYear()}`;
    }

    return d.toISOString().slice(0, 10);
}
