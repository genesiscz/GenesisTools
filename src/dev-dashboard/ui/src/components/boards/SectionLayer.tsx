import type { CardDto } from "@app/dev-dashboard/contract/dto";

interface SectionLayerProps {
    cards: CardDto[];
    /** The section currently being inline-renamed (just created by the "section" tool), if any. */
    renamingId?: number | null;
    onRename?: (id: number, title: string) => void;
}

/** Journey section frames: always-visible background layers (title top-left), z-under content.
 *  Read-only in the canvas — editing goes through the AI-layer MCP tools (compose/update_cards)
 *  or the "section" tool's drag-to-create + inline rename. */
export function SectionLayer({ cards, renamingId, onRename }: SectionLayerProps) {
    const sections = cards.filter((c) => c.kind === "section");

    return (
        <>
            {sections.map((s) => {
                const title = typeof s.payload.title === "string" ? s.payload.title : "";
                return (
                    <div
                        key={s.id}
                        style={{
                            position: "absolute",
                            left: s.x,
                            top: s.y,
                            width: s.w,
                            height: s.h,
                            pointerEvents: "none",
                        }}
                        className="rounded-lg border border-[var(--dd-border)]"
                    >
                        {renamingId === s.id ? (
                            <input
                                autoFocus
                                defaultValue={title}
                                onFocus={(e) => e.currentTarget.select()}
                                onBlur={(e) => onRename?.(s.id, e.currentTarget.value)}
                                onKeyDown={(e) => {
                                    if (e.key === "Enter") {
                                        e.currentTarget.blur();
                                    }
                                }}
                                className="pointer-events-auto absolute -top-6 left-0 w-40 rounded bg-[var(--dd-bg-panel)] px-1 font-mono text-xs font-semibold text-[var(--dd-text-primary)] outline-none"
                            />
                        ) : (
                            <span className="absolute -top-6 left-0 font-mono text-xs font-semibold text-[var(--dd-text-secondary)]">
                                {title}
                            </span>
                        )}
                    </div>
                );
            })}
        </>
    );
}
