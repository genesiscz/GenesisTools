import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deletePreset, listPresets, savePreset } from "@app/dev-dashboard/lib/tmux/presets";
import { setTmuxBinForTests } from "@app/utils/tmux/bin";
import { setTmuxSnapshotSpawnForTests, type TmuxPreset } from "@app/utils/tmux/snapshot";
import { TmuxPresetStore } from "@app/utils/tmux/snapshot-store";

// Two sessions: "alpha" has 1 window with 2 panes, "beta" has 2 windows with 1 pane each.
// Columns (PANE_LIST_FORMAT order): session window_idx window_name pane_idx cwd cmd session_path attached
const LIST_PANES_PAYLOAD = [
    ["alpha", "0", "edit", "0", "/work/alpha", "vim", "/work/alpha", "1"],
    ["alpha", "0", "edit", "1", "/work/alpha", "zsh", "/work/alpha", "1"],
    ["beta", "0", "logs", "0", "/work/beta", "tail", "/work/beta", "0"],
    ["beta", "1", "build", "0", "/work/beta", "bun", "/work/beta", "0"],
]
    .map((row) => row.join("\t"))
    .join("\n");

function makeSpawn(listPanesStdout: string) {
    return (cmd: string[]) => {
        if (cmd.includes("list-panes")) {
            return { exitCode: 0, stdout: listPanesStdout, stderr: "" };
        }

        // capture-pane (last-command parse) → empty so lastShellCommand stays undefined.
        return { exitCode: 0, stdout: "", stderr: "" };
    };
}

describe("dev-dashboard tmux presets lib", () => {
    let store: TmuxPresetStore;

    beforeEach(() => {
        store = new TmuxPresetStore({ dir: mkdtempSync(join(tmpdir(), "dd-presets-")) });
        setTmuxBinForTests("/usr/bin/tmux");
        setTmuxSnapshotSpawnForTests(makeSpawn(LIST_PANES_PAYLOAD));
    });

    afterEach(() => {
        setTmuxSnapshotSpawnForTests(null);
        setTmuxBinForTests(null);
    });

    it("captures + saves a preset with the exact session/window/pane counts", () => {
        const summary = savePreset({ name: "dev", note: "morning" }, store);

        expect(summary.name).toBe("dev");
        expect(summary.note).toBe("morning");
        expect(summary.sessions).toBe(2); // alpha + beta
        expect(summary.windows).toBe(3); // alpha:1 + beta:2
        expect(summary.panes).toBe(4); // alpha:2 + beta:1 + beta:1
        expect(summary.bytes).toBeGreaterThan(0);
    });

    it("lists saved presets", () => {
        savePreset({ name: "dev" }, store);
        const list = listPresets(store);

        expect(list).toHaveLength(1);
        expect(list[0]?.name).toBe("dev");
    });

    it("throws when no tmux sessions are captured", () => {
        setTmuxSnapshotSpawnForTests(makeSpawn(""));

        expect(() => savePreset({ name: "empty" }, store)).toThrow(/No tmux sessions to capture/);
    });

    it("deletes a preset and the list shrinks", () => {
        savePreset({ name: "dev" }, store);
        expect(deletePreset("dev", store)).toEqual({ removed: true });
        expect(listPresets(store)).toHaveLength(0);
    });

    it("re-saving the same name overwrites (force) without throwing", () => {
        savePreset({ name: "dev" }, store);
        // Second capture: only "alpha" (1 window, 2 panes).
        setTmuxSnapshotSpawnForTests(makeSpawn(LIST_PANES_PAYLOAD.split("\n").slice(0, 2).join("\n")));
        const second = savePreset({ name: "dev" }, store);

        expect(second.sessions).toBe(1);
        expect(second.windows).toBe(1);
        expect(second.panes).toBe(2);
        expect(listPresets(store)).toHaveLength(1);
    });

    it("summarize() counts windows/panes from a hand-built preset (bytes:0 unwritten)", () => {
        const preset: TmuxPreset = {
            version: 1,
            name: "manual",
            capturedAt: new Date().toISOString(),
            note: undefined,
            sessions: [
                {
                    name: "s1",
                    cwd: "/a",
                    attached: false,
                    windows: [
                        {
                            index: 0,
                            name: "w0",
                            panes: [{ index: 0, cwd: "/a", currentCommand: "zsh", lastShellCommand: undefined }],
                        },
                        {
                            index: 1,
                            name: "w1",
                            panes: [
                                { index: 0, cwd: "/a", currentCommand: "vim", lastShellCommand: undefined },
                                { index: 1, cwd: "/a", currentCommand: "tail", lastShellCommand: undefined },
                            ],
                        },
                    ],
                },
                {
                    name: "s2",
                    cwd: "/b",
                    attached: true,
                    windows: [
                        {
                            index: 0,
                            name: "w0",
                            panes: [{ index: 0, cwd: "/b", currentCommand: "bun", lastShellCommand: undefined }],
                        },
                    ],
                },
            ],
        };

        const summary = store.summarize(preset);

        expect(summary.sessions).toBe(2);
        expect(summary.windows).toBe(3); // s1:2 + s2:1
        expect(summary.panes).toBe(4); // s1:1 + s1:2 + s2:1
        expect(summary.bytes).toBe(0); // not written to disk
    });
});
