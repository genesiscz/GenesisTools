import type { IndexedLogEntry } from "@app/debugging-master/types";
import { HighlightText } from "@ui/components/highlight-text";
import type { ReactElement } from "react";
import { formatTime } from "@/lib/format";
import type { MultiplexLogEntry } from "@/lib/sse";
import { LogLineText } from "./LogLineText";

type PreviewEntry = Pick<IndexedLogEntry, "index" | "ts" | "level" | "msg" | "msgAnsi" | "label"> | MultiplexLogEntry;

interface Props {
    entry: PreviewEntry;
    previewText: string;
    showTimestamp?: boolean;
    highlightTokens?: string[];
    isMatch?: boolean;
    isContext?: boolean;
}

export function LogPreviewLine({
    entry,
    previewText,
    showTimestamp = true,
    highlightTokens = [],
    isMatch = false,
    isContext = false,
}: Props): ReactElement {
    const highlighting = highlightTokens.length > 0;
    const lineClass = [
        "dbg-log-line text-white/80",
        isMatch ? "dbg-log-line--match" : "",
        isContext ? "dbg-log-line--context" : "",
    ]
        .filter(Boolean)
        .join(" ");

    return (
        <div
            className={lineClass}
            title={previewText}
            data-log-index={entry.index}
            data-log-match={isMatch ? "true" : undefined}
        >
            <span className="dbg-log-line__ts" aria-hidden={!showTimestamp}>
                {showTimestamp ? formatTime(entry.ts) : null}
            </span>
            <div className="dbg-log-line__body">
                {highlighting ? (
                    <>
                        {!entry.msgAnsi ? (
                            <span className="dbg-log-meta text-white/30 mr-1.5">[{entry.level}]</span>
                        ) : null}
                        <HighlightText text={previewText} tokens={highlightTokens} className="truncate-mono" />
                    </>
                ) : entry.msgAnsi ? (
                    <LogLineText entry={entry} />
                ) : (
                    <>
                        <span className="dbg-log-meta text-white/30 mr-1.5">[{entry.level}]</span>
                        <span className="truncate-mono">{previewText}</span>
                    </>
                )}
            </div>
        </div>
    );
}
