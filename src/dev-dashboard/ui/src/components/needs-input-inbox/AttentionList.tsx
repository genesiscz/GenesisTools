import type { AttentionItem } from "@app/dev-dashboard/contract/dto";
import { AttentionRow } from "@/components/needs-input-inbox/AttentionRow";

interface AttentionListProps {
    items: AttentionItem[];
    onOpenTerminal: (ttydTabId: string) => void;
    onResolve: (qaId: string) => void;
    resolvingId: string | null;
}

/**
 * The attention queue panel: a count header + one `AttentionRow` per item, or an "All clear" empty
 * state. Mirrors the existing dev-dashboard web look (`dd-panel` / `dd-accent-text` / `--dd-*` tokens).
 */
export function AttentionList({ items, onOpenTerminal, onResolve, resolvingId }: AttentionListProps) {
    return (
        <div className="dd-panel flex flex-col gap-4 p-4">
            <div className="flex items-center justify-between gap-3">
                <h3 className="dd-accent-text text-lg font-semibold">Needs input</h3>
                <span
                    className="rounded-full border border-[var(--dd-border)] px-2 py-0.5 text-xs font-bold text-[var(--dd-accent)]"
                    style={{ background: "var(--dd-accent-muted, transparent)" }}
                    aria-label={`${items.length} items need input`}
                >
                    {items.length}
                </span>
            </div>

            {items.length === 0 ? (
                <div className="flex flex-col items-center justify-center gap-1 py-10 text-center">
                    <p className="text-sm text-[var(--dd-text-secondary)]">All clear</p>
                    <p className="text-xs text-[var(--dd-text-muted)]">
                        No agent questions or live agent sessions need you.
                    </p>
                </div>
            ) : (
                <div className="flex flex-col gap-2">
                    {items.map((item) => (
                        <AttentionRow
                            key={item.id}
                            item={item}
                            onOpenTerminal={onOpenTerminal}
                            onResolve={onResolve}
                            resolving={item.deepLink.kind === "qa" && resolvingId === item.deepLink.qaId}
                        />
                    ))}
                </div>
            )}
        </div>
    );
}
