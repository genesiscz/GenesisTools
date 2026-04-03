import type { ReactNode } from "react";

export interface PercentOptions {
    digits?: number;
    signed?: boolean;
}

export function fmt(value: number, options?: Intl.NumberFormatOptions): string {
    return value.toLocaleString("cs-CZ", options).replace(/\u00a0/g, " ");
}

export function fmtInteger(value: number): string {
    return fmt(Math.round(value));
}

export function fmtCurrency(value: number): string {
    return `${fmtInteger(value)} CZK`;
}

export function fmtCompactCurrency(value: number): string {
    if (Math.abs(value) >= 1_000_000) {
        return `${(value / 1_000_000).toFixed(1)}M CZK`;
    }

    if (Math.abs(value) >= 1_000) {
        return `${(value / 1_000).toFixed(0)}k CZK`;
    }

    return fmtCurrency(value);
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

export function renderMaybe(value: ReactNode | null | undefined, fallback = "-"): ReactNode {
    if (value == null || value === "") {
        return fallback;
    }

    return value;
}
