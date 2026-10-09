import { afterEach, expect, test } from "bun:test";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import { Command } from "commander";
import { registerSessionCommand, runSessionNew } from "../commands/session";
import {
    assertShellExecutable,
    claudeRunCommand,
    devTmuxSessionName,
    parseFocusFlag,
    resolveSessionRepo,
    type SessionNewIO,
    startDevSession,
    suggestProjectNames,
    tmuxAttachCommand,
    tmuxEnterArgv,
    tmuxLiteralSendArgv,
} from "./session-new";

const HOME = "/work";
const PROJECTS = "/work/Tresors/Projects";
const DEMO = `${PROJECTS}/demo`;

const dirs = new Set([PROJECTS, DEMO, "/repo/app", `${PROJECTS}/Demo`]);

function repoFs(extra: string[] = ["demo", "GenesisTools", "Demo"]): SessionNewIO["repoFs"] {
    return {
        isDirectory: (path) => dirs.has(path),
        list: (path) => (path === PROJECTS ? extra : null),
    };
}

function harness(overrides: Partial<SessionNewIO> = {}): { io: SessionNewIO; calls: string[][] } {
    const calls: string[][] = [];
    let windows = [{ ref: "window:5", id: "created", visible: true }];
    const io: SessionNewIO = {
        focusedWindow: async () => "window:1",
        listWindows: async () => {
            calls.push(["list-windows"]);
            const found = windows;
            windows = [{ ref: "window:5", id: "created", visible: true }];
            return found;
        },
        runJSON: async <T>(args: string[]): Promise<T> => {
            calls.push(args);
            return { workspace_ref: "workspace:9", surface_ref: "surface:8", window_ref: "window:1" } as T;
        },
        runOk: async (args) => {
            calls.push(["ok", ...args]);
        },
        shell: () => "/bin/zsh",
        createTmuxShell: async (session, cwd, shell) => {
            calls.push(["tmux-shell", session, cwd, shell]);
        },
        sendTmuxKeys: async (session, command) => {
            calls.push(["tmux-keys", session, command]);
        },
        killTmuxSession: async (session) => {
            calls.push(["tmux-kill", session]);
        },
        repoFs: repoFs(),
        nonce: () => "ab12cd",
        ...overrides,
    };

    return { io, calls };
}

const CLAUDE = "'tools' 'claude' 'run' 'work' '--' 'fix it'";

afterEach(() => {
    process.exitCode = 0;
});

test("claude run line quotes the account and the prompt, and omits -- when there is no prompt", () => {
    expect(claudeRunCommand({ account: "work", prompt: "fix it" })).toBe(CLAUDE);
    expect(claudeRunCommand({ account: "work" })).toBe("'tools' 'claude' 'run' 'work'");
    expect(claudeRunCommand({ account: "work", promptFile: "/tmp/my prompt.md" })).toBe(
        `'tools' 'claude' 'run' 'work' '--' "$(cat '/tmp/my prompt.md')"`
    );
    expect(() => claudeRunCommand({ account: "work", prompt: "go", promptFile: "/tmp/p.md" })).toThrow(
        "only one of --prompt"
    );
});

test("a project name resolves under ~/Tresors/Projects, and a missing name suggests neighbours", () => {
    expect(resolveSessionRepo("demo", HOME, "/elsewhere", repoFs())).toBe(DEMO);
    expect(resolveSessionRepo("~/Tresors/Projects/demo", HOME, "/elsewhere", repoFs())).toBe(DEMO);
    expect(resolveSessionRepo("/repo/app", HOME, "/elsewhere", repoFs())).toBe("/repo/app");
    expect(resolveSessionRepo("./demo", HOME, PROJECTS, repoFs())).toBe(DEMO);

    const folded = repoFs(["Demo"]);
    folded.isDirectory = (path) => path === PROJECTS || path === `${PROJECTS}/Demo`;
    expect(resolveSessionRepo("demo", HOME, "/elsewhere", folded)).toBe(`${PROJECTS}/Demo`);

    expect(() => resolveSessionRepo("genes", HOME, "/elsewhere", repoFs())).toThrow(
        /No project named "genes" under \/work\/Tresors\/Projects\. Did you mean: GenesisTools\?/
    );
    expect(suggestProjectNames("definitely-not-a-project", ["a", "ai", "GenesisTools"])).toEqual([]);
    expect(() => resolveSessionRepo("/missing/repo", HOME, "/elsewhere", repoFs())).toThrow(
        "No such directory: /missing/repo"
    );
    expect(() => resolveSessionRepo("   ", HOME, "/elsewhere", repoFs())).toThrow("--repo is required");
    expect(() =>
        resolveSessionRepo("demo", HOME, "/elsewhere", {
            isDirectory: () => false,
            list: () => null,
        })
    ).toThrow("Projects directory does not exist");
});

test("focus flag defaults to false and rejects anything else", () => {
    expect(parseFocusFlag(undefined)).toEqual({ ok: true, focus: false });
    expect(parseFocusFlag("")).toEqual({ ok: true, focus: false });
    expect(parseFocusFlag("false")).toEqual({ ok: true, focus: false });
    expect(parseFocusFlag("true")).toEqual({ ok: true, focus: true });
    expect(parseFocusFlag(true).ok).toBe(false);
    expect(parseFocusFlag("maybe")).toEqual({ ok: false, given: "maybe" });
});

test("tmux attach quotes the session, and a command line is not a shell path", () => {
    expect(tmuxAttachCommand("cmux-demo-ab12cd")).toBe("tmux attach -t 'cmux-demo-ab12cd'");
    expect(devTmuxSessionName(DEMO, undefined, "ab12cd")).toBe("cmux-demo-ab12cd");
    expect(devTmuxSessionName(DEMO, "My Session", "ab12cd")).toBe("cmux-my-session-ab12cd");
    expect(assertShellExecutable("/bin/zsh")).toBe("/bin/zsh");
    expect(() => assertShellExecutable("echo hi; sleep 300")).toThrow("not a command line");
    expect(() => assertShellExecutable("FOO=1")).toThrow("not a command line");
    expect(tmuxLiteralSendArgv("/usr/bin/tmux", "cmux-demo-ab12cd", CLAUDE)).toEqual([
        "/usr/bin/tmux",
        "send-keys",
        "-t",
        "cmux-demo-ab12cd",
        "-l",
        "--",
        CLAUDE,
    ]);
    expect(tmuxEnterArgv("/usr/bin/tmux", "cmux-demo-ab12cd")).toEqual([
        "/usr/bin/tmux",
        "send-keys",
        "-t",
        "cmux-demo-ab12cd",
        "Enter",
    ]);
});

test("the focused window is passed even when the caller is outside cmux, and focus stays off", async () => {
    const { io, calls } = harness();
    const result = await startDevSession(
        { repo: "demo", account: "work", prompt: "fix it", home: HOME, cwd: "/elsewhere" },
        io
    );

    expect(result).toEqual({
        workspace: "workspace:9",
        surface: "surface:8",
        window: "window:1",
        tmuxSession: null,
        cwd: DEMO,
        command: CLAUDE,
    });
    expect(calls).toEqual([
        ["workspace", "create", "--window", "window:1", "--cwd", DEMO, "--focus", "false", "--command", CLAUDE],
    ]);
});

test("a missing focused window uses an existing one, and creates a window only when none exist", async () => {
    const existing = harness({
        focusedWindow: async () => undefined,
        listWindows: async () => [{ ref: "window:4", id: "already", visible: true }],
    });
    await startDevSession(
        { repo: "demo", account: "work", prompt: "fix it", home: HOME, cwd: "/elsewhere" },
        existing.io
    );
    expect(existing.calls.some((call) => call.includes("new-window"))).toBe(false);
    expect(existing.calls.find((call) => call[0] === "workspace")).toContain("window:4");

    let listed = 0;
    const created = harness({
        focusedWindow: async () => "  ",
        listWindows: async () => {
            listed += 1;
            return listed === 1 ? [] : [{ ref: "window:5", id: "new", visible: true }];
        },
    });
    await startDevSession({ repo: "demo", account: "work", home: HOME, cwd: "/elsewhere" }, created.io);
    expect(created.calls).toContainEqual(["ok", "new-window"]);
    expect(created.calls.find((call) => call[0] === "workspace")).toContain("window:5");
    expect(created.calls.find((call) => call[0] === "workspace")).toContain("'tools' 'claude' 'run' 'work'");
});

test("--name is renamed after create, and a failed rename still returns the workspace", async () => {
    const { io, calls } = harness();
    const result = await startDevSession(
        { repo: "demo", account: "work", prompt: "fix it", name: "Ship", home: HOME, cwd: "/elsewhere" },
        io
    );

    expect(result.workspace).toBe("workspace:9");
    expect(calls[0]).toContain("--name");
    expect(calls[0]).toContain("Ship");
    expect(calls[1]).toEqual(["ok", "rename-workspace", "--workspace", "workspace:9", "Ship"]);

    const failed = harness({
        runOk: async (args) => {
            if (args[0] === "rename-workspace") {
                throw new Error("rename rejected");
            }
        },
    });
    const kept = await startDevSession(
        { repo: "demo", account: "work", name: "Ship", home: HOME, cwd: "/elsewhere" },
        failed.io
    );
    expect(kept.workspace).toBe("workspace:9");
});

test("--via-tmux starts a login shell, send-keys the claude line, and attaches", async () => {
    const { io, calls } = harness();
    const result = await startDevSession(
        { repo: "demo", account: "work", prompt: "fix it", viaTmux: true, home: HOME, cwd: "/elsewhere" },
        io
    );

    expect(result.tmuxSession).toBe("cmux-demo-ab12cd");
    expect(result.command).toBe("tmux attach -t 'cmux-demo-ab12cd'");
    expect(calls[0]).toEqual(["tmux-shell", "cmux-demo-ab12cd", DEMO, "/bin/zsh"]);
    expect(calls[1]).toEqual(["tmux-keys", "cmux-demo-ab12cd", CLAUDE]);
    expect(calls[2]).toContain("tmux attach -t 'cmux-demo-ab12cd'");
    expect(calls[2]).not.toContain(CLAUDE);
    expect(calls.some((call) => call.includes("tools tmux create"))).toBe(false);
});

test("--via-tmux kills its tmux session when the cmux workspace is not created", async () => {
    const { io, calls } = harness({
        runJSON: async <T>(args: string[]): Promise<T> => {
            calls.push(args);
            throw new Error("cmux is busy");
        },
    });

    await expect(
        startDevSession(
            { repo: "demo", account: "work", prompt: "fix it", viaTmux: true, home: HOME, cwd: "/elsewhere" },
            io
        )
    ).rejects.toThrow("cmux is busy");
    expect(calls.at(-1)).toEqual(["tmux-kill", "cmux-demo-ab12cd"]);
});

test("--via-tmux kills its tmux session when sending the launch command fails, before any workspace", async () => {
    const { io, calls } = harness({
        sendTmuxKeys: async () => {
            throw new Error("send-keys failed");
        },
    });

    await expect(
        startDevSession(
            { repo: "demo", account: "work", prompt: "fix it", viaTmux: true, home: HOME, cwd: "/elsewhere" },
            io
        )
    ).rejects.toThrow("send-keys failed");
    expect(calls.at(-1)).toEqual(["tmux-kill", "cmux-demo-ab12cd"]);
    expect(calls.some((call) => call[0] === "workspace" && call[1] === "create")).toBe(false);
});

test("--via-tmux kills nothing when the tmux session itself was not created", async () => {
    const { io, calls } = harness({
        createTmuxShell: async () => {
            throw new Error("tmux is not installed");
        },
    });

    await expect(
        startDevSession(
            { repo: "demo", account: "work", prompt: "fix it", viaTmux: true, home: HOME, cwd: "/elsewhere" },
            io
        )
    ).rejects.toThrow("tmux is not installed");
    expect(calls.some((call) => call[0] === "tmux-kill")).toBe(false);
});

test("a workspace created without --via-tmux kills nothing when cmux fails", async () => {
    const { io, calls } = harness({
        runJSON: async <T>(): Promise<T> => ({ window_ref: "window:1" }) as T,
    });

    await expect(
        startDevSession({ repo: "demo", account: "work", prompt: "fix it", home: HOME, cwd: "/elsewhere" }, io)
    ).rejects.toThrow("no workspace or surface ref");
    expect(calls.some((call) => call[0] === "tmux-kill")).toBe(false);
});

test("--focus true is forwarded, and a workspace with no surface is an error", async () => {
    const focused = harness();
    await startDevSession(
        { repo: "/repo/app", account: "work", prompt: "fix it", focus: true, home: HOME, cwd: "/elsewhere" },
        focused.io
    );
    expect(focused.calls[0]).toContain("true");

    const blind = harness({
        runJSON: async <T>(): Promise<T> => ({ workspace_ref: "workspace:9", window_ref: "window:1" }) as T,
    });
    await expect(
        startDevSession({ repo: "demo", account: "work", home: HOME, cwd: "/elsewhere" }, blind.io)
    ).rejects.toThrow("no workspace or surface");
});

test("session new prints the result JSON and rejects a bad focus before touching cmux", async () => {
    const { io, calls } = harness();
    const stdout = await captureStdout(() =>
        runSessionNew({ repo: "/repo/app", account: "work", prompt: "fix it", json: true, focus: "false" }, io)
    );
    const parsed = SafeJSON.parse(stdout, { strict: true });

    expect(parsed).toMatchObject({
        workspace: "workspace:9",
        surface: "surface:8",
        window: "window:1",
        tmuxSession: null,
        cwd: "/repo/app",
        command: CLAUDE,
    });

    process.exitCode = 0;
    await runSessionNew({ repo: "/repo/app", account: "work", focus: "maybe" }, io);
    expect(process.exitCode).toBe(1);
    expect(calls.filter((call) => call[0] === "workspace")).toHaveLength(1);
});

test("session new advertises repo, account, prompt, tmux, focus, and json", async () => {
    const program = new Command().exitOverride();
    registerSessionCommand(program);
    const session = program.commands.find((command) => command.name() === "session");
    const created = session?.commands.find((command) => command.name() === "new");

    if (!created) {
        throw new Error("session new was not registered");
    }

    created.exitOverride();
    let opts: Record<string, unknown> = {};
    const stop = new Error("stop");
    created?.hook("preAction", (_thisCommand, action) => {
        opts = action.opts();
        throw stop;
    });

    await expect(
        program.parseAsync(
            ["session", "new", "--repo", "demo", "--account", "work", "--via-tmux", "--focus", "false", "--json"],
            { from: "user" }
        )
    ).rejects.toBe(stop);

    expect(opts).toMatchObject({
        repo: "demo",
        account: "work",
        viaTmux: true,
        focus: "false",
        json: true,
    });
});

async function captureStdout(run: () => Promise<void>): Promise<string> {
    const chunks: string[] = [];
    const original = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array, encoding?: unknown, callback?: unknown) => {
        chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
        const done = typeof encoding === "function" ? encoding : callback;

        if (typeof done === "function") {
            (done as (error?: Error | null) => void)(null);
        }

        return true;
    }) as typeof process.stdout.write;

    try {
        await run();
        await out.flush();
        return chunks.join("");
    } finally {
        process.stdout.write = original;
    }
}
