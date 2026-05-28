import { describe, expect, test, afterEach } from "bun:test";
import { resetTmuxBinCache, setTmuxBinForTests } from "@app/utils/tmux/bin";
import { buildTmuxSpawnEnv, listTmuxSessions, renameTmuxSession, sessionExists, setTmuxSpawnSyncForTests } from "@app/utils/tmux/sessions";

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

    test("buildTmuxSpawnEnv sets UTF-8 locale when LANG unset", () => {
        const saved = {
            LANG: process.env.LANG,
            LC_ALL: process.env.LC_ALL,
            LC_CTYPE: process.env.LC_CTYPE,
        };

        delete process.env.LANG;
        delete process.env.LC_ALL;
        delete process.env.LC_CTYPE;

        try {
            expect(buildTmuxSpawnEnv().LANG).toMatch(/UTF-8/i);
            expect(buildTmuxSpawnEnv().LC_ALL).toBe(buildTmuxSpawnEnv().LANG);
        } finally {
            if (saved.LANG === undefined) {
                delete process.env.LANG;
            } else {
                process.env.LANG = saved.LANG;
            }

            if (saved.LC_ALL === undefined) {
                delete process.env.LC_ALL;
            } else {
                process.env.LC_ALL = saved.LC_ALL;
            }

            if (saved.LC_CTYPE === undefined) {
                delete process.env.LC_CTYPE;
            } else {
                process.env.LC_CTYPE = saved.LC_CTYPE;
            }
        }
    });

    test("renameTmuxSession calls tmux rename-session", () => {
        setTmuxBinForTests("/mock/tmux");
        const calls: string[][] = [];
        setTmuxSpawnSyncForTests((cmd) => {
            calls.push(cmd);

            if (cmd.includes("list-sessions")) {
                return { exitCode: 0, stdout: "foo\t1\t1\n" };
            }

            return { exitCode: 0, stdout: "" };
        });

        renameTmuxSession("foo", "bar");

        expect(calls.some((cmd) => cmd.includes("rename-session") && cmd.includes("bar"))).toBe(true);
    });
});
