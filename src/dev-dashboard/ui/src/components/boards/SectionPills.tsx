import { useQuery } from "@tanstack/react-query";
import { boardsApi } from "./boards-api";

interface SectionPillsProps {
    slug: string;
    onSelect: (bounds: { minX: number; minY: number; maxX: number; maxY: number }) => void;
}

/** Pill navigation row over a board's journey sections (GET .../sections) — click pans/zooms the
 *  viewport to fit that section's frame. */
export function SectionPills({ slug, onSelect }: SectionPillsProps) {
    const query = useQuery({
        queryKey: ["board-sections", slug],
        queryFn: () => boardsApi.sections(slug),
        staleTime: 500,
    });

    const sections = query.data?.sections ?? [];

    if (sections.length === 0) {
        return null;
    }

    return (
        <div className="absolute top-2 left-1/2 z-20 flex max-w-[80%] -translate-x-1/2 gap-1 overflow-x-auto rounded-full border border-[var(--dd-border)] bg-[var(--dd-bg-panel)] px-2 py-1">
            {sections.map((s) => (
                <button
                    key={s.id}
                    type="button"
                    title={`${s.name} — ${s.cards} card${s.cards === 1 ? "" : "s"}`}
                    onClick={() => onSelect({ minX: s.x, minY: s.y, maxX: s.x + s.w, maxY: s.y + s.h })}
                    className="shrink-0 rounded-full px-2 py-0.5 text-xs whitespace-nowrap text-[var(--dd-text-secondary)] hover:bg-white/5 hover:text-[var(--dd-text-primary)]"
                >
                    {s.name}
                    {s.pass != null ? <span className="ml-1 opacity-60">· pass {s.pass}</span> : null}
                </button>
            ))}
        </div>
    );
}
