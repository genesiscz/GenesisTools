import type { LogEntry } from "@app/daemon/lib/types";
import type { LogLineClass } from "@app/dev-dashboard/lib/daemon-view/classify";

/** A daemon LogEntry the SSE tail has tagged with its classification (wire shape of each `data:`). */
export type ClassifiedLogEntry = LogEntry & { cls: LogLineClass };
