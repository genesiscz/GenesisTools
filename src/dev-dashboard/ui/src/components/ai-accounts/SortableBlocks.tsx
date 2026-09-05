import { ChevronDown, ChevronUp, EyeOff } from "lucide-react";
import type { ReactNode } from "react";
import type { BlockEntry } from "@/lib/block-layout";

interface SortableBlocksProps {
    layout: BlockEntry[];
    labels: Record<string, string>;
    onMove: (id: string, direction: -1 | 1) => void;
    onHide: (id: string) => void;
    onShow: (id: string) => void;
    onReset: () => void;
    /** Renders the body of one block. */
    render: (id: string) => ReactNode;
}

/**
 * Ordered, hideable blocks. Reordering works with the arrow buttons and the
 * keyboard today; a pointer drag layer slots in on top once a drag library is
 * chosen, without changing this component's contract.
 */
export function SortableBlocks({ layout, labels, onMove, onHide, onShow, onReset, render }: SortableBlocksProps) {
    const visible = layout.filter((b) => b.visible);
    const hidden = layout.filter((b) => !b.visible);

    return (
        <div className="flex flex-col gap-4">
            {visible.map((block, index) => (
                <section key={block.id} className="dd-ai-block relative" aria-label={labels[block.id] ?? block.id}>
                    <div className="dd-ai-block-tools absolute -top-3 right-3 z-10 flex items-center gap-1">
                        <span className="dd-ai-mono mr-1 text-[10px] text-[var(--dd-text-muted)]">
                            {labels[block.id] ?? block.id}
                        </span>
                        <button
                            type="button"
                            className="dd-ai-tool-btn"
                            aria-label={`Move ${labels[block.id] ?? block.id} up`}
                            disabled={index === 0}
                            onClick={() => onMove(block.id, -1)}
                        >
                            <ChevronUp size={12} />
                        </button>
                        <button
                            type="button"
                            className="dd-ai-tool-btn"
                            aria-label={`Move ${labels[block.id] ?? block.id} down`}
                            disabled={index === visible.length - 1}
                            onClick={() => onMove(block.id, 1)}
                        >
                            <ChevronDown size={12} />
                        </button>
                        <button
                            type="button"
                            className="dd-ai-tool-btn"
                            aria-label={`Hide ${labels[block.id] ?? block.id}`}
                            onClick={() => onHide(block.id)}
                        >
                            <EyeOff size={12} />
                        </button>
                    </div>
                    {render(block.id)}
                </section>
            ))}

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
