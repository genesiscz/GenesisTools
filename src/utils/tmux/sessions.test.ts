import { afterEach, describe, expect, test } from "bun:test";
import { env } from "@app/utils/env";
import { resetTmuxBinCache, setTmuxBinForTests } from "@app/utils/tmux/bin";
import {
    buildTmuxSpawnEnv,
    createTmuxSession,
    getTmuxScrollState,
    listTmuxSessionCommands,
    listTmuxSessions,
    renameTmuxSession,
    scrollTmuxToFraction,
    sessionExists,
    setTmuxSpawnSyncForTests,
} from "@app/utils/tmux/sessions";

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

    test("listTmuxSessionCommands maps session name to its active pane command", () => {
        setTmuxBinForTests("/mock/tmux");
        setTmuxSpawnSyncForTests((cmd) => {
            if (cmd.includes("list-sessions")) {
                return { exitCode: 0, stdout: "dev-dashboard-abc12345\tclaude\ncmux-test\tzsh\nblank-cmd\t\n" };
            }

            return { exitCode: 0, stdout: "" };
        });

        const commands = listTmuxSessionCommands();
        expect(commands.get("dev-dashboard-abc12345")).toBe("claude");
        expect(commands.get("cmux-test")).toBe("zsh");
        // A blank command is skipped (no entry), not stored as "".
        expect(commands.has("blank-cmd")).toBe(false);
    });

    test("listTmuxSessionCommands returns empty when tmux fails", () => {
        setTmuxBinForTests("/mock/tmux");
        setTmuxSpawnSyncForTests(() => ({ exitCode: 1, stdout: "" }));
        expect(listTmuxSessionCommands().size).toBe(0);
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
            LANG: env.locale.getLang(),
            LC_ALL: env.locale.getLcAll(),
            LC_CTYPE: env.locale.getLcCtype(),
        };

        env.testing.unset("LANG");
        env.testing.unset("LC_ALL");
        env.testing.unset("LC_CTYPE");

        try {
            expect(buildTmuxSpawnEnv().LANG).toMatch(/UTF-8/i);
            expect(buildTmuxSpawnEnv().LC_ALL).toBe(buildTmuxSpawnEnv().LANG);
        } finally {
            if (saved.LANG === undefined) {
                env.testing.unset("LANG");
            } else {
                env.testing.set("LANG", saved.LANG);
            }

            if (saved.LC_ALL === undefined) {
                env.testing.unset("LC_ALL");
            } else {
                env.testing.set("LC_ALL", saved.LC_ALL);
            }

            if (saved.LC_CTYPE === undefined) {
                env.testing.unset("LC_CTYPE");
            } else {
                env.testing.set("LC_CTYPE", saved.LC_CTYPE);
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

    test("createTmuxSession pins exit-empty off so the server keeps sessions across teardown", () => {
        setTmuxBinForTests("/mock/tmux");
        const calls: string[][] = [];
        setTmuxSpawnSyncForTests((cmd) => {
            calls.push(cmd);
            return { exitCode: 0, stdout: "" };
        });

        createTmuxSession("foo", "/tmp", "/bin/zsh");

        expect(calls.some((cmd) => cmd.includes("new-session") && cmd.includes("foo"))).toBe(true);
        expect(calls.some((cmd) => cmd.includes("new-session") && cmd.includes("--"))).toBe(true);
        expect(calls.some((cmd) => cmd.includes("new-session") && cmd.includes("/usr/bin/env"))).toBe(true);
        expect(calls.some((cmd) => cmd.includes("new-session") && cmd.includes("COLORTERM=truecolor"))).toBe(true);
        expect(
            calls.some((cmd) => cmd.includes("set-option") && cmd.includes("exit-empty") && cmd.includes("off"))
        ).toBe(true);
        expect(
            calls.some(
                (cmd) =>
                    cmd.includes("set-environment") &&
                    cmd.includes("foo") &&
                    cmd.includes("CLAUDE_CODE_TMUX_TRUECOLOR") &&
                    cmd.includes("1")
            )
        ).toBe(true);
        expect(
            calls.some(
                (cmd) =>
                    cmd.includes("set-environment") &&
                    cmd.includes("foo") &&
                    cmd.includes("COLORTERM") &&
                    cmd.includes("truecolor")
            )
        ).toBe(true);
    });

    test("getTmuxScrollState parses display-message output", () => {
        setTmuxBinForTests("/mock/tmux");
        setTmuxSpawnSyncForTests((cmd) => {
            if (cmd.includes("display-message")) {
                return { exitCode: 0, stdout: "979|24|100|1|1\n" };
            }

            return { exitCode: 0, stdout: "" };
        });

        expect(getTmuxScrollState("foo")).toEqual({
            historySize: 979,
            paneHeight: 24,
            scrollPosition: 100,
            inMode: true,
            alternateOn: true,
        });
    });

    test("getTmuxScrollState treats empty scroll_position as live bottom", () => {
        setTmuxBinForTests("/mock/tmux");
        setTmuxSpawnSyncForTests(() => ({ exitCode: 0, stdout: "500|40||0|0" }));

        expect(getTmuxScrollState("foo")).toEqual({
            historySize: 500,
            paneHeight: 40,
            scrollPosition: 0,
            inMode: false,
            alternateOn: false,
        });
    });

    test("scrollTmuxToFraction(1) cancels copy-mode to follow live output", () => {
        setTmuxBinForTests("/mock/tmux");
        const calls: string[][] = [];
        setTmuxSpawnSyncForTests((cmd) => {
            calls.push(cmd);

            if (cmd.includes("display-message")) {
                return { exitCode: 0, stdout: "1000|24|50|1|0" };
            }

            return { exitCode: 0, stdout: "" };
        });

        scrollTmuxToFraction("foo", 1);

        expect(calls.some((cmd) => cmd.includes("cancel"))).toBe(true);
        expect(calls.some((cmd) => cmd.includes("scroll-up"))).toBe(false);
    });

    test("scrollTmuxToFraction ignores non-finite fraction", () => {
        setTmuxBinForTests("/mock/tmux");
        const calls: string[][] = [];
        setTmuxSpawnSyncForTests((cmd) => {
            calls.push(cmd);
            return { exitCode: 0, stdout: "1000|24|50|1|0" };
        });

        scrollTmuxToFraction("foo", Number.NaN);

        expect(calls.length).toBe(0);
    });

    test("scrollTmuxToFraction(0) parks at the top of history", () => {
        setTmuxBinForTests("/mock/tmux");
        const calls: string[][] = [];
        setTmuxSpawnSyncForTests((cmd) => {
            calls.push(cmd);

            if (cmd.includes("display-message")) {
                return { exitCode: 0, stdout: "1000|24||0|0" };
            }

            return { exitCode: 0, stdout: "" };
        });

        scrollTmuxToFraction("foo", 0);

        expect(calls.some((cmd) => cmd.includes("copy-mode"))).toBe(true);
        expect(calls.some((cmd) => cmd.includes("history-bottom"))).toBe(true);
        expect(calls.some((cmd) => cmd.includes("scroll-up") && cmd.includes("1000"))).toBe(true);
    });
});
