export const GRADE_COLORS: Record<string, string> = {
    A: "text-emerald-400 border-emerald-500/30 bg-emerald-500/10",
    B: "text-cyan-400 border-cyan-500/30 bg-cyan-500/10",
    C: "text-amber-400 border-amber-500/30 bg-amber-500/10",
    D: "text-orange-400 border-orange-500/30 bg-orange-500/10",
    F: "text-red-400 border-red-500/30 bg-red-500/10",
};

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

    return new Intl.NumberFormat("cs-CZ", {
        notation: "compact",
        maximumFractionDigits: 1,
    }).format(value);
}

export function formatCurrencyFull(value: number | null | undefined): string {
    if (value == null) {
        return "-";
    }

    return `${Math.round(value).toLocaleString("cs-CZ")} CZK`;
}

export function formatNumber(value: number | null | undefined, digits = 0): string {
    if (value == null) {
        return "-";
    }

    return value.toLocaleString("cs-CZ", {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
    });
}

export function formatYield(value: number | null | undefined): string {
    if (value == null) {
        return "-";
    }

    return `${value.toFixed(1)}%`;
}

export function formatPercent(value: number | null | undefined): string {
    if (value == null) {
        return "-";
    }

    return `${value.toFixed(0)}%`;
}

export function formatDateTime(value: string | null | undefined): string {
    if (!value) {
        return "-";
    }

    return new Intl.DateTimeFormat("en-GB", {
        dateStyle: "medium",
        timeStyle: "short",
    }).format(new Date(value));
}

export function formatDateShort(value: string | null | undefined): string {
    if (!value) {
        return "-";
    }

    return new Intl.DateTimeFormat("en-GB", {
        day: "2-digit",
        month: "short",
        year: "numeric",
    }).format(new Date(value));
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
