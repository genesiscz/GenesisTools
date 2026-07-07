import type { IndexedLogEntry } from "@app/debugging-master/types";
import { BlinkingBox } from "@ui/components/BlinkingBox";
import { HighlightText } from "@ui/components/highlight-text";
import { Tooltip, TooltipContent, TooltipTrigger } from "@ui/components/tooltip";
import type { ReactElement } from "react";
import { formatTime } from "@/lib/format";
import { formatLogLineIndex, LOG_LINE_JUMP_HOVER_TOOLTIP } from "@/lib/log-line-index";
import type { MultiplexLogEntry } from "@/lib/sse";
import { LogLineIndexButton } from "./LogLineIndexButton";
import { useLogLineJump } from "./LogLineJumpProvider";
import { LogLineText } from "./LogLineText";

type PreviewEntry = Pick<IndexedLogEntry, "index" | "ts" | "level" | "msg" | "msgAnsi" | "label"> | MultiplexLogEntry;

interface Props {
    entry: PreviewEntry;
    previewText: string;
    showTimestamp?: boolean;
    showLineId?: boolean;
    lineIdPresentation?: "settings" | "hover-rail";
    jumpEnabled?: boolean;
    highlightTokens?: string[];
    isMatch?: boolean;
    isContext?: boolean;
}

export function LogPreviewLine({
    entry,
    previewText,
    showTimestamp = true,
    showLineId = true,
    lineIdPresentation = "settings",
    jumpEnabled = false,
    highlightTokens = [],
    isMatch = false,
    isContext = false,
}: Props): ReactElement {
    const { jumpTargetIndex, jumpToLine, clearJump } = useLogLineJump();
    const highlighting = highlightTokens.length > 0;
    const isJumpTarget = jumpTargetIndex === entry.index;
    const hoverRail = lineIdPresentation === "hover-rail";
    const lineClass = [
        "dbg-log-line text-white/80",
        hoverRail ? "group" : "",
        isMatch ? "dbg-log-line--match" : "",
        isContext ? "dbg-log-line--context" : "",
    ]
        .filter(Boolean)
        .join(" ");

    const lineIndexRail = (
        <span
            className={`dbg-log-line__id-rail shrink-0 tabular-nums transition-opacity ${
                isJumpTarget ? "opacity-100" : "opacity-0 group-hover:opacity-100"
            }`}
            data-active={isJumpTarget ? "true" : undefined}
        >
            {jumpEnabled ? (
                <LogLineIndexButton
                    index={entry.index}
                    isJumpTarget={isJumpTarget}
                    onJump={jumpToLine}
                    onClearJump={clearJump}
                    compact
                    tooltip={LOG_LINE_JUMP_HOVER_TOOLTIP}
                />
            ) : (
                <span className="dbg-log-meta text-white/30 px-0.5">{formatLogLineIndex(entry.index)}</span>
            )}
        </span>
    );

    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <BlinkingBox
                    active={isJumpTarget}
                    variant="amber-inset"
                    className={lineClass}
                    data-log-index={entry.index}
                    data-log-match={isMatch ? "true" : undefined}
                >
                    <span className="dbg-log-line__ts" aria-hidden={!showTimestamp && !(showLineId && !hoverRail)}>
                        {showTimestamp ? <span className="tabular-nums">{formatTime(entry.ts)}</span> : null}
                        {showLineId && !hoverRail ? (
                            <LogLineIndexButton
                                index={entry.index}
                                isJumpTarget={isJumpTarget}
                                onJump={jumpToLine}
                                onClearJump={clearJump}
                                disabled={!jumpEnabled}
                            />
                        ) : null}
                    </span>
                    <div className="dbg-log-line__body flex items-start gap-2 min-w-0">
                        <span className="flex-1 min-w-0 dbg-log-wrap">
                            {highlighting ? (
                                <>
                                    {!entry.msgAnsi ? (
                                        <span className="dbg-log-meta text-white/30 mr-1.5">[{entry.level}]</span>
                                    ) : null}
                                    <HighlightText
                                        text={previewText}
                                        tokens={highlightTokens}
                                        className="text-white/85"
                                    />
                                </>
                            ) : entry.msgAnsi ? (
                                <LogLineText entry={entry} className="dbg-log-wrap" />
                            ) : (
                                <>
                                    <span className="dbg-log-meta text-white/30 mr-1.5">[{entry.level}]</span>
                                    <span>{previewText}</span>
                                </>
                            )}
                        </span>
                        {hoverRail ? (
                            lineIndexRail
                        ) : (
                            <span className="dbg-log-meta text-white/45 tabular-nums shrink-0">
                                {formatLogLineIndex(entry.index)}
                            </span>
                        )}
                    </div>
                </BlinkingBox>
            </TooltipTrigger>
            <TooltipContent className="max-w-lg break-all">{previewText}</TooltipContent>
        </Tooltip>
    );
}
