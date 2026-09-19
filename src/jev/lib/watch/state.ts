import type { Observation } from "@app/control/lib/decision/observation";

export interface WatchOcrBlock {
    id: string;
    text: string;
}

export interface WatchState {
    changed: Array<{ index: number; role: string; label?: string }>;
    unchangedCount: number;
    /** Present only when OCR was requested; an absent field is honest, an empty array is not. */
    ocr?: WatchOcrBlock[];
    snapshot: string;
}

export function encodeWatchState(current: Observation, previous?: Observation, ocr?: WatchOcrBlock[]): WatchState {
    const previousByIndex = new Map((previous?.elements ?? []).map((row) => [row.index, row]));
    const changed = current.elements.filter((row) => {
        const prior = previousByIndex.get(row.index);
        return (
            !prior ||
            prior.AXTitle !== row.AXTitle ||
            prior.AXValue !== row.AXValue ||
            prior.AXEnabled !== row.AXEnabled ||
            prior.visible !== row.visible
        );
    });
    return {
        changed: changed.map((row) =>
            typeof row.AXTitle === "string"
                ? { index: row.index, role: row.role, label: row.AXTitle }
                : { index: row.index, role: row.role }
        ),
        unchangedCount: current.elements.length - changed.length,
        ...(ocr ? { ocr: ocr.map((block) => ({ id: block.id, text: block.text })) } : {}),
        snapshot: current.snapshot,
    };
}
