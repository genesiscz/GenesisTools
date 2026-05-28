import type { ReactElement } from "react";
import type { IndexedLogEntry } from "@app/debugging-master/types";
import { AnsiLogText } from "@app/utils/ansi/render-ansi.client";

interface Props {
    entry: Pick<IndexedLogEntry, "msg" | "msgAnsi" | "level" | "label">;
    className?: string;
    showStreamLabel?: boolean;
}

export function LogLineText({ entry, className = "", showStreamLabel = false }: Props): ReactElement {
    if (entry.msgAnsi) {
        return <AnsiLogText text={entry.msgAnsi} className={className} />;
    }

    return (
        <span className={className}>
            {showStreamLabel && entry.label ? (
                <>
                    <span className="text-amber-200">{entry.label}</span>
                    {entry.msg ? <span className="text-white/40"> · </span> : null}
                </>
            ) : null}
            {entry.msg ? <span className="text-white/85">{entry.msg}</span> : null}
        </span>
    );
}
