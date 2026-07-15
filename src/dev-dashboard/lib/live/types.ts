import type { BoardEventDto } from "@app/dev-dashboard/lib/boards/types";
import type { ClassifiedLogEntry } from "@app/dev-dashboard/lib/daemon-view/classify-types";
import type { PortInfo, PortsResult } from "@app/dev-dashboard/lib/ports/types";
import type { EnrichedQaEntry } from "@app/dev-dashboard/lib/qa-types";
import type { PulseSnapshot } from "@app/dev-dashboard/lib/system/types";

export type LiveChannel = "ports" | "pulse" | "qa" | `boards:${string}` | `daemon:${string}`;

export type LiveFrame =
    | { v: 1; channel: "system"; type: "hello"; payload: { connId: string; channels: LiveChannel[] } }
    | { v: 1; channel: "system"; type: "subscribed"; payload: { channels: LiveChannel[] } }
    | { v: 1; channel: "system"; type: "error"; payload: { message: string } }
    | { v: 1; channel: "ports"; type: "snapshot"; payload: PortsResult }
    | { v: 1; channel: "ports"; type: "classify"; payload: { ports: PortInfo[] } }
    | { v: 1; channel: "pulse"; type: "snapshot"; payload: PulseSnapshot }
    | { v: 1; channel: "qa"; type: "entry"; payload: EnrichedQaEntry }
    | { v: 1; channel: `boards:${string}`; type: "event"; payload: BoardEventDto }
    | { v: 1; channel: `daemon:${string}`; type: "log"; payload: ClassifiedLogEntry };

export interface LiveSubscribeBody {
    connId: string;
    /** Full replacement set. */
    channels: LiveChannel[];
}
