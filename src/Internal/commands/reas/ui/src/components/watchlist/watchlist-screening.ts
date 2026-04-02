import type { SavedPropertyRow } from "@app/Internal/commands/reas/lib/store";
import { getStalenessInfo } from "./watchlist-utils";

export type WatchlistSortKey = "updated" | "yield" | "score" | "price" | "district" | "name" | "grade" | "percentile";

export interface WatchlistScreeningOptions {
    search: string;
    districtFilter: string;
    gradeFilter: string;
    analysisFilter: string;
    yieldMin: string;
    yieldMax: string;
    sortKey: WatchlistSortKey;
    sortDirection: "asc" | "desc";
}

const GRADE_ORDER: Record<string, number> = {
    A: 5,
    B: 4,
    C: 3,
    D: 2,
    F: 1,
    ungraded: 0,
};

export function screenWatchlistProperties(
    properties: SavedPropertyRow[],
    options: WatchlistScreeningOptions
): SavedPropertyRow[] {
    const searchTerm = options.search.trim().toLowerCase();
    const yieldMin = parseOptionalNumber(options.yieldMin);
    const yieldMax = parseOptionalNumber(options.yieldMax);
    const direction = options.sortDirection === "asc" ? 1 : -1;

    const filtered = properties.filter((property) => {
        if (options.districtFilter !== "all" && property.district !== options.districtFilter) {
            return false;
        }

        if (!matchesGradeFilter(options.gradeFilter, property.last_grade)) {
            return false;
        }

        if (options.analysisFilter === "fresh" && getStalenessInfo(property.last_analyzed_at).isStale) {
            return false;
        }

        if (options.analysisFilter === "stale" && !getStalenessInfo(property.last_analyzed_at).isStale) {
            return false;
        }

        if (yieldMin !== undefined && (property.last_net_yield ?? Number.NEGATIVE_INFINITY) < yieldMin) {
            return false;
        }

        if (yieldMax !== undefined && (property.last_net_yield ?? Number.POSITIVE_INFINITY) > yieldMax) {
            return false;
        }

        if (!searchTerm) {
            return true;
        }

        const haystack = [property.name, property.district, property.notes ?? "", property.listing_url ?? ""]
            .join(" ")
            .toLowerCase();

        return haystack.includes(searchTerm);
    });

    filtered.sort((left, right) => {
        if (options.sortKey === "district") {
            return direction * left.district.localeCompare(right.district);
        }

        if (options.sortKey === "name") {
            return direction * left.name.localeCompare(right.name);
        }

        if (options.sortKey === "updated") {
            const leftValue = left.last_analyzed_at ? new Date(left.last_analyzed_at).getTime() : 0;
            const rightValue = right.last_analyzed_at ? new Date(right.last_analyzed_at).getTime() : 0;
            return direction * (leftValue - rightValue);
        }

        if (options.sortKey === "grade") {
            const leftValue = GRADE_ORDER[left.last_grade ?? "ungraded"] ?? 0;
            const rightValue = GRADE_ORDER[right.last_grade ?? "ungraded"] ?? 0;
            return direction * (leftValue - rightValue);
        }

        const valueMap: Record<
            Exclude<WatchlistSortKey, "district" | "name" | "updated" | "grade">,
            keyof SavedPropertyRow
        > = {
            yield: "last_net_yield",
            score: "last_score",
            price: "target_price",
            percentile: "percentile",
        };

        const leftValue = Number(left[valueMap[options.sortKey]] ?? 0);
        const rightValue = Number(right[valueMap[options.sortKey]] ?? 0);
        return direction * (leftValue - rightValue);
    });

    return filtered;
}

function matchesGradeFilter(filter: string, grade: string | null): boolean {
    if (filter === "all") {
        return true;
    }

    if (filter === "ungraded") {
        return !grade;
    }

    if (filter.includes("-")) {
        const [minGrade, maxGrade] = filter.split("-");
        const gradeValue = GRADE_ORDER[grade ?? "ungraded"] ?? 0;
        const minValue = GRADE_ORDER[minGrade] ?? 0;
        const maxValue = GRADE_ORDER[maxGrade] ?? 0;

        return gradeValue <= minValue && gradeValue >= maxValue;
    }

    return grade === filter;
}

function parseOptionalNumber(value: string): number | undefined {
    if (!value.trim()) {
        return undefined;
    }

    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
}
