import { describe, expect, test } from "bun:test";
import type { FSWatcher } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeFileWatcher, getFileWatcherCount, setFileWatcher } from "./file-watchers";

describe("tools watch fs.watch cleanup", () => {
    test("replaces the previous per-file watcher when set again for the same path", () => {
        let closeCount = 0;
        const first = { close: () => closeCount++ } as unknown as FSWatcher;
        const second = { close: () => closeCount++ } as unknown as FSWatcher;
        const path = join(tmpdir(), "watch-test-file");

        setFileWatcher(path, first);
        expect(getFileWatcherCount(path)).toBe(1);

        setFileWatcher(path, second);
        expect(closeCount).toBe(1);
        expect(getFileWatcherCount(path)).toBe(1);

        closeFileWatcher(path);
        expect(getFileWatcherCount(path)).toBe(0);
    });
});
