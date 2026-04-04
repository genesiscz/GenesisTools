import type { ProviderName } from "@app/Internal/commands/reas/types";
import { fmt, fmtDateTime, pct } from "../../lib/format";

export { GRADE_COLORS } from "../analysis/display-model";

export const PROVIDER_BADGE_STYLES: Record<string, string> = {
    reas: "text-rose-300 border-rose-500/30 bg-rose-500/10",
    sreality: "text-cyan-300 border-cyan-500/30 bg-cyan-500/10",
    bezrealitky: "text-violet-300 border-violet-500/30 bg-violet-500/10",
    ereality: "text-emerald-300 border-emerald-500/30 bg-emerald-500/10",
    mf: "text-amber-300 border-amber-500/30 bg-amber-500/10",
};

export const PROVIDER_LABELS: Record<string, string> = {
    reas: "REAS",
    sreality: "Sreality",
    bezrealitky: "Bezrealitky",
    ereality: "Ereality",
    mf: "MF",
};

const VALID_PROVIDERS = new Set<ProviderName>(["reas", "sreality", "bezrealitky", "ereality", "mf"]);

export function parseSavedProviders(value: string | null | undefined): ProviderName[] {
    if (!value) {
        return [];
    }

    return value
        .split(",")
        .map((provider) => provider.trim())
        .filter((provider): provider is ProviderName => VALID_PROVIDERS.has(provider as ProviderName));
}

export function getStalenessInfo(lastAnalyzedAt: string | null): {
    label: string;
    color: string;
    isStale: boolean;
} {
    if (!lastAnalyzedAt) {
        return {
            label: "Never analyzed",
            color: "text-gray-500 border-gray-500/30 bg-gray-500/10",
            isStale: true,
        };
    }

    const diff = Date.now() - new Date(lastAnalyzedAt).getTime();
    const days = diff / (1000 * 60 * 60 * 24);

    if (days < 1) {
        return {
            label: "< 1 day ago",
            color: "text-emerald-400 border-emerald-500/30 bg-emerald-500/10",
            isStale: false,
        };
    }

    if (days < 7) {
        return {
            label: `${Math.floor(days)}d ago`,
            color: "text-amber-400 border-amber-500/30 bg-amber-500/10",
            isStale: false,
        };
    }

    return {
        label: `${Math.floor(days)}d ago`,
        color: "text-red-400 border-red-500/30 bg-red-500/10",
        isStale: true,
    };
}

export function formatCurrencyCompact(value: number | null | undefined): string {
    if (value == null) {
        return "-";
    }

    return fmt(value, {
        notation: "compact",
        maximumFractionDigits: 1,
    });
}

export function formatCurrencyFull(value: number | null | undefined): string {
    if (value == null) {
        return "-";
    }

    return `${fmt(Math.round(value))} CZK`;
}

export function formatNumber(value: number | null | undefined, digits = 0): string {
    if (value == null) {
        return "-";
    }

    return fmt(value, {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
    });
}

export function formatYield(value: number | null | undefined): string {
    if (value == null) {
        return "-";
    }

    return pct(value, { digits: 1 });
}

export function formatPercent(value: number | null | undefined): string {
    if (value == null) {
        return "-";
    }

    return pct(value, { digits: 0 });
}

export function formatDateTime(value: string | null | undefined): string {
    if (!value) {
        return "-";
    }

    return fmtDateTime(value, {
        dateStyle: "medium",
        timeStyle: "short",
    });
}

export function formatDateShort(value: string | null | undefined): string {
    if (!value) {
        return "-";
    }

    return fmtDateTime(value, {
        day: "2-digit",
        month: "short",
        year: "numeric",
        hour: undefined,
        minute: undefined,
    });
}

export function formatConstructionType(value: string): string {
    if (!value) {
        return "-";
    }

    return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

export function formatDisposition(value: string | null | undefined): string {
    if (!value) {
        return "All";
    }

    return value.toUpperCase();
}
