export interface UnmappedVerdict {
    blocked: boolean;
    items: Array<{ workItemId: number; minutes: number }>;
    totalMinutes: number;
}

/**
 * Decide whether unmapped work items stop a fill. Filling around them silently books an
 * incomplete month, so the default is to refuse and let the caller create the mappings first.
 */
export function checkUnmapped({
    unmappedByWi,
    allowUnmapped,
}: {
    unmappedByWi: Map<number, number>;
    allowUnmapped: boolean;
}): UnmappedVerdict {
    const items = [...unmappedByWi.entries()]
        .map(([workItemId, minutes]) => ({ workItemId, minutes }))
        .sort((a, b) => b.minutes - a.minutes || a.workItemId - b.workItemId);

    return {
        blocked: items.length > 0 && !allowUnmapped,
        items,
        totalMinutes: items.reduce((sum, item) => sum + item.minutes, 0),
    };
}
