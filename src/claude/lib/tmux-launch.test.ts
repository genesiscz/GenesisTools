import { afterEach, describe, expect, test } from "bun:test";
import { resetTmuxBinCache, setTmuxBinForTests } from "@genesiscz/utils/tmux/bin";
import { setTmuxSpawnSyncForTests } from "@genesiscz/utils/tmux/sessions";
import { renameTargetForCurrentSession, tmuxNameFromResumeTitle } from "./tmux-launch";

describe("tmuxNameFromResumeTitle", () => {
    test("sanitizes a resume title for tmux", () => {
        expect(tmuxNameFromResumeTitle("Fix v1.2 bug", "claude")).toBe("Fix v1-2 bug");
    });

    test("falls back when the title is empty", () => {
        expect(tmuxNameFromResumeTitle("  ", "claude-work")).toBe("claude-work");
        expect(tmuxNameFromResumeTitle(undefined, "claude-work")).toBe("claude-work");
    });
});

describe("renameTargetForCurrentSession", () => {
    afterEach(() => {
        setTmuxSpawnSyncForTests(null);
        setTmuxBinForTests(null);
        resetTmuxBinCache();
    });

    test("keeps the current name when it already matches", async () => {
        expect(await renameTargetForCurrentSession("claude-work", "claude-work")).toBe("claude-work");
    });

    test("suffixes -2 when the desired name is taken by another session", async () => {
        setTmuxBinForTests("/mock/tmux");
        setTmuxSpawnSyncForTests((cmd) => {
            if (cmd.includes("list-sessions")) {
                return {
                    exitCode: 0,
                    stdout: `\x1e${["taken", "1", "1", "claude", "/tmp", "1", "1", "t"].join("\x1f")}\n`,
                };
            }

            return { exitCode: 0, stdout: "" };
        });

        expect(await renameTargetForCurrentSession("current", "taken")).toBe("taken-2");
    });
});
