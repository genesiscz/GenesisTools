import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { editorOpenStatePath, readEditorOpenState, resolveRecording } from "./library";

function writeState(state: Record<string, unknown>): void {
    mkdirSync(dirname(editorOpenStatePath()), { recursive: true });
    writeFileSync(
        editorOpenStatePath(),
        SafeJSON.stringify({ version: 1, updatedAt: "2026-11-04T10:00:00.000Z", ...state })
    );
}

const first = { path: "/tmp/recordings/first", title: "First" };
const second = { path: "/tmp/recordings/second", title: "Second" };

describe("the recording open in the editor", () => {
    afterEach(() => writeState({ open: [] }));

    it("names the window last in front", () => {
        writeState({ pid: process.pid, open: [first, second], front: second });

        expect(resolveRecording("open")).toBe(second.path);
    });

    it("takes the only open window when none came to the front", () => {
        writeState({ pid: process.pid, open: [first] });

        expect(resolveRecording("open")).toBe(first.path);
    });

    it("refuses with the library command when several windows are open and none is in front", () => {
        writeState({ pid: process.pid, open: [first, second] });

        expect(() => resolveRecording("open")).toThrow("tools recorder library");
    });

    it("drops the windows of an editor process that is gone", () => {
        writeState({ pid: 2_147_483_000, open: [first], front: first });

        expect(readEditorOpenState()?.open).toEqual([]);
        expect(() => resolveRecording("open")).toThrow("No recording is open");
    });
});
