import { describe, expect, test, afterEach } from "bun:test";
import { resetTmuxBinCache, setTmuxBinForTests } from "@app/utils/tmux/bin";
import { listTmuxSessions, sessionExists, setTmuxSpawnSyncForTests } from "@app/utils/tmux/sessions";

describe("tmux sessions", () => {
    afterEach(() => {
        setTmuxSpawnSyncForTests(null);
        setTmuxBinForTests(null);
        resetTmuxBinCache();
    });

    test("listTmuxSessions parses tmux list-sessions output", () => {
        setTmuxBinForTests("/mock/tmux");
        setTmuxSpawnSyncForTests((cmd) => {
            if (cmd.includes("list-sessions")) {
                return {
                    exitCode: 0,
                    stdout: "dev-dashboard-abc12345\t1\t2\ncmux-test\t0\t1\n",
                };
            }

            return { exitCode: 0, stdout: "" };
        });

        expect(listTmuxSessions()).toEqual([
            { name: "dev-dashboard-abc12345", attached: 1, windows: 2 },
            { name: "cmux-test", attached: 0, windows: 1 },
        ]);
    });

    test("listTmuxSessions returns empty when tmux fails", () => {
        setTmuxBinForTests("/mock/tmux");
        setTmuxSpawnSyncForTests(() => ({ exitCode: 1, stdout: "" }));
        expect(listTmuxSessions()).toEqual([]);
    });

    test("sessionExists checks parsed list", () => {
        setTmuxBinForTests("/mock/tmux");
        setTmuxSpawnSyncForTests((cmd) => {
            if (cmd.includes("list-sessions")) {
                return { exitCode: 0, stdout: "foo\t0\t1\n" };
            }

            return { exitCode: 0, stdout: "" };
        });

        expect(sessionExists("foo")).toBe(true);
        expect(sessionExists("missing")).toBe(false);
    });
});
