import type { IndexedLogEntry } from "@app/debugging-master/types";
import { HighlightText } from "@ui/components/highlight-text";
import { memo } from "react";
import { entryHasExpandableContent } from "@/lib/entry-expandable";
import { formatDurationMs, formatTime } from "@/lib/format";
import { LEVEL_META } from "@/lib/levels";
import { visibleLogText } from "@/lib/log-line-display";
import { ExpandedView } from "./ExpandedView";
import { InlineJsonPreview } from "./InlineJsonPreview";
import { LogLineText } from "./LogLineText";

type InlinePayload = { kind: "json"; value: unknown } | { kind: "text"; value: string } | null;

interface Props {
    entry: IndexedLogEntry;
    expanded: boolean;
    fresh: boolean;
    showTimestamp?: boolean;
    highlightTokens?: string[];
    isMatch?: boolean;
    isContext?: boolean;
    onToggle: (index: number) => void;
    onFilterHypothesis?: (h: string) => void;
}

function EntryRowImpl({
    entry,
    expanded,
    fresh,
    showTimestamp = true,
    highlightTokens = [],
    isMatch = false,
    isContext = false,
    onToggle,
    onFilterHypothesis,
}: Props): React.ReactElement {
    const highlighting = highlightTokens.length > 0;
    const previewText = visibleLogText(entry);
    const failed = entry.level === "assert" && entry.passed === false;
    const refMeta = LEVEL_META[entry.level];
    const refId = refMeta.refPrefix ? `${refMeta.refPrefix}${entry.index}` : null;
    const expandable = entryHasExpandableContent(entry);
    const inline: InlinePayload = expandable && !expanded ? getInlinePayload(entry) : null;
    const showLevelChip = !entry.msgAnsi;

    return (
        <div
            className="entry-row"
            data-lvl={entry.level}
            data-failed={failed ? "true" : undefined}
            data-fresh={fresh ? "true" : undefined}
            data-expandable={expandable ? "true" : "false"}
            data-log-index={entry.index}
            data-log-match={isMatch ? "true" : undefined}
            onClick={expandable ? () => onToggle(entry.index) : undefined}
            onKeyDown={
                expandable
                    ? (e) => {
                          if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              onToggle(entry.index);
                          }
                      }
                    : undefined
            }
            role={expandable ? "button" : undefined}
            tabIndex={expandable ? 0 : undefined}
        >
            <div
                className={`dbg-log-line px-3 sm:px-4${isMatch ? " dbg-log-line--match" : ""}${isContext ? " dbg-log-line--context" : ""}`}
            >
                <span className="dbg-log-line__ts" aria-hidden={!showTimestamp}>
                    {showTimestamp ? formatTime(entry.ts) : null}
                </span>
                <div className="dbg-log-line__body flex items-baseline gap-2 min-w-0 flex-wrap">
                    {showLevelChip ? (
                        <span
                            className="lvl-chip shrink-0"
                            data-lvl={entry.level}
                            data-failed={failed ? "true" : undefined}
                            title={LEVEL_META[entry.level].description}
                        >
                            {LEVEL_META[entry.level].label}
                        </span>
                    ) : null}
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
                    <span className={`flex-1 min-w-0 ${entry.msgAnsi && !highlighting ? "" : "truncate-mono"}`}>
                        {highlighting && previewText ? (
                            <HighlightText text={previewText} tokens={highlightTokens} className="text-white/85" />
                        ) : entry.msgAnsi ? (
                            <LogLineText entry={entry} />
                        ) : (
                            <>
                                {entry.label ? <span className="text-amber-200">{entry.label}</span> : null}
                                {entry.label && entry.msg ? <span className="text-white/40"> · </span> : null}
                                {entry.msg ? <span className="text-white/85">{entry.msg}</span> : null}
                            </>
                        )}
                        {!entry.label && !entry.msg && !entry.msgAnsi && !inline ? (
                            <span className="text-white/40">{describeAssert(entry)}</span>
                        ) : null}
                    </span>
                    {entry.durationMs !== undefined ? (
                        <span className="dbg-log-meta text-purple-300 tabular-nums shrink-0">
                            {formatDurationMs(entry.durationMs)}
                        </span>
                    ) : null}
                    {refId ? <span className="dbg-log-meta text-white/45 tabular-nums shrink-0">{refId}</span> : null}
                    {expandable ? (
                        <span className="dbg-log-meta text-white/45 shrink-0">{expanded ? "▾" : "▸"}</span>
                    ) : null}
                </div>
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
            {expanded && expandable ? <ExpandedView entry={entry} /> : null}
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
