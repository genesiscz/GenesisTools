import type { IndexedLogEntry } from "@app/debugging-master/types";
import { BlinkingBox } from "@ui/components/BlinkingBox";
import { HighlightText } from "@ui/components/highlight-text";
import { Tooltip, TooltipContent, TooltipTrigger } from "@ui/components/tooltip";
import { memo } from "react";
import { entryHasExpandableContent } from "@/lib/entry-expandable";
import { formatDurationMs, formatTime } from "@/lib/format";
import { LEVEL_META } from "@/lib/levels";
import { visibleLogText } from "@/lib/log-line-display";
import { formatLogLineIndex } from "@/lib/log-line-index";
import { ExpandedView } from "./ExpandedView";
import { InlineJsonPreview } from "./InlineJsonPreview";
import { LevelTooltip } from "./LevelTooltip";
import { LogLineIndexButton } from "./LogLineIndexButton";
import { useLogLineJump } from "./LogLineJumpProvider";
import { LogLineText } from "./LogLineText";

type InlinePayload = { kind: "json"; value: unknown } | { kind: "text"; value: string } | null;

interface Props {
    entry: IndexedLogEntry;
    expanded: boolean;
    fresh: boolean;
    showTimestamp?: boolean;
    showLineId?: boolean;
    jumpEnabled?: boolean;
    highlightTokens?: string[];
    isMatch?: boolean;
    isContext?: boolean;
    fullJsonContext?: boolean;
    onToggle: (index: number) => void;
    onFilterHypothesis?: (h: string) => void;
}

function EntryRowImpl({
    entry,
    expanded,
    fresh,
    showTimestamp = true,
    showLineId = true,
    jumpEnabled = false,
    highlightTokens = [],
    isMatch = false,
    isContext = false,
    fullJsonContext = false,
    onToggle,
    onFilterHypothesis,
}: Props): React.ReactElement {
    const { jumpTargetIndex, jumpToLine, clearJump } = useLogLineJump();
    const highlighting = highlightTokens.length > 0;
    const previewText = visibleLogText(entry);
    const failed = entry.level === "assert" && entry.passed === false;
    const lineIndexLabel = formatLogLineIndex(entry.index);
    const isJumpTarget = jumpTargetIndex === entry.index;
    const expandable = entryHasExpandableContent(entry);
    const inline: InlinePayload = expandable && !expanded ? getInlinePayload(entry) : null;
    const showLevelChip = !entry.msgAnsi;

    const handleToggle = () => {
        const selection = window.getSelection();

        if (selection && selection.type === "Range" && selection.toString().length > 0) {
            return;
        }

        onToggle(entry.index);
    };

    return (
        <div
            className="entry-row"
            data-lvl={entry.level}
            data-failed={failed ? "true" : undefined}
            data-fresh={fresh ? "true" : undefined}
            data-expandable={expandable ? "true" : "false"}
            data-log-index={entry.index}
            data-log-match={isMatch ? "true" : undefined}
            onClick={expandable ? handleToggle : undefined}
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
            <BlinkingBox
                active={isJumpTarget}
                variant="amber-inset"
                className={`dbg-log-line px-3 sm:px-4${isMatch ? " dbg-log-line--match" : ""}${isContext ? " dbg-log-line--context" : ""}`}
            >
                <span className="dbg-log-line__ts" aria-hidden={!showTimestamp && !showLineId}>
                    {showTimestamp ? <span className="tabular-nums">{formatTime(entry.ts)}</span> : null}
                    {showLineId ? (
                        <LogLineIndexButton
                            index={entry.index}
                            isJumpTarget={isJumpTarget}
                            onJump={jumpToLine}
                            onClearJump={clearJump}
                            disabled={!jumpEnabled}
                        />
                    ) : null}
                </span>
                <div className="dbg-log-line__body flex items-baseline gap-2 min-w-0 flex-wrap">
                    {showLevelChip ? (
                        <LevelTooltip level={entry.level}>
                            <span
                                className="lvl-chip shrink-0"
                                data-lvl={entry.level}
                                data-failed={failed ? "true" : undefined}
                            >
                                {LEVEL_META[entry.level].label}
                            </span>
                        </LevelTooltip>
                    ) : null}
                    {entry.h ? (
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <button
                                    type="button"
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        onFilterHypothesis?.(entry.h!);
                                    }}
                                    className="h-chip"
                                >
                                    h:{entry.h}
                                </button>
                            </TooltipTrigger>
                            <TooltipContent>{`filter by hypothesis: ${entry.h}`}</TooltipContent>
                        </Tooltip>
                    ) : null}
                    <span className={`flex-1 min-w-0 dbg-log-wrap ${entry.msgAnsi && !highlighting ? "" : ""}`}>
                        {highlighting && previewText ? (
                            <HighlightText text={previewText} tokens={highlightTokens} className="text-white/85" />
                        ) : entry.msgAnsi ? (
                            <LogLineText entry={entry} className="dbg-log-wrap" />
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
                    <span className="dbg-log-meta text-white/45 tabular-nums shrink-0">{lineIndexLabel}</span>
                    {expandable ? (
                        <span className="dbg-log-meta text-white/45 shrink-0">{expanded ? "▾" : "▸"}</span>
                    ) : null}
                </div>
            </BlinkingBox>
            {inline ? (
                <div
                    className={`json-tree px-3 sm:px-4 pb-1.5 pl-[5.5rem] sm:pl-[6.5rem] text-[11px] select-text${fullJsonContext ? " dbg-json-inline-full" : " truncate-mono"}`}
                    onClick={(event) => {
                        event.stopPropagation();
                    }}
                >
                    {inline.kind === "json" ? (
                        <InlineJsonPreview value={inline.value} maxChars={200} unlimited={fullJsonContext} />
                    ) : (
                        <span className="text-rose-200/70">{inline.value}</span>
                    )}
                </div>
            ) : null}
            {expanded && expandable ? (
                <div
                    onClick={(event) => {
                        event.stopPropagation();
                    }}
                >
                    <ExpandedView entry={entry} />
                </div>
            ) : null}
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
