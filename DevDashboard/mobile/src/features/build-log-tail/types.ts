import type { ClassifiedLogEntry, LogLineClass } from "@dd/contract";

export type { LogLineClass };

/** Flattened, render-ready log line for the LogStream FlatList. */
export interface ClassifiedLine {
    /** Stable position in the merged (backlog ++ live) list — drives the row testID. */
    index: number;
    cls: LogLineClass;
    /** The one-line display string (see lineText). */
    text: string;
    entry: ClassifiedLogEntry;
}
