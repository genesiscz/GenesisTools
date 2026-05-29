import type { IndexedLogEntry } from "@app/debugging-master/types";
import type { ReactElement } from "react";
import { formatTime } from "@/lib/format";
import type { MultiplexLogEntry } from "@/lib/sse";
import { LogLineText } from "./LogLineText";

type PreviewEntry = Pick<IndexedLogEntry, "index" | "ts" | "level" | "msg" | "msgAnsi" | "label"> | MultiplexLogEntry;

interface Props {
    entry: PreviewEntry;
    previewText: string;
    showTimestamp?: boolean;
}

export function LogPreviewLine({ entry, previewText, showTimestamp = true }: Props): ReactElement {
    return (
        <div className="dbg-log-line text-white/80" title={previewText}>
            <span className="dbg-log-line__ts" aria-hidden={!showTimestamp}>
                {showTimestamp ? formatTime(entry.ts) : null}
            </span>
            <div className="dbg-log-line__body">
                {entry.msgAnsi ? (
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
