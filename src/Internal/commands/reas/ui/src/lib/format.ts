export interface PercentOptions {
    digits?: number;
    signed?: boolean;
}

const CZECH_LOCALE = "cs-CZ";

function normalizeSpacing(value: string): string {
    return value.replace(/\u00a0/g, " ");
}

export function fmt(value: number, options?: Intl.NumberFormatOptions): string {
    return normalizeSpacing(value.toLocaleString(CZECH_LOCALE, options));
}

export function fmtInteger(value: number): string {
    return fmt(Math.round(value));
}

export function fmtCurrency(value: number, currency = "CZK"): string {
    return `${fmtInteger(value)} ${currency}`;
}

export function fmtCompactCurrency(value: number, currency = "CZK"): string {
    if (Math.abs(value) >= 1_000_000) {
        return `${(value / 1_000_000).toFixed(1)}M ${currency}`;
    }

    if (Math.abs(value) >= 1_000) {
        return `${(value / 1_000).toFixed(0)}k ${currency}`;
    }

    return fmtCurrency(value, currency);
}

export function fmtK(value: number): string {
    return `${(value / 1_000).toFixed(0)}k`;
}

export function fmtM(value: number): string {
    return `${(value / 1_000_000).toFixed(1)}M`;
}

export function pct(value: number, options?: PercentOptions): string {
    const digits = options?.digits ?? 1;
    const prefix = options?.signed && value > 0 ? "+" : "";

    return `${prefix}${value.toFixed(digits)}%`;
}

export function fmtPercentile(value: number): string {
    const rounded = Math.round(value);
    const mod100 = rounded % 100;

    if (mod100 >= 11 && mod100 <= 13) {
        return `${rounded}th percentile`;
    }

    const mod10 = rounded % 10;

    if (mod10 === 1) {
        return `${rounded}st percentile`;
    }

    if (mod10 === 2) {
        return `${rounded}nd percentile`;
    }

    if (mod10 === 3) {
        return `${rounded}rd percentile`;
    }

    return `${rounded}th percentile`;
}

export function fmtDays(value: number): string {
    return `${Math.round(value)} days`;
}

export function fmtDateTime(value: string | Date, options?: Intl.DateTimeFormatOptions): string {
    const parsed = value instanceof Date ? value : new Date(value);

    if (Number.isNaN(parsed.getTime())) {
        return typeof value === "string" ? value : "";
    }

    const resolvedOptions: Intl.DateTimeFormatOptions =
        options?.dateStyle || options?.timeStyle
            ? options
            : {
                  year: "numeric",
                  month: "2-digit",
                  day: "2-digit",
                  hour: "2-digit",
                  minute: "2-digit",
                  ...options,
              };

    return normalizeSpacing(new Intl.DateTimeFormat(CZECH_LOCALE, resolvedOptions).format(parsed));
}
