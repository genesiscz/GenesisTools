import type { FSWatcher } from "node:fs";

const fileWatchers = new Map<string, FSWatcher>();

export function setFileWatcher(filePath: string, watcher: FSWatcher): void {
    fileWatchers.get(filePath)?.close();
    fileWatchers.set(filePath, watcher);
}

export function closeFileWatcher(filePath: string): void {
    fileWatchers.get(filePath)?.close();
    fileWatchers.delete(filePath);
}

export function closeAllFileWatchers(): void {
    for (const watcher of fileWatchers.values()) {
        watcher.close();
    }
    fileWatchers.clear();
}

/** @internal test-only */
export function getFileWatcherCount(filePath: string): number {
    return fileWatchers.has(filePath) ? 1 : 0;
}
