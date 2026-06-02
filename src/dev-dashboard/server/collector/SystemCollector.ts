import { collectPulse } from "@app/dev-dashboard/lib/system/collector";
import type { PulseSnapshot } from "@app/dev-dashboard/lib/system/types";

export interface SystemCollector {
    readonly platform: "macos" | "linux" | "windows";
    collect(): Promise<PulseSnapshot>;
}

export class MacSystemCollector implements SystemCollector {
    readonly platform = "macos" as const;

    collect(): Promise<PulseSnapshot> {
        return collectPulse();
    }
}

export function defaultSystemCollector(): SystemCollector {
    // Product roadmap: branch on process.platform for linux/windows collectors.
    return new MacSystemCollector();
}
