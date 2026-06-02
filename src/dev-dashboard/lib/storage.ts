import { Storage } from "@app/utils/storage/storage";

const TOOL_NAME = "dev-dashboard";

/**
 * Per-tool storage wrapper for the dev dashboard. Centralizes the
 * `~/.genesis-tools/dev-dashboard/` config and cache layout so callers don't
 * reach into the generic `Storage` class with the tool-name string.
 */
export class DevDashboardStorage extends Storage {
    constructor() {
        super(TOOL_NAME);
    }
}

let _instance: DevDashboardStorage | null = null;

export function getDevDashboardStorage(): DevDashboardStorage {
    if (!_instance) {
        _instance = new DevDashboardStorage();
    }

    return _instance;
}

/** Drop the memoized singleton so the next `getDevDashboardStorage()` re-reads
 * `GENESIS_TOOLS_HOME`. Test-only — production never changes the storage root
 * mid-process. */
export function resetDevDashboardStorage(): void {
    _instance = null;
}
