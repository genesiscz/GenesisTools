import { existsSync } from "node:fs";
import { preserveUnreadableFile } from "@genesiscz/utils/storage/atomic-file";

/**
 * Usage files (the client ledger, the daily and billing stores) that this process loaded as empty defaults
 * because they existed but could not be read or parsed, with the reason. The loaders cannot refuse: the
 * proxy must keep serving and booking. So the file is copied aside here, right before the first write that
 * would replace it, and a reader that only displays or checks a quota never creates a copy.
 */
const unreadableFiles = new Map<string, unknown>();

export function noteUnreadableUsageFile(path: string, reason: unknown): void {
    unreadableFiles.set(path, reason);
}

/**
 * Copy a file noted as unreadable to `<path>.corrupt-<time>` once, before it is replaced. Throws when the
 * copy fails, and the caller must then not write: the file is still the only copy of what it booked.
 */
export function preserveBeforeReplacing(path: string): void {
    if (!unreadableFiles.has(path)) {
        return;
    }

    if (existsSync(path)) {
        preserveUnreadableFile(path, unreadableFiles.get(path));
    }

    unreadableFiles.delete(path);
}
