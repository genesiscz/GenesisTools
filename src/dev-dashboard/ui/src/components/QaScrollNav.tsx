import type { QaRow } from "@app/dev-dashboard/lib/qa-types";
import { resolveQaRecency } from "@app/utils/ui/helpers/qa-recency";
import { ScrollArea } from "@ui/components/scroll-area";

const TAG_DOT: Record<string, string> = {
    action: "bg-[#a3e635]",
    directive: "bg-[#c792ea]",
    question: "bg-[var(--dd-text-secondary)]",
};

export const QA_SCROLL_NAV_OFFSET_PX = 400;

export function QaScrollNav({
    entries,
    seenIds,
    visible,
}: {
    entries: QaRow[];
    seenIds: Set<string>;
    visible: boolean;
}) {
    if (!visible) {
        return null;
    }

    const jumpTo = (id: string): void => {
        document
            .querySelector(`[data-qa-id="${CSS.escape(id)}"]`)
            ?.scrollIntoView({ behavior: "smooth", block: "start" });
    };

    return (
        <aside className="dd-panel fixed top-20 right-2 z-20 w-64 max-h-[calc(100vh-6rem)]">
            <div className="border-b border-[var(--dd-border)] px-3 py-2 text-xs tracking-wider text-[var(--dd-text-muted)] uppercase">
                Navigate ({entries.length})
            </div>
            <ScrollArea className="max-h-[calc(100vh-9rem)]">
                <ul className="flex flex-col">
                    {entries.map((e) => {
                        const unread = !seenIds.has(e.id);
                        const { relative } = resolveQaRecency(e.ts, Date.now());

                        return (
                            <li key={e.id}>
                                <button
                                    type="button"
                                    onClick={() => jumpTo(e.id)}
                                    className="flex w-full items-start gap-2 border-b border-[var(--dd-border)]/50 px-3 py-1.5 text-left text-xs hover:bg-white/5"
                                >
                                    <span
                                        className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${TAG_DOT[e.tag] ?? TAG_DOT.question} ${unread ? "ring-2 ring-emerald-400/60" : ""}`}
                                        aria-hidden
                                    />
                                    <span className="min-w-0 flex-1">
                                        <span className="block truncate text-[var(--dd-text-primary)]">
                                            {e.question.slice(0, 60)}
                                        </span>
                                        <span className="block font-mono text-[var(--dd-text-muted)] tabular-nums">
                                            {relative}
                                        </span>
                                    </span>
                                </button>
                            </li>
                        );
                    })}
                </ul>
            </ScrollArea>
        </aside>
    );
}
