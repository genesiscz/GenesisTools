import {
    closestCenter,
    DndContext,
    type DragEndEvent,
    KeyboardSensor,
    PointerSensor,
    useSensor,
    useSensors,
} from "@dnd-kit/core";
import { rectSortingStrategy, SortableContext, sortableKeyboardCoordinates, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { EyeOff, GripVertical } from "lucide-react";
import type { ReactNode } from "react";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { assignBlockSpans, type BlockEntry } from "@/lib/block-layout";

// The filter row reads across the page, and the account cards already lay themselves
// out in their own responsive grid, so both always own their row. The two charts pair
// up side by side and stretch only when one ends a row alone, which keeps the grid
// gapless once a neighbour is hidden. Polling stays one column wide.
const FULL_WIDTH = ["filters", "accounts"] as const;
const WIDE_WHEN_ALONE = ["spend", "limits"] as const;

interface SortableBlockGridProps {
    layout: BlockEntry[];
    labels: Record<string, string>;
    onReorder: (activeId: string, overId: string) => void;
    onHide: (id: string) => void;
    onShow: (id: string) => void;
    onReset: () => void;
    /** Renders the body of one block. */
    render: (id: string) => ReactNode;
}

/**
 * The page section as a reorderable two-column grid. Each block keeps its own panel
 * surface, so there is no tile frame around it: the only chrome is a grip and a hide
 * button that fade in over the block. Dragging uses @dnd-kit, the same library and
 * sensor setup as the sidebar rail, so a pointer drag starts after 4px of travel and
 * the grip is also a keyboard handle (Space to pick up, arrows to move).
 */
export function SortableBlockGrid({
    layout,
    labels,
    onReorder,
    onHide,
    onShow,
    onReset,
    render,
}: SortableBlockGridProps) {
    const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
    const sensors = useSensors(
        useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
        useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
    );

    const visible = layout.filter((b) => b.visible);
    const hidden = layout.filter((b) => !b.visible);
    const spans = assignBlockSpans(
        visible.map((b) => b.id),
        { fullWidth: FULL_WIDTH, wideWhenAlone: WIDE_WHEN_ALONE }
    );
    const ids = spans.map((entry) => entry.id);

    const handleDragEnd = ({ active, over }: DragEndEvent) => {
        if (over === null || active.id === over.id) {
            return;
        }

        onReorder(String(active.id), String(over.id));
    };

    return (
        <div className="flex flex-col gap-4">
            {visible.length === 0 ? (
                <div className="dd-panel flex items-center justify-center p-8 text-[var(--dd-text-muted)]">
                    Every block is hidden. Show one below.
                </div>
            ) : (
                <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
                    <SortableContext items={ids} strategy={rectSortingStrategy}>
                        <div className="dd-ai-grid">
                            {spans.map((entry) => (
                                <GridBlock
                                    key={entry.id}
                                    id={entry.id}
                                    label={labels[entry.id] ?? entry.id}
                                    span={entry.span}
                                    reducedMotion={reducedMotion}
                                    onHide={onHide}
                                >
                                    {render(entry.id)}
                                </GridBlock>
                            ))}
                        </div>
                    </SortableContext>
                </DndContext>
            )}

            {hidden.length > 0 ? (
                <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--dd-text-muted)]">
                    <span>Hidden:</span>
                    {hidden.map((block) => (
                        <button
                            key={block.id}
                            type="button"
                            className="dd-ai-chip"
                            aria-pressed={false}
                            onClick={() => onShow(block.id)}
                        >
                            {labels[block.id] ?? block.id}
                        </button>
                    ))}
                    <button
                        type="button"
                        className="underline-offset-2 hover:text-[var(--dd-text-primary)] hover:underline"
                        onClick={onReset}
                    >
                        reset layout
                    </button>
                </div>
            ) : null}
        </div>
    );
}

interface GridBlockProps {
    id: string;
    label: string;
    span: 1 | 2;
    reducedMotion: boolean;
    onHide: (id: string) => void;
    children: ReactNode;
}

function GridBlock({ id, label, span, reducedMotion, onHide, children }: GridBlockProps) {
    const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });

    return (
        <section
            ref={setNodeRef}
            className="dd-ai-grid-block"
            aria-label={label}
            style={{
                // Transform and opacity only, so the reorder animates on the compositor;
                // a reduced-motion visitor gets the new position with no travel at all.
                gridColumn: span === 2 ? "1 / -1" : undefined,
                transform: CSS.Transform.toString(transform),
                transition: reducedMotion ? undefined : transition,
                opacity: isDragging ? 0.55 : 1,
                zIndex: isDragging ? 2 : undefined,
            }}
        >
            <div className="dd-ai-grid-tools">
                <span className="dd-ai-mono mr-1 text-[10px] text-[var(--dd-text-muted)]">{label}</span>
                <button
                    type="button"
                    className="dd-ai-tool-btn dd-ai-grip"
                    aria-label={`Reorder ${label}`}
                    {...attributes}
                    {...listeners}
                >
                    <GripVertical size={12} />
                </button>
                <button
                    type="button"
                    className="dd-ai-tool-btn"
                    aria-label={`Hide ${label}`}
                    onClick={() => onHide(id)}
                >
                    <EyeOff size={12} />
                </button>
            </div>
            {children}
        </section>
    );
}
