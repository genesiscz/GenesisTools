import { join } from "node:path";
import { Storage } from "@app/utils/storage/storage";

const TOOL_NAME = "say";

/**
 * Per-tool storage wrapper for `tools say`. Centralizes config and cache
 * directory layout under `~/.genesis-tools/say/` so callers don't have to
 * reach into the generic `Storage` class with the tool name string.
 */
export class SayStorage extends Storage {
    constructor() {
        super(TOOL_NAME);
    }

    /** Audio cache directory: `~/.genesis-tools/say/cache/`. */
    getCacheDir(): string {
        return join(this.getBaseDir(), "cache");
    }
}

let _instance: SayStorage | null = null;

export function getSayStorage(): SayStorage {
    if (!_instance) {
        _instance = new SayStorage();
    }

    return _instance;
}
