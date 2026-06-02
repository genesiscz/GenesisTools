import type { IconContainerVariant } from "@ui/custom";

export interface CategoryOption {
    value: string;
    label: string;
    accent: IconContainerVariant;
    /** Tailwind text-color class for the progress ring + badges. */
    colorClassName: string;
}

export const CATEGORY_OPTIONS: CategoryOption[] = [
    { value: "personal", label: "Personal", accent: "violet", colorClassName: "text-violet-400" },
    { value: "career", label: "Career", accent: "blue", colorClassName: "text-blue-400" },
    { value: "health", label: "Health", accent: "emerald", colorClassName: "text-emerald-400" },
    { value: "finance", label: "Finance", accent: "cyan", colorClassName: "text-cyan-400" },
    { value: "learning", label: "Learning", accent: "orange", colorClassName: "text-orange-400" },
    { value: "product", label: "Product", accent: "pink", colorClassName: "text-pink-400" },
];

export function categoryMeta(value: string): CategoryOption {
    return CATEGORY_OPTIONS.find((c) => c.value === value) ?? CATEGORY_OPTIONS[0];
}

export function currentQuarter(date = new Date()): string {
    const q = Math.floor(date.getMonth() / 3) + 1;
    return `${date.getFullYear()}-Q${q}`;
}

/** Window of quarters around the current one, ensuring `include` is present. */
export function quarterOptions(include?: string): string[] {
    const now = new Date();
    const year = now.getFullYear();
    const q = Math.floor(now.getMonth() / 3);

    const set = new Set<string>();
    for (let i = -1; i <= 4; i++) {
        const total = year * 4 + q + i;
        const yy = Math.floor(total / 4);
        const qq = (total % 4) + 1;
        set.add(`${yy}-Q${qq}`);
    }

    if (include) {
        set.add(include);
    }

    return Array.from(set).sort();
}

/** Sort quarters descending (newest first); empty quarter sinks to the bottom. */
export function compareQuartersDesc(a: string, b: string): number {
    if (a === b) {
        return 0;
    }

    if (!a) {
        return 1;
    }

    if (!b) {
        return -1;
    }

    return a < b ? 1 : -1;
}
