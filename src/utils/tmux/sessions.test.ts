import { afterEach, describe, expect, test } from "bun:test";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { resetTmuxBinCache, setTmuxBinForTests } from "@genesiscz/utils/tmux/bin";
import {
    argvWithChildDeadline,
    buildTmuxSpawnEnv,
    createTmuxSession,
    createTmuxSessionRunning,
    ensureTmuxServerPersists,
    getTmuxScrollState,
    killTmuxSessionExact,
    listTmuxClients,
    listTmuxPanes,
    listTmuxSessionActivePanes,
    listTmuxSessionCommands,
    listTmuxSessions,
    parsePaneDeath,
    parseTmuxEnvironment,
    renameTmuxSession,
    scrollTmuxToFraction,
    sessionExists,
    setTmuxSpawnSyncForTests,
    TMUX_CHILD_DEADLINE_MS,
    TMUX_SPAWN_GUARD,
    tmuxPaneArgv,
    tmuxServerBootstrapCwd,
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

    test("pane and client listings parse, an absent server is empty, and an unanswered tmux is a failure", async () => {
        setTmuxBinForTests("/mock/tmux");
        const calls: string[][] = [];
        let answer: { exitCode: number | null; stdout: string; stderr?: string } = {
            exitCode: 0,
            stdout: rec("%41|cmux-app|/dev/ttys041|1760000000|1|1") + rec("%42|cmux-app|/dev/ttys042|1760000000|1|0"),
        };
        setTmuxSpawnSyncForTests((cmd) => {
            calls.push(cmd);
            return answer;
        });

        expect(await listTmuxPanes("cmux-app")).toEqual({
            ok: true,
            items: [
                {
                    pane: "%41",
                    session: "cmux-app",
                    tty: "/dev/ttys041",
                    sessionCreatedMs: 1_760_000_000_000,
                    visible: true,
                },
                {
                    pane: "%42",
                    session: "cmux-app",
                    tty: "/dev/ttys042",
                    sessionCreatedMs: 1_760_000_000_000,
                    visible: false,
                },
            ],
        });
        // One session is matched exactly: a bare name would fall back to a prefix match on another session.
        expect(calls[0]).toContain("=cmux-app");

        answer = { exitCode: 0, stdout: rec("/dev/ttys006|cmux-app") };
        expect(await listTmuxClients()).toEqual({ ok: true, items: [{ tty: "/dev/ttys006", session: "cmux-app" }] });

        answer = { exitCode: 1, stdout: "", stderr: "no server running on /private/tmp/tmux-501/default" };
        expect(await listTmuxPanes()).toEqual({ ok: true, items: [] });
        answer = {
            exitCode: 1,
            stdout: "",
            stderr: "error connecting to /private/tmp/tmux-501/default (No such file or directory)",
        };
        expect(await listTmuxPanes()).toEqual({ ok: true, items: [] });
        // A socket tmux cannot open is a failure: the server and its sessions may well be there.
        answer = {
            exitCode: 1,
            stdout: "",
            stderr: "error connecting to /private/tmp/tmux-501/default (Permission denied)",
        };
        expect((await listTmuxPanes()).ok).toBe(false);
        expect(await killTmuxSessionExact("cmux-app")).toMatchObject({ ok: false });

        answer = { exitCode: null, stdout: "" };
        const unanswered = await listTmuxPanes("cmux-app");
        expect(unanswered.ok).toBe(false);
        expect(unanswered.ok ? "" : unanswered.reason).toContain("did not answer");
    });

    test("argvWithChildDeadline prefixes a bounded watchdog, not an unbounded wait", () => {
        const wrapped = argvWithChildDeadline(["/usr/bin/tmux", "list-sessions"]);

        expect(wrapped[0]).toBe("/usr/bin/perl");
        expect(wrapped).toContain(String(TMUX_CHILD_DEADLINE_MS));
        expect(wrapped.at(-1)).toBe("list-sessions");
        expect(wrapped.join(" ")).toContain("alarm 1");
    });

    test.skipIf(process.platform === "win32")(
        "child watchdog preserves success, nonzero exit and signal status",
        () => {
            for (const [script, status] of [
                ["exit 0", 0],
                ["exit 7", 7],
                ["kill -TERM $$", 143],
            ] as const) {
                const result = Bun.spawnSync(argvWithChildDeadline(["/bin/sh", "-c", script]), { env: process.env });
                expect(result.exitCode).toBe(status);
            }
        }
    );

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

    test("a command line runs through the login shell, never as one argv word", () => {
        const shell = env.paths.getShell("/bin/zsh");
        const pane = tmuxPaneArgv("echo hi; sleep 1");

        expect(pane.commandLine).toBe(true);
        expect(pane.argv[0]).toBe("/usr/bin/env");
        expect(pane.argv.slice(-3)).toEqual([shell, "-lic", "echo hi; sleep 1"]);
        expect(tmuxPaneArgv("FOO=1 bun test").argv.slice(-2)).toEqual(["-lic", "FOO=1 bun test"]);
        // tmux splits its own argv at a word ending in `;`, so such a word gets a trailing space.
        expect(tmuxPaneArgv("npm test;").argv.at(-1)).toBe("npm test; ");
        expect(tmuxPaneArgv("find . -exec echo {} ;").argv.at(-1)).toBe("find . -exec echo {} ; ");
        expect(tmuxPaneArgv("echo hi; sleep 300").argv.at(-1)).toBe("echo hi; sleep 300");
    });

    test("a bare executable or an empty command keeps the plain shell pane (ttyd, snapshot restore)", () => {
        expect(tmuxPaneArgv("/bin/zsh")).toMatchObject({ commandLine: false });
        expect(tmuxPaneArgv("/bin/zsh").argv.at(-1)).toBe("/bin/zsh");
        expect(tmuxPaneArgv("/usr/bin/top").argv.at(-1)).toBe("/usr/bin/top");
        expect(tmuxPaneArgv("  ").argv.at(-1)).toBe(env.paths.getShell("/bin/zsh"));
        expect(tmuxPaneArgv("/bin/zsh").argv).not.toContain("-lic");
    });

    test("named variables are unset in the pane, and nothing is unset unless asked", () => {
        const pane = tmuxPaneArgv("/bin/zsh", { unsetEnv: ["CMUX_SURFACE_ID", "CMUX_WORKSPACE_ID"] });

        expect(pane.argv.slice(0, 5)).toEqual(["/usr/bin/env", "-u", "CMUX_SURFACE_ID", "-u", "CMUX_WORKSPACE_ID"]);
        expect(pane.argv.at(-1)).toBe("/bin/zsh");
        expect(tmuxPaneArgv("/bin/zsh").argv).not.toContain("-u");
    });

    test("a command-line session keeps its pane and is not reported when its command died", async () => {
        setTmuxBinForTests("/mock/tmux");
        const calls: string[][] = [];
        setTmuxSpawnSyncForTests((cmd) => {
            calls.push(cmd);
            if (cmd.includes("display-message")) {
                return { exitCode: 0, stdout: "1|127|\n" };
            }

            if (cmd.includes("capture-pane")) {
                return { exitCode: 0, stdout: "zsh: command not found: nope\n" };
            }

            return { exitCode: 0, stdout: "" };
        });

        await expect(createTmuxSession("dead", "/tmp", "nope --flag", { settleMs: 0 })).rejects.toThrow(
            /exited with status 127:\nzsh: command not found: nope/
        );

        const create = calls.find((cmd) => cmd.includes("new-session"));
        expect(create?.slice(create.indexOf(";"))).toEqual([";", "set-option", "-t", "dead", "remain-on-exit", "on"]);
        expect(calls.some((cmd) => cmd.includes("kill-session") && cmd.includes("dead"))).toBe(true);
    });

    test("a pane killed by a signal is a failed command, not a created session", async () => {
        setTmuxBinForTests("/mock/tmux");
        const calls: string[][] = [];
        setTmuxSpawnSyncForTests((cmd) => {
            calls.push(cmd);
            // tmux leaves pane_dead_status empty and sets pane_dead_signal for a signal death.
            return { exitCode: 0, stdout: cmd.includes("display-message") ? "1||11\n" : "" };
        });

        await expect(createTmuxSession("crashed", "/tmp", "segv --now", { settleMs: 0 })).rejects.toThrow(
            /was killed by signal 11/
        );
        expect(calls.some((cmd) => cmd.includes("kill-session") && cmd.includes("crashed"))).toBe(true);
        expect(parsePaneDeath("1||9")).toEqual({ dead: true, failure: "was killed by signal 9" });
        expect(parsePaneDeath("1|0|")).toEqual({ dead: true, failure: null });
        expect(parsePaneDeath("0||")).toEqual({ dead: false, failure: null });
    });

    test("a command line that finished cleanly, or is still running, is a created session", async () => {
        setTmuxBinForTests("/mock/tmux");
        for (const paneState of ["1|0|\n", "0||\n"]) {
            const calls: string[][] = [];
            setTmuxSpawnSyncForTests((cmd) => {
                calls.push(cmd);
                return { exitCode: 0, stdout: cmd.includes("display-message") ? paneState : "" };
            });

            await createTmuxSession("ok", "/tmp", "echo hi", { settleMs: 0 });
            expect(calls.some((cmd) => cmd.includes("kill-session"))).toBe(false);
        }
    });

    test("a new session's client runs in the home folder, and -c carries the pane's own folder", async () => {
        setTmuxBinForTests("/mock/tmux");
        const creates: Array<{ cmd: string[]; cwd?: string }> = [];
        setTmuxSpawnSyncForTests((cmd, opts) => {
            if (cmd.includes("new-session")) {
                creates.push({ cmd, cwd: opts?.cwd });
            }

            return { exitCode: 0, stdout: "" };
        });

        await createTmuxSession("foo", "/tmp/soon-deleted-worktree", "/bin/zsh");
        await createTmuxSessionRunning("bar", "/tmp/soon-deleted-worktree", ["claude"]);

        expect(creates).toHaveLength(2);

        for (const { cmd, cwd } of creates) {
            expect(cwd).toBe(tmuxServerBootstrapCwd());
            expect(cmd[cmd.indexOf("-c") + 1]).toBe("/tmp/soon-deleted-worktree");
        }
    });

    test("createTmuxSessionRunning puts argv after -- instead of a login shell", async () => {
        setTmuxBinForTests("/mock/tmux");
        const calls: string[][] = [];
        setTmuxSpawnSyncForTests((cmd) => {
            calls.push(cmd);
            return { exitCode: 0, stdout: "" };
        });

        await createTmuxSessionRunning("claude-auth", "/tmp", ["claude", "--resume", "abc"], {
            CLAUDE_CODE_OAUTH_TOKEN: "tok",
        });

        const created = calls.find((cmd) => cmd.includes("new-session"));
        expect(created).toBeDefined();
        const dash = created?.indexOf("--") ?? -1;
        expect(created?.slice(dash)?.[0]).toBe("--");
        expect(created?.slice(dash)).toContain("/usr/bin/env");
        expect(created?.some((token) => token === "CLAUDE_CODE_OAUTH_TOKEN=tok")).toBe(true);
        expect(created?.slice(-3)).toEqual(["claude", "--resume", "abc"]);
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

    // Regression test: 2026-09-16 — three orphan `tmux list-sessions` clients sat at
    // ~95% CPU for 28h after the feat-dev-dashboard-mobile parent died (PPID 1,
    // stdout gone). Bun.spawn `{ timeout }` lives in the parent, so it dies with it.
    //
    // Proven in two halves so the test does not sit out the real 8 s deadline (perl's
    // alarm is whole seconds). The REAL path: `listTmuxSessions` launches its client as a
    // child of the perl watchdog armed with TMUX_CHILD_DEADLINE_MS. The REAP: the same
    // watchdog, armed for 1 s, still kills a wedged client after the parent is SIGKILLed.
    test("SIGKILL of the parent still reaps a wedged list-sessions client", async () => {
        const { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } = await import("node:fs");

        if (!existsSync("/usr/bin/perl")) {
            return;
        }
        const { tmpdir } = await import("node:os");
        const { join } = await import("node:path");
        const { isProcessAlive } = await import("@genesiscz/utils/process-alive");

        const dir = join(tmpdir(), `tmux-orphan-${process.pid}-${Date.now()}`);
        mkdirSync(dir, { recursive: true });

        const spinnerBody = (pidfile: string) =>
            `printf '%s' "$$" > "${pidfile}"\ntrap '' TERM INT\nwhile true; do :; done`;

        // A script file, because listTmuxSessions runs it as the tmux binary. The first run of a new executable
        // costs ~270 ms on macOS and those runs queue across test processes (8 at once: 280 to 2050 ms), which
        // the 8 s watchdog absorbs and a 1 s one cannot.
        const realClient = { path: join(dir, "tmux"), pidfile: join(dir, "tmux.pid") };
        writeFileSync(realClient.path, `#!/bin/sh\n${spinnerBody(realClient.pidfile)}\n`);
        chmodSync(realClient.path, 0o755);
        // The 1 s client is `sh -c` for that reason: 10 ms to start, however many tests run beside this one.
        const reapedPidfile = join(dir, "wedged.pid");
        const reapedArgv = ["/bin/sh", "-c", spinnerBody(reapedPidfile)];

        const repoRoot = join(import.meta.dir, "../../..");
        const parent = join(dir, "parent.ts");
        // The 1 s watchdog is armed only once the real client is up, and the parent kills itself as soon as the
        // 1 s client is up too. So neither a slow start nor a slow test process decides the order of events.
        // Exit code 3 means a client was gone or never came up.
        writeFileSync(
            parent,
            `import { readFileSync } from "node:fs";\n` +
                `import { argvWithChildDeadline } from ${SafeJSON.stringify(`${repoRoot}/src/utils/process/child-deadline.ts`)};\n` +
                `import { setTmuxBinForTests } from ${SafeJSON.stringify(`${repoRoot}/src/utils/tmux/bin.ts`)};\n` +
                `import { listTmuxSessions } from ${SafeJSON.stringify(`${repoRoot}/src/utils/tmux/sessions.ts`)};\n` +
                `const up = (file) => { try { return process.kill(Number.parseInt(readFileSync(file, "utf8"), 10), 0); } catch { return false; } };\n` +
                `const waitUp = async (file) => { for (const stop = Date.now() + 5000; Date.now() < stop && !up(file); ) { await Bun.sleep(10); } return up(file); };\n` +
                `setTmuxBinForTests(${SafeJSON.stringify(realClient.path)});\n` +
                `void listTmuxSessions();\n` +
                `if (!(await waitUp(${SafeJSON.stringify(realClient.pidfile)}))) { process.exit(3); }\n` +
                `Bun.spawn(argvWithChildDeadline(${SafeJSON.stringify(reapedArgv)}, 1000), { stdout: "ignore", stderr: "ignore" });\n` +
                `if (!(await waitUp(${SafeJSON.stringify(reapedPidfile)}))) { process.exit(3); }\n` +
                `process.kill(process.pid, "SIGKILL");\n`
        );

        // `env` is required: without it Bun does not forward the test temp root (TMPDIR, set by the
        // bun test preload) and the child writes into the real temp folder.
        const child = Bun.spawn(["bun", "run", parent], {
            cwd: repoRoot,
            env: process.env,
            stdout: "ignore",
            stderr: "pipe",
        });

        function pidOf(pidfile: string): number {
            try {
                return Number.parseInt(readFileSync(pidfile, "utf8").trim(), 10) || 0;
            } catch {
                return 0;
            }
        }

        try {
            await child.exited;
            expect(child.signalCode).toBe("SIGKILL");

            const realPid = pidOf(realClient.pidfile);
            const reapedPid = pidOf(reapedPidfile);

            expect(realPid).toBeGreaterThan(0);
            expect(reapedPid).toBeGreaterThan(0);

            const psField = (field: string, pid: number) =>
                Bun.spawnSync(["ps", "-o", `${field}=`, "-p", String(pid)], { env: process.env })
                    .stdout.toString()
                    .trim();
            const watchdog = psField("args", Number.parseInt(psField("ppid", realPid), 10));
            expect(watchdog).toContain("/usr/bin/perl");
            expect(watchdog).toContain(` ${TMUX_CHILD_DEADLINE_MS} `);

            // Its watchdog would reap it in 8 s; the reap itself is proven on the second client.
            process.kill(realPid, "SIGKILL");

            const reapUntil = Date.now() + 5000;

            while (Date.now() < reapUntil && isProcessAlive(reapedPid)) {
                await Bun.sleep(100);
            }

            expect(isProcessAlive(reapedPid)).toBe(false);
        } finally {
            for (const pidfile of [realClient.pidfile, reapedPidfile]) {
                const pid = pidOf(pidfile);

                if (pid > 0 && isProcessAlive(pid)) {
                    process.kill(pid, "SIGKILL");
                }
            }

            rmSync(dir, { recursive: true, force: true });
        }
    }, 20_000);

    // Regression test: 2026-09-16 — dashboard polls overlapped, so three wedged
    // list-sessions clients ran at once after the parent died.
    test("overlapping listTmuxSessionActivePanes share one tmux spawn", async () => {
        setTmuxBinForTests("/mock/tmux");
        let calls = 0;
        setTmuxSpawnSyncForTests(async (cmd) => {
            if (cmd.includes("list-sessions")) {
                calls += 1;
                await Bun.sleep(30);

                return { exitCode: 0, stdout: rec("s|sh|title") };
            }

            return { exitCode: 0, stdout: "" };
        });

        const [a, b] = await Promise.all([listTmuxSessionActivePanes(), listTmuxSessionActivePanes()]);

        expect(calls).toBe(1);
        expect(a.get("s")?.command).toBe("sh");
        expect(b.get("s")?.command).toBe("sh");
    });

    test("ensureTmuxServerPersists unsets a test sandbox captured in the server global env", async () => {
        setTmuxBinForTests("/mock/tmux");
        const calls: string[][] = [];
        setTmuxSpawnSyncForTests((cmd) => {
            calls.push(cmd);

            if (cmd.includes("show-environment")) {
                return {
                    exitCode: 0,
                    stdout: [
                        "GENESIS_TOOLS_HOME=/tmp/gt-test-tmp-abc/gt-test-home-xyz",
                        "GENESIS_TEST_TMP_ROOT=/tmp/gt-test-tmp-abc",
                        "TMPDIR=/tmp/gt-test-tmp-abc",
                        "NODE_ENV=test",
                        "PATH=/bin",
                        "-NO_COLOR",
                    ].join("\n"),
                };
            }

            return { exitCode: 0, stdout: "" };
        });

        await ensureTmuxServerPersists();

        const batch = calls.find((cmd) => cmd.includes("set-option"))?.join(" ") ?? "";
        expect(batch).toContain("set-environment -gu GENESIS_TOOLS_HOME");
        expect(batch).toContain("set-environment -gu GENESIS_TEST_TMP_ROOT");
        expect(batch).toContain("set-environment -gu TMPDIR");
        expect(batch).toContain("set-environment -gu NODE_ENV");
        expect(batch).not.toContain("set-environment -gu PATH");
    });

    test("ensureTmuxServerPersists leaves a clean server global env untouched", async () => {
        setTmuxBinForTests("/mock/tmux");
        const calls: string[][] = [];
        setTmuxSpawnSyncForTests((cmd) => {
            calls.push(cmd);

            if (cmd.includes("show-environment")) {
                return { exitCode: 0, stdout: "PATH=/bin\nTMPDIR=/var/folders/6w/T/\nNODE_ENV=development" };
            }

            return { exitCode: 0, stdout: "" };
        });

        await ensureTmuxServerPersists();

        const batch = calls.find((cmd) => cmd.includes("set-option"))?.join(" ") ?? "";
        expect(batch).toContain("set-environment -gu NO_COLOR");
        expect(batch).not.toContain("TMPDIR");
        expect(batch).not.toContain("NODE_ENV");
    });

    test("parseTmuxEnvironment keeps values with '=' and skips removal markers", () => {
        const parsed = parseTmuxEnvironment("FOO=a=b\n-BAR\nBAZ=\n");

        expect(parsed.FOO).toBe("a=b");
        expect(parsed.BAR).toBeUndefined();
        expect(parsed.BAZ).toBe("");
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
