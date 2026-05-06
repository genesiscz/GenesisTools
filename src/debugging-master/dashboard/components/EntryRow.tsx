import type { IndexedLogEntry } from "@app/debugging-master/types";
import { memo } from "react";
import { formatDurationMs, formatTime } from "@/lib/format";
import { LEVEL_META } from "@/lib/levels";
import { ExpandedView } from "./ExpandedView";
import { InlineJsonPreview } from "./InlineJsonPreview";

type InlinePayload = { kind: "json"; value: unknown } | { kind: "text"; value: string } | null;

interface Props {
    entry: IndexedLogEntry;
    expanded: boolean;
    fresh: boolean;
    onToggle: (index: number) => void;
    onFilterHypothesis?: (h: string) => void;
}

function EntryRowImpl({ entry, expanded, fresh, onToggle, onFilterHypothesis }: Props): React.ReactElement {
    const failed = entry.level === "assert" && entry.passed === false;
    const refMeta = LEVEL_META[entry.level];
    const refId = refMeta.refPrefix ? `${refMeta.refPrefix}${entry.index}` : null;
    const inline: InlinePayload = !expanded ? getInlinePayload(entry) : null;

    return (
        <div
            className="entry-row"
            data-lvl={entry.level}
            data-failed={failed ? "true" : undefined}
            data-fresh={fresh ? "true" : undefined}
            onClick={() => onToggle(entry.index)}
            onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onToggle(entry.index);
                }
            }}
            role="button"
            tabIndex={0}
        >
            <div className="px-3 sm:px-4 py-1.5 flex items-baseline gap-2.5 text-[12px]">
                <span className="text-white/35 tabular-nums">{formatTime(entry.ts)}</span>
                <span
                    className="lvl-chip"
                    data-lvl={entry.level}
                    data-failed={failed ? "true" : undefined}
                    title={LEVEL_META[entry.level].description}
                >
                    {LEVEL_META[entry.level].label}
                </span>
                {entry.h ? (
                    <button
                        type="button"
                        onClick={(e) => {
                            e.stopPropagation();
                            onFilterHypothesis?.(entry.h!);
                        }}
                        className="h-chip"
                        title={`filter by hypothesis: ${entry.h}`}
                    >
                        h:{entry.h}
                    </button>
                ) : null}
                <span className="flex-1 truncate-mono">
                    {entry.label ? <span className="text-amber-200">{entry.label}</span> : null}
                    {entry.label && entry.msg ? <span className="text-white/40"> · </span> : null}
                    {entry.msg ? <span className="text-white/85">{entry.msg}</span> : null}
                    {!entry.label && !entry.msg && !inline ? (
                        <span className="text-white/40">{describeAssert(entry)}</span>
                    ) : null}
                </span>
                {entry.durationMs !== undefined ? (
                    <span className="text-purple-300 text-[12px] tabular-nums">
                        {formatDurationMs(entry.durationMs)}
                    </span>
                ) : null}
                {refId ? <span className="text-white/45 text-[12px] tabular-nums">{refId}</span> : null}
                <span className="text-white/45 text-[12px]">{expanded ? "▾" : "▸"}</span>
            </div>
            {inline ? (
                <div className="json-tree px-3 sm:px-4 pb-1.5 pl-[5.5rem] sm:pl-[6.5rem] text-[11px] truncate-mono">
                    {inline.kind === "json" ? (
                        <InlineJsonPreview value={inline.value} maxChars={200} />
                    ) : (
                        <span className="text-rose-200/70">{inline.value}</span>
                    )}
                </div>
            ) : null}
            {expanded ? <ExpandedView entry={entry} /> : null}
        </div>
    );
}

function getInlinePayload(e: IndexedLogEntry): InlinePayload {
    if (e.vars) {
        return { kind: "json", value: e.vars };
    }
    if (e.data !== undefined && e.data !== null) {
        return { kind: "json", value: e.data };
    }
    if (e.stack) {
        // first stack frame only — full stack is in the expanded view
        const first = String(e.stack).split("\n")[0];
        return first ? { kind: "text", value: first } : null;
    }
    return null;
}

function describeAssert(e: IndexedLogEntry): string {
    if (e.level === "assert") {
        return e.passed ? "passed" : "failed";
    }
    return "";
}

export const EntryRow = memo(EntryRowImpl);
