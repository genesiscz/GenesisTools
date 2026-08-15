import { afterEach, describe, expect, test } from "bun:test";
import { env } from "@genesiscz/utils/env";
import { resetTmuxBinCache, setTmuxBinForTests } from "@genesiscz/utils/tmux/bin";
import {
    buildTmuxSpawnEnv,
    createTmuxSession,
    getTmuxScrollState,
    listTmuxSessionActivePanes,
    listTmuxSessionCommands,
    listTmuxSessions,
    renameTmuxSession,
    scrollTmuxToFraction,
    sessionExists,
    setTmuxSpawnSyncForTests,
    TMUX_SPAWN_GUARD,
} from "@genesiscz/utils/tmux/sessions";

/**
 * One RS-framed, US-delimited `list-sessions` record, exactly as tmux emits it with our
 * `-F` string. Fields are written here with `|` for legibility and swapped to the real
 * separator, so a literal TAB in a test value stays part of its field.
 */
function rec(fields: string): string {
    return `\x1e${fields.split("|").join("\x1f")}\n`;
}

describe("tmux sessions", () => {
    afterEach(() => {
        setTmuxSpawnSyncForTests(null);
        setTmuxBinForTests(null);
        resetTmuxBinCache();
    });

    test("listTmuxSessions parses every column of the tmux list-sessions record", async () => {
        setTmuxBinForTests("/mock/tmux");
        setTmuxSpawnSyncForTests((cmd) => {
            if (cmd.includes("list-sessions")) {
                return {
                    exitCode: 0,
                    stdout: rec("dev-dashboard-abc12345|1|2|claude|/Users/me/proj|1754140000|1754150000|✳ testt"),
                };
            }

            return { exitCode: 0, stdout: "" };
        });

        expect(await listTmuxSessions()).toEqual([
            {
                name: "dev-dashboard-abc12345",
                attached: 1,
                windows: 2,
                command: "claude",
                cwd: "/Users/me/proj",
                created: 1754140000,
                lastActivity: 1754150000,
                title: "✳ testt",
            },
        ]);
    });

    test("listTmuxSessions leaves empty and malformed columns undefined", async () => {
        setTmuxBinForTests("/mock/tmux");
        setTmuxSpawnSyncForTests((cmd) => {
            if (cmd.includes("list-sessions")) {
                return { exitCode: 0, stdout: rec("cmux-test|0|1|||nope||") };
            }

            return { exitCode: 0, stdout: "" };
        });

        expect(await listTmuxSessions()).toEqual([{ name: "cmux-test", attached: 0, windows: 1 }]);
    });

    // A pane title is arbitrary user text. Splitting records on "\n" let a title with a
    // newline in it terminate its own record, so the tail parsed as an extra session.
    test("listTmuxSessions does not let a multi-line pane title fabricate a session", async () => {
        setTmuxBinForTests("/mock/tmux");
        setTmuxSpawnSyncForTests((cmd) => {
            if (cmd.includes("list-sessions")) {
                return {
                    exitCode: 0,
                    stdout:
                        rec("real|1|1|claude|/x|1|2|line one\nphantom\t9\t9\tsh\t/evil\t1\t2\tspoofed") +
                        rec("second|0|1|zsh|/y|3|4|plain"),
                };
            }

            return { exitCode: 0, stdout: "" };
        });

        const sessions = await listTmuxSessions();

        expect(sessions.map((s) => s.name)).toEqual(["real", "second"]);
        expect(sessions[0].title).toBe("line one phantom 9 9 sh /evil 1 2 spoofed");
    });

    test("listTmuxSessions keeps a tab-containing pane title whole", async () => {
        setTmuxBinForTests("/mock/tmux");
        setTmuxSpawnSyncForTests((cmd) => {
            if (cmd.includes("list-sessions")) {
                return { exitCode: 0, stdout: rec("tabbed|1|1|claude|/x|1|2|✳ a\tb") };
            }

            return { exitCode: 0, stdout: "" };
        });

        expect((await listTmuxSessions())[0].title).toBe("✳ a b");
    });

    // A TAB in the cwd used to shift every field after it: verified against tmux 3.6a, a
    // cwd of `…/tab\tpath` produced NINE tab-separated fields, so the timestamps landed one
    // column late and the title absorbed the overflow. Fields are US-delimited now.
    test("listTmuxSessions does not let a tab in the cwd shift the later fields", async () => {
        setTmuxBinForTests("/mock/tmux");
        setTmuxSpawnSyncForTests((cmd) => {
            if (cmd.includes("list-sessions")) {
                return { exitCode: 0, stdout: rec("tabcwd|1|1|sleep|/tmp/tab\tpath|1786821282|1786821283|✳ topic") };
            }

            return { exitCode: 0, stdout: "" };
        });

        expect(await listTmuxSessions()).toEqual([
            {
                name: "tabcwd",
                attached: 1,
                windows: 1,
                command: "sleep",
                cwd: "/tmp/tab\tpath",
                created: 1786821282,
                lastActivity: 1786821283,
                title: "✳ topic",
            },
        ]);
    });

    test("listTmuxSessions returns empty when tmux fails", async () => {
        setTmuxBinForTests("/mock/tmux");
        setTmuxSpawnSyncForTests(() => ({ exitCode: 1, stdout: "" }));
        expect(await listTmuxSessions()).toEqual([]);
    });

    test("listTmuxSessionCommands maps session name to its active pane command", async () => {
        setTmuxBinForTests("/mock/tmux");
        setTmuxSpawnSyncForTests((cmd) => {
            if (cmd.includes("list-sessions")) {
                return {
                    exitCode: 0,
                    stdout: rec("dev-dashboard-abc12345|claude|✳ testt") + rec("cmux-test|zsh|") + rec("blank-cmd||"),
                };
            }

            return { exitCode: 0, stdout: "" };
        });

        const commands = await listTmuxSessionCommands();
        expect(commands.get("dev-dashboard-abc12345")).toBe("claude");
        expect(commands.get("cmux-test")).toBe("zsh");
        // A blank command is skipped (no entry), not stored as "".
        expect(commands.has("blank-cmd")).toBe(false);
    });

    test("listTmuxSessionActivePanes includes pane titles", async () => {
        setTmuxBinForTests("/mock/tmux");
        setTmuxSpawnSyncForTests((cmd) => {
            if (cmd.includes("list-sessions")) {
                return {
                    exitCode: 0,
                    stdout: rec("dev-dashboard-abc12345|claude|✳ testt") + rec("cmux-test|zsh|"),
                };
            }

            return { exitCode: 0, stdout: "" };
        });

        const panes = await listTmuxSessionActivePanes();
        expect(panes.get("dev-dashboard-abc12345")).toEqual({ command: "claude", title: "✳ testt" });
        expect(panes.get("cmux-test")).toEqual({ command: "zsh", title: "" });
    });

    test("listTmuxSessionCommands returns empty when tmux fails", async () => {
        setTmuxBinForTests("/mock/tmux");
        setTmuxSpawnSyncForTests(() => ({ exitCode: 1, stdout: "" }));
        expect((await listTmuxSessionCommands()).size).toBe(0);
    });

    test("sessionExists checks parsed list", async () => {
        setTmuxBinForTests("/mock/tmux");
        setTmuxSpawnSyncForTests((cmd) => {
            if (cmd.includes("list-sessions")) {
                return { exitCode: 0, stdout: rec("foo|0|1") };
            }

            return { exitCode: 0, stdout: "" };
        });

        expect(await sessionExists("foo")).toBe(true);
        expect(await sessionExists("missing")).toBe(false);
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

    test("renameTmuxSession calls tmux rename-session", async () => {
        setTmuxBinForTests("/mock/tmux");
        const calls: string[][] = [];
        setTmuxSpawnSyncForTests((cmd) => {
            calls.push(cmd);

            if (cmd.includes("list-sessions")) {
                return { exitCode: 0, stdout: rec("foo|1|1") };
            }

            return { exitCode: 0, stdout: "" };
        });

        await renameTmuxSession("foo", "bar");

        expect(calls.some((cmd) => cmd.includes("rename-session") && cmd.includes("bar"))).toBe(true);
    });

    test("createTmuxSession pins exit-empty off so the server keeps sessions across teardown", async () => {
        setTmuxBinForTests("/mock/tmux");
        const calls: string[][] = [];
        setTmuxSpawnSyncForTests((cmd) => {
            calls.push(cmd);
            return { exitCode: 0, stdout: "" };
        });

        await createTmuxSession("foo", "/tmp", "/bin/zsh");

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

    test("getTmuxScrollState parses display-message output", async () => {
        setTmuxBinForTests("/mock/tmux");
        setTmuxSpawnSyncForTests((cmd) => {
            if (cmd.includes("display-message")) {
                return { exitCode: 0, stdout: "979|24|100|1|1\n" };
            }

            return { exitCode: 0, stdout: "" };
        });

        expect(await getTmuxScrollState("foo")).toEqual({
            historySize: 979,
            paneHeight: 24,
            scrollPosition: 100,
            inMode: true,
            alternateOn: true,
        });
    });

    test("getTmuxScrollState treats empty scroll_position as live bottom", async () => {
        setTmuxBinForTests("/mock/tmux");
        setTmuxSpawnSyncForTests(() => ({ exitCode: 0, stdout: "500|40||0|0" }));

        expect(await getTmuxScrollState("foo")).toEqual({
            historySize: 500,
            paneHeight: 40,
            scrollPosition: 0,
            inMode: false,
            alternateOn: false,
        });
    });

    test("scrollTmuxToFraction(1) cancels copy-mode to follow live output", async () => {
        setTmuxBinForTests("/mock/tmux");
        const calls: string[][] = [];
        setTmuxSpawnSyncForTests((cmd) => {
            calls.push(cmd);

            if (cmd.includes("display-message")) {
                return { exitCode: 0, stdout: "1000|24|50|1|0" };
            }

            return { exitCode: 0, stdout: "" };
        });

        await scrollTmuxToFraction("foo", 1);

        expect(calls.some((cmd) => cmd.includes("cancel"))).toBe(true);
        expect(calls.some((cmd) => cmd.includes("scroll-up"))).toBe(false);
    });

    test("scrollTmuxToFraction ignores non-finite fraction", async () => {
        setTmuxBinForTests("/mock/tmux");
        const calls: string[][] = [];
        setTmuxSpawnSyncForTests((cmd) => {
            calls.push(cmd);
            return { exitCode: 0, stdout: "1000|24|50|1|0" };
        });

        await scrollTmuxToFraction("foo", Number.NaN);

        expect(calls.length).toBe(0);
    });

    test("scrollTmuxToFraction(0) parks at the top of history", async () => {
        setTmuxBinForTests("/mock/tmux");
        const calls: string[][] = [];
        setTmuxSpawnSyncForTests((cmd) => {
            calls.push(cmd);

            if (cmd.includes("display-message")) {
                return { exitCode: 0, stdout: "1000|24||0|0" };
            }

            return { exitCode: 0, stdout: "" };
        });

        await scrollTmuxToFraction("foo", 0);

        expect(calls.some((cmd) => cmd.includes("copy-mode"))).toBe(true);
        expect(calls.some((cmd) => cmd.includes("history-bottom"))).toBe(true);
        expect(calls.some((cmd) => cmd.includes("scroll-up") && cmd.includes("1000"))).toBe(true);
    });
});

/**
 * A wedged tmux server blocks forever and spins a core; snapshot capture now runs from an
 * HTTP handler, so an unguarded spawn there leaves the dashboard request pending. The guard
 * lives in ONE exported constant precisely so a second spawner cannot quietly omit it.
 */
describe("tmux spawn wedge guard", () => {
    test("bounds every call and kills with SIGKILL", () => {
        expect(TMUX_SPAWN_GUARD).toEqual({ timeout: 10_000, killSignal: "SIGKILL" });
    });

    test.each([["src/utils/tmux/sessions.ts"], ["src/utils/tmux/snapshot.ts"]])(
        "%s spawns through the shared guard, never bare options",
        async (path) => {
            const source = await Bun.file(path).text();

            for (const call of source.match(/Bun\.spawn\((?:.|\n)*?\}\)/g) ?? []) {
                expect(call).toContain("TMUX_SPAWN_GUARD");
            }
        }
    );
});
