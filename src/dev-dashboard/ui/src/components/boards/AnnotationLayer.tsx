import type { AnnotationDto, AnnotationStatus, CardDto, Region } from "@app/dev-dashboard/contract/dto";
import { Trash2 } from "lucide-react";
import { useMemo, useState } from "react";

/** World px per source px: card.w / naturalWidth (falls back to card.w when naturalWidth is unknown). */
export function getCardScaleFactor(card: CardDto): number {
    const naturalWidth = typeof card.payload.naturalWidth === "number" ? card.payload.naturalWidth : card.w;
    return card.w / naturalWidth;
}

/** Source-image px (as stored on the annotation) -> world px (as rendered on the card). */
export function regionToWorldRect(card: CardDto, region: Region): { x: number; y: number; w: number; h: number } {
    const factor = getCardScaleFactor(card);
    return { x: card.x + region.x * factor, y: card.y + region.y * factor, w: region.w * factor, h: region.h * factor };
}

export const STATUS_COLOR: Record<AnnotationStatus, string> = {
    staged: "var(--dd-text-muted)",
    open: "#f4f7f8",
    working: "#f59e0b",
    in_review: "#38bdf8",
    resolved: "#34d399",
    cancelled: "var(--dd-text-muted)",
};

interface LiveRegion {
    cardId: number;
    start: { x: number; y: number };
    current: { x: number; y: number };
}

interface AnnotationLayerProps {
    annotations: AnnotationDto[];
    cards: CardDto[];
    selectedId: number | null;
    onSelect: (id: number) => void;
    liveRegion: LiveRegion | null;
    onReviseStaged: (id: number, prompt: string) => void;
    onDeleteStaged: (id: number) => void;
}

/** Pins + region outlines, rendered inside the world transform. Purely visual/click-driven —
 * the region-drag gesture that produces a new annotation lives in BoardCanvas's shared overlay. */
export function AnnotationLayer({
    annotations,
    cards,
    selectedId,
    onSelect,
    liveRegion,
    onReviseStaged,
    onDeleteStaged,
}: AnnotationLayerProps) {
    const cardById = useMemo(() => new Map(cards.map((c) => [c.id, c])), [cards]);

    return (
        <>
            {annotations.map((annotation) => {
                const card = cardById.get(annotation.cardId);

                if (!card) {
                    return null;
                }

                const rect = regionToWorldRect(card, annotation.region);
                const color = STATUS_COLOR[annotation.status];
                const selected = annotation.id === selectedId;

                return (
                    <div key={annotation.id}>
                        {annotation.status !== "resolved" ? (
                            <div
                                className="absolute rounded-sm border-2"
                                style={{
                                    left: rect.x,
                                    top: rect.y,
                                    width: rect.w,
                                    height: rect.h,
                                    borderColor: color,
                                    background: `color-mix(in srgb, ${color} 12%, transparent)`,
                                    pointerEvents: "none",
                                }}
                            />
                        ) : null}
                        <button
                            type="button"
                            onClick={() => onSelect(annotation.id)}
                            title={annotation.prompt}
                            className={`absolute flex h-5 w-5 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border text-[10px] font-bold ${
                                annotation.status === "cancelled" ? "line-through opacity-60" : ""
                            } ${selected ? "ring-2 ring-[var(--dd-accent-from)]" : ""}`}
                            style={{
                                left: rect.x,
                                top: rect.y,
                                borderColor: color,
                                color,
                                background: "var(--dd-bg-base)",
                                // Cards carry zIndex: card.z (z-order feature) — without an explicit
                                // stack the pin paints under its own card and is unclickable.
                                zIndex: 9999,
                            }}
                        >
                            {annotation.id}
                        </button>
                        {annotation.status === "staged" && selected ? (
                            <StagedEditor
                                annotation={annotation}
                                rect={rect}
                                onReviseStaged={onReviseStaged}
                                onDeleteStaged={onDeleteStaged}
                            />
                        ) : null}
                    </div>
                );
            })}

            {liveRegion ? <LiveRegionRect liveRegion={liveRegion} cardById={cardById} /> : null}
        </>
    );
}

/** Floating prompt editor for the SELECTED staged annotation only (an always-open popup used to
 *  block clicks on everything under it). Trash is a quiet corner icon with an inline confirm. */
function StagedEditor({
    annotation,
    rect,
    onReviseStaged,
    onDeleteStaged,
}: {
    annotation: AnnotationDto;
    rect: { x: number; y: number; w: number; h: number };
    onReviseStaged: (id: number, prompt: string) => void;
    onDeleteStaged: (id: number) => void;
}) {
    const [confirming, setConfirming] = useState(false);

    return (
        <div
            className="absolute w-60 rounded-md border border-[var(--dd-border)] bg-[var(--dd-bg-panel)] p-2 text-xs shadow-lg"
            style={{ left: rect.x + 16, top: rect.y + rect.h + 8, zIndex: 10000 }}
            onPointerDown={(e) => e.stopPropagation()}
        >
            <textarea
                defaultValue={annotation.prompt}
                onBlur={(e) => {
                    if (e.target.value.trim() && e.target.value !== annotation.prompt) {
                        onReviseStaged(annotation.id, e.target.value);
                    }
                }}
                rows={3}
                className="w-full resize-none bg-transparent pr-5 text-[var(--dd-text-primary)] outline-none"
            />
            {confirming ? (
                <div className="absolute top-1.5 right-1.5 flex items-center gap-1">
                    <button
                        type="button"
                        onClick={() => onDeleteStaged(annotation.id)}
                        className="rounded bg-[var(--dd-danger)] px-1.5 py-0.5 text-[10px] font-semibold text-white"
                    >
                        delete
                    </button>
                    <button
                        type="button"
                        onClick={() => setConfirming(false)}
                        className="text-[10px] text-[var(--dd-text-muted)] hover:text-[var(--dd-text-primary)]"
                    >
                        keep
                    </button>
                </div>
            ) : (
                <button
                    type="button"
                    title="delete annotation"
                    onClick={() => setConfirming(true)}
                    className="absolute top-1.5 right-1.5 text-[var(--dd-text-muted)] hover:text-[var(--dd-danger)]"
                >
                    <Trash2 size={12} />
                </button>
            )}
        </div>
    );
}

function LiveRegionRect({ liveRegion, cardById }: { liveRegion: LiveRegion; cardById: Map<number, CardDto> }) {
    const card = cardById.get(liveRegion.cardId);

    if (!card) {
        return null;
    }

    const minX = Math.min(liveRegion.start.x, liveRegion.current.x);
    const minY = Math.min(liveRegion.start.y, liveRegion.current.y);
    const w = Math.abs(liveRegion.current.x - liveRegion.start.x);
    const h = Math.abs(liveRegion.current.y - liveRegion.start.y);

    return (
        <div
            className="absolute border border-dashed border-[var(--dd-danger)]"
            style={{
                left: card.x + minX,
                top: card.y + minY,
                width: w,
                height: h,
                background: "color-mix(in srgb, var(--dd-danger) 10%, transparent)",
                pointerEvents: "none",
            }}
        />
    );
}
