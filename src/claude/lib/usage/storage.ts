import { Storage } from "@app/utils/storage/storage";

const TOOL_NAME = "claude-usage";

/**
 * Per-tool storage wrapper for Claude usage tracking. Centralizes the
 * `~/.genesis-tools/claude-usage/` config and cache layout so callers don't
 * reach into the generic `Storage` class with the tool-name string.
 */
export class ClaudeUsageStorage extends Storage {
    constructor() {
        super(TOOL_NAME);
    }
}

let _instance: ClaudeUsageStorage | null = null;

export function getClaudeUsageStorage(): ClaudeUsageStorage {
    if (!_instance) {
        _instance = new ClaudeUsageStorage();
    }

    return _instance;
}
