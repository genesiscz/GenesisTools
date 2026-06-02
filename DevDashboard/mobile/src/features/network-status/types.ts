import type { NetQuality, NetStatus, NetTransport } from "@dd/contract";
import type { PillTone } from "@/ui/StatusPill";

export type { NetQuality, NetStatus, NetTransport };

/** Quality → the StatusPill tone used to render it. */
export type QualityTone = PillTone;
