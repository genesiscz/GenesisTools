import { batteryView } from "./battery-view";
import { brewView } from "./brew-view";
import { devCachesView } from "./dev-caches-view";
import { diskSpaceView } from "./disk-space-view";
import { genericView } from "./generic-view";
import { memoryView } from "./memory-view";
import { networkView } from "./network-view";
import { processesView } from "./processes-view";
import { securityView } from "./security-view";
import { startupView } from "./startup-view";
import { systemCachesView } from "./system-caches-view";
import type { ViewFn } from "./types";

const registry: Record<string, ViewFn> = {
    battery: batteryView,
    brew: brewView,
    "dev-caches": devCachesView,
    "disk-space": diskSpaceView,
    memory: memoryView,
    network: networkView,
    processes: processesView,
    security: securityView,
    startup: startupView,
    "system-caches": systemCachesView,
};

export function viewForAnalyzer(id: string): ViewFn {
    return registry[id] ?? genericView;
}
