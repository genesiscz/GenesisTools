import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as transcripts from "@genesiscz/utils/ai/transcripts/resolve";
import { toolsEntrypoint } from "@genesiscz/utils/cli/tools";
import type { JournalCoverage } from "@genesiscz/utils/cmux/journal-coverage";
import * as cmuxCli from "@genesiscz/utils/cmux/lib/cli";
import { formatDateTime } from "@genesiscz/utils/date";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import { shellQuote, shellWord } from "@genesiscz/utils/shell/quote";
import { Command } from "commander";
import { formatSessionList, registerAgentsCommand, runSessionNew } from "../commands/agents";
import { accountChoiceMessage, budgetsFromCache, budgetsFromSnapshots } from "./account-budgets";
import * as coverageLive from "./journal-coverage-live";
import { agentRunCommand, agentRunLauncher, pickSessionAccount, sessionAgent, withPidNote } from "./session-agents";
import * as inventory from "./session-inventory";
import {
    assertShellExecutable,
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
import { fileSessionStore, openSessions, type SessionRecordLine, type SessionStore } from "./session-store";

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
        focusedWindow: async () => "uuid-window:1",
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
            return { pane: "%41", sessionCreatedMs: 1_760_000_000_000 };
        },
        sendTmuxKeys: async (session, command) => {
            calls.push(["tmux-keys", session, command]);
        },
        killTmuxSession: async (session) => {
            calls.push(["tmux-kill", session]);
        },
        repoFs: repoFs(),
        nonce: () => "ab12cd",
        ensureTitle: async ({ workspace, window, title }) => {
            calls.push(["title", workspace, window, title]);
            return "already-set";
        },
        surfaceIds: async () => ({ workspaceId: "uuid-workspace:9", surfaceId: "uuid-surface:8" }),
        ...overrides,
    };

    return { io, calls };
}

const TOOLS = shellQuote(toolsEntrypoint());
const CLAUDE = `${TOOLS} 'claude' 'run' 'work' '--' 'fix it'`;

afterEach(() => {
    process.exitCode = 0;
});

test("the run line quotes the account and the prompt, and omits -- when there is no prompt", () => {
    expect(agentRunCommand({ agent: "claude", account: "work", prompt: "fix it" })).toBe(CLAUDE);
    expect(agentRunCommand({ agent: "claude", account: "work" })).toBe(`${TOOLS} 'claude' 'run' 'work'`);
    expect(agentRunCommand({ agent: "claude", account: "work", crossMessages: true })).toBe(
        `${TOOLS} 'claude' 'run' 'work' '--cross-messages'`
    );
    // Only Claude has the setting; another agent's line is unchanged.
    expect(agentRunCommand({ agent: "codex", account: "work", crossMessages: true })).toBe(
        `${TOOLS} 'codex' 'run' 'work'`
    );
    expect(agentRunCommand({ agent: "claude", account: "work", promptFile: "/tmp/my prompt.md" })).toBe(
        `${TOOLS} 'claude' 'run' 'work' '--' "$(cat '/tmp/my prompt.md')"`
    );
    expect(() => agentRunCommand({ agent: "claude", account: "work", prompt: "go", promptFile: "/tmp/p.md" })).toThrow(
        "only one of --prompt"
    );
    expect(agentRunCommand({ agent: "codex", account: "side", model: "gpt-5", prompt: "go" })).toBe(
        `${TOOLS} 'codex' 'run' 'side' '-m' 'gpt-5' '--' 'go'`
    );
    expect(agentRunCommand({ agent: "grok", account: "side" })).toBe(`${TOOLS} 'grok' 'run' 'side'`);
    // The checkout's own entrypoint by absolute path, never a bare `tools` off $PATH (the main checkout).
    expect(toolsEntrypoint()).toMatch(/^\/.+\/tools$/);
    expect(() => agentRunCommand({ agent: "grok", account: "side", prompt: "x".repeat(9000) })).toThrow(
        "--prompt-file"
    );
    expect(withPidNote(`${TOOLS} 'grok' 'run' 'side'`, "/tmp/s.pid")).toBe(
        `printf '%s' $$ > '/tmp/s.pid'; ${TOOLS} 'grok' 'run' 'side'`
    );
});

// Restore reads these lines back from the shell journal. Replaying one verbatim sends the first prompt
// again, so restore needs the plain launcher to resume the session instead.
test("agentRunLauncher reads back the launcher of every line agentRunCommand writes", () => {
    const claude = agentRunCommand({
        agent: "claude",
        account: "work",
        model: "sonnet",
        crossMessages: true,
        prompt: 'Triage the issue; there\'s a problem with "shop" $(not run)',
    });

    expect(agentRunLauncher(withPidNote(claude, "/state/sessions/triage.pid"))).toEqual({
        agent: "claude",
        launcher: `${shellWord(toolsEntrypoint())} claude run work -m sonnet --cross-messages`,
    });
    expect(agentRunLauncher(agentRunCommand({ agent: "claude", account: "work", promptFile: "/tmp/p.md" }))).toEqual({
        agent: "claude",
        launcher: `${shellWord(toolsEntrypoint())} claude run work`,
    });
    expect(agentRunLauncher(agentRunCommand({ agent: "grok", account: "side", prompt: "go" }))).toEqual({
        agent: "grok",
        launcher: `${shellWord(toolsEntrypoint())} grok run side`,
    });
    expect(agentRunLauncher(agentRunCommand({ agent: "codex", account: "side" }))).toEqual({
        agent: "codex",
        launcher: `${shellWord(toolsEntrypoint())} codex run side`,
    });
});

test("agentRunLauncher leaves every other command alone", () => {
    expect(agentRunLauncher("tail -f /tmp/service.log")).toBeUndefined();
    expect(agentRunLauncher("tools cmux tree")).toBeUndefined();
    expect(agentRunLauncher(`${TOOLS} 'claude' 'run' 'work' | tee /tmp/x`)).toBeUndefined();
    expect(agentRunLauncher(`rm -rf /tmp/x; ${TOOLS} 'claude' 'run' 'work'`)).toBeUndefined();
});

test("the session account is exactly the one asked for; there is no default", () => {
    const account = (id: string, name: string, provider: string, enabled = true) => ({ id, name, provider, enabled });
    const accounts = [
        account("acc_work", "work", "anthropic-sub"),
        account("acc_shop", "shop", "anthropic-sub"),
        account("acc_side", "side", "grok-sub"),
        account("acc_off", "off", "grok-sub", false),
    ];
    const claude = sessionAgent("claude");
    const grok = sessionAgent("grok");

    expect(pickSessionAccount({ agent: claude, accounts, requested: "sho" }).name).toBe("shop");
    expect(pickSessionAccount({ agent: grok, accounts, requested: "acc_side" }).name).toBe("side");
    expect(() => pickSessionAccount({ agent: grok, accounts, requested: "work" })).toThrow(
        'no grok account matches "work"'
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
        { agent: "claude", repo: "demo", account: "work", prompt: "fix it", home: HOME, cwd: "/elsewhere" },
        io
    );

    expect(result).toEqual({
        agent: "claude",
        workspace: "workspace:9",
        surface: "surface:8",
        window: "window:1",
        windowId: "uuid-window:1",
        workspaceId: "uuid-workspace:9",
        surfaceId: "uuid-surface:8",
        tmuxSession: null,
        tmuxPane: null,
        tmuxSessionCreatedMs: null,
        cwd: DEMO,
        command: CLAUDE,
    });
    // The workspace is created in the window named by its UUID: a ref is renumbered at every cmux relaunch.
    expect(calls).toEqual([
        ["workspace", "create", "--window", "uuid-window:1", "--cwd", DEMO, "--focus", "false", "--command", CLAUDE],
    ]);
});

test("the new session's cmux UUIDs come from the create answer first, then the live tree, and never fail the start", async () => {
    const request = { agent: "claude" as const, repo: "demo", account: "work", home: HOME, cwd: "/elsewhere" };
    const lookups: string[] = [];
    const answered = harness({
        runJSON: async <T>(): Promise<T> =>
            ({
                workspace_ref: "workspace:9",
                surface_ref: "surface:8",
                window_ref: "window:1",
                workspace_id: "W-CREATE",
                surface_id: "S-CREATE",
            }) as T,
        surfaceIds: async (surface) => {
            lookups.push(surface);
            return null;
        },
    });
    expect(await startDevSession(request, answered.io)).toMatchObject({
        workspaceId: "W-CREATE",
        surfaceId: "S-CREATE",
    });
    expect(lookups).toEqual([]);

    const fromTree = await startDevSession(request, harness().io);
    expect(fromTree).toMatchObject({ workspaceId: "uuid-workspace:9", surfaceId: "uuid-surface:8" });

    const broken = harness({
        surfaceIds: async () => {
            throw new Error("cmux tree failed");
        },
    });
    expect(await startDevSession(request, broken.io)).toMatchObject({
        workspace: "workspace:9",
        workspaceId: null,
        surfaceId: null,
    });
});

test("a missing focused window uses an existing one, and creates a window only when none exist", async () => {
    const existing = harness({
        focusedWindow: async () => undefined,
        listWindows: async () => [{ ref: "window:4", id: "already", visible: true }],
    });
    await startDevSession(
        { agent: "claude", repo: "demo", account: "work", prompt: "fix it", home: HOME, cwd: "/elsewhere" },
        existing.io
    );
    expect(existing.calls.some((call) => call.includes("new-window"))).toBe(false);
    expect(existing.calls.find((call) => call[0] === "workspace")).toContain("already");

    let listed = 0;
    const created = harness({
        focusedWindow: async () => "  ",
        listWindows: async () => {
            listed += 1;
            return listed === 1 ? [] : [{ ref: "window:5", id: "new", visible: true }];
        },
    });
    await startDevSession(
        { agent: "claude", repo: "demo", account: "work", home: HOME, cwd: "/elsewhere" },
        created.io
    );
    expect(created.calls).toContainEqual(["ok", "new-window"]);
    expect(created.calls.find((call) => call[0] === "workspace")).toContain("new");
    expect(created.calls.find((call) => call[0] === "workspace")).toContain(`${TOOLS} 'claude' 'run' 'work'`);
});

test("--name goes to create, then the title is checked once, with no legacy rename", async () => {
    const { io, calls } = harness();
    const result = await startDevSession(
        {
            agent: "claude",
            repo: "demo",
            account: "work",
            prompt: "fix it",
            name: "Ship",
            home: HOME,
            cwd: "/elsewhere",
        },
        io
    );

    expect(result.workspace).toBe("workspace:9");
    expect(calls[0]).toContain("--name");
    expect(calls[0]).toContain("Ship");
    expect(calls[1]).toEqual(["title", "uuid-workspace:9", "uuid-window:1", "Ship"]);
    expect(calls.some((call) => call.includes("rename-workspace"))).toBe(false);
});

test("--via-tmux starts a login shell, send-keys the claude line, and attaches", async () => {
    const { io, calls } = harness();
    const result = await startDevSession(
        {
            agent: "claude",
            repo: "demo",
            account: "work",
            prompt: "fix it",
            viaTmux: true,
            home: HOME,
            cwd: "/elsewhere",
        },
        io
    );

    expect(result.tmuxSession).toBe("cmux-demo-ab12cd");
    // The agent's pane is recorded, so close types its exit there and nowhere else.
    expect(result.tmuxPane).toBe("%41");
    expect(result.tmuxSessionCreatedMs).toBe(1_760_000_000_000);
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
            {
                agent: "claude",
                repo: "demo",
                account: "work",
                prompt: "fix it",
                viaTmux: true,
                home: HOME,
                cwd: "/elsewhere",
            },
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
            {
                agent: "claude",
                repo: "demo",
                account: "work",
                prompt: "fix it",
                viaTmux: true,
                home: HOME,
                cwd: "/elsewhere",
            },
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
            {
                agent: "claude",
                repo: "demo",
                account: "work",
                prompt: "fix it",
                viaTmux: true,
                home: HOME,
                cwd: "/elsewhere",
            },
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
        startDevSession(
            { agent: "claude", repo: "demo", account: "work", prompt: "fix it", home: HOME, cwd: "/elsewhere" },
            io
        )
    ).rejects.toThrow("no workspace or surface ref");
    expect(calls.some((call) => call[0] === "tmux-kill")).toBe(false);
});

test("--focus true is forwarded, and a workspace with no surface is an error", async () => {
    const focused = harness();
    await startDevSession(
        {
            agent: "claude",
            repo: "/repo/app",
            account: "work",
            prompt: "fix it",
            focus: true,
            home: HOME,
            cwd: "/elsewhere",
        },
        focused.io
    );
    expect(focused.calls[0]).toContain("true");

    const blind = harness({
        runJSON: async <T>(): Promise<T> => ({ workspace_ref: "workspace:9", window_ref: "window:1" }) as T,
    });
    await expect(
        startDevSession({ agent: "claude", repo: "demo", account: "work", home: HOME, cwd: "/elsewhere" }, blind.io)
    ).rejects.toThrow("no workspace or surface");
});

function memoryStore(): SessionStore & { lines: SessionRecordLine[] } {
    const lines: SessionRecordLine[] = [];
    return {
        lines,
        read: () => [...lines],
        append: (line) => {
            lines.push(line);
        },
        pidFile: (name) => `/state/sessions/${name}.pid`,
        reserve: (_name, fn) => fn(),
    };
}

const ACCOUNTS = async () => ({
    accounts: [
        { id: "acc_work", name: "work", provider: "anthropic-sub", enabled: true },
        { id: "acc_side", name: "side", provider: "openai-sub", enabled: true },
    ],
});

test("agents new prints the result JSON, records the session, and rejects a bad focus first", async () => {
    const { io, calls } = harness();
    const store = memoryStore();
    const budgets = async () => [
        {
            name: "side",
            fiveHourLeft: 80,
            fiveHourResetsAt: null,
            weeklyLeft: 40,
            weeklyResetsAt: null,
            note: null,
        },
    ];
    const deps = { io, store, accounts: ACCOUNTS, budgets };
    const stdout = await captureStdout(() =>
        runSessionNew(
            "claude",
            { repo: "/repo/app", account: "work", prompt: "fix it", json: true, focus: "false" },
            deps
        )
    );
    const parsed = SafeJSON.parse(stdout, { strict: true });

    expect(parsed).toMatchObject({
        name: "claude-app-ab12cd",
        agent: "claude",
        account: "work",
        workspace: "workspace:9",
        surface: "surface:8",
        window: "window:1",
        tmuxSession: null,
        cwd: "/repo/app",
        command: withPidNote(
            agentRunCommand({ agent: "claude", account: "work", prompt: "fix it", crossMessages: true }),
            "/state/sessions/claude-app-ab12cd.pid"
        ),
    });
    expect(store.lines).toEqual([
        expect.objectContaining({ type: "created", name: "claude-app-ab12cd", workspace: "workspace:9" }),
    ]);

    process.exitCode = 0;
    await runSessionNew("codex", { repo: "/repo/app" }, deps);
    expect(process.exitCode).toBe(1);
    expect(calls.filter((call) => call[0] === "workspace")).toHaveLength(1);

    process.exitCode = 0;
    await runSessionNew("claude", { repo: "/repo/app", account: "work", focus: "maybe" }, deps);
    expect(process.exitCode).toBe(1);
    expect(calls.filter((call) => call[0] === "workspace")).toHaveLength(1);
});

test("a codex session runs tools codex run with its only account, and a taken name is refused", async () => {
    const { io, calls } = harness();
    const store = memoryStore();
    const deps = { io, store, accounts: ACCOUNTS };

    await captureStdout(() =>
        runSessionNew("codex", { repo: "/repo/app", account: "side", name: "Fix It", prompt: "go" }, deps)
    );
    expect(calls.find((call) => call[0] === "workspace")).toContain(
        withPidNote(`${TOOLS} 'codex' 'run' 'side' '--' 'go'`, "/state/sessions/fix-it.pid")
    );

    await expect(runSessionNew("codex", { repo: "/repo/app", account: "side", name: "fix it" }, deps)).rejects.toThrow(
        'a session named "fix-it" is already open'
    );
});

test("two starts with the same --name in parallel open one workspace and one record; the other is refused", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gt-cmux-sessions-"));

    try {
        const store = fileSessionStore(join(dir, "sessions.jsonl"));
        const { io, calls } = harness({
            runJSON: async <T>(args: string[]): Promise<T> => {
                calls.push(args);
                // Workspace creation takes a while: without the name lock both starts pass the check meanwhile.
                await Bun.sleep(40);
                return { workspace_ref: "workspace:9", surface_ref: "surface:8", window_ref: "window:1" } as T;
            },
        });
        const deps = { io, store, accounts: ACCOUNTS };
        const start = () => runSessionNew("codex", { repo: "/repo/app", account: "side", name: "Twin" }, deps);
        let results: PromiseSettledResult<void>[] = [];
        await captureStdout(async () => {
            results = await Promise.allSettled([start(), start()]);
        });

        expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
        expect(calls.filter((call) => call[0] === "workspace")).toHaveLength(1);
        expect(openSessions(store.read()).map((record) => record.name)).toEqual(["twin"]);

        // The lock is gone afterwards: a later start with a fresh name still works.
        await captureStdout(() => runSessionNew("codex", { repo: "/repo/app", account: "side", name: "Solo" }, deps));
        expect(openSessions(store.read()).map((record) => record.name)).toEqual(["twin", "solo"]);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("agents list renders recorded and adoptable sessions as aligned tables with headers", () => {
    const record = {
        type: "created" as const,
        name: "codex-app-ab12cd",
        title: "fixture-codex",
        state: "running" as const,
        lastActivityAt: "2026-10-08T17:02:00.000Z",
        agent: "codex" as const,
        account: "side",
        model: null,
        cwd: "/repo/app",
        window: "window:1",
        workspace: "workspace:9",
        surface: "surface:8",
        tmuxSession: null,
        pidFile: "/state/sessions/codex-app-ab12cd.pid",
        command: "tools codex run side",
        createdAt: "2026-10-08T17:00:00.000Z",
        createdBy: "agents-new" as const,
    };
    const adopted = {
        ...record,
        name: "0199aa11-2222-7333-8444-555566667777",
        agent: "grok" as const,
        workspace: "workspace:10",
        surface: "surface:21",
        cwd: "/repo/a-much-longer-folder",
        createdBy: "adopted" as const,
        surfaceId: "S21",
        sessionId: "0199aa11-2222-7333-8444-555566667777",
        tty: null,
    };
    const lines = formatSessionList({ open: [record], adoptable: [adopted] }).split("\n");

    expect(lines[0]).toMatch(/^Name\s+Title\s+Agent\s+State\s+Last activity/);
    expect(lines[2]).toContain("fixture-codex");
    expect(lines[2]).toContain("running");
    // People read local time in the table; the JSON keeps the ISO instant.
    expect(lines[2]).toContain(formatDateTime("2026-10-08T17:02:00.000Z", { absolute: "datetime" }));
    expect(lines[2]).not.toContain("2026-10-08T17:02:00.000Z");
    expect(lines[4]).toMatch(/^Adoptable session\s+Title\s+Agent\s+State\s+Last activity/);
    expect(lines[6].indexOf("surface:21")).toBe(lines[4].indexOf("Surface"));
    expect(formatSessionList({ open: [], adoptable: [adopted] }).split("\n")[0]).toMatch(/^Adoptable session/);
});

test("agents new advertises repo, account, prompt, tmux, focus, and json", async () => {
    const program = new Command().exitOverride();
    registerAgentsCommand(program);
    const agents = program.commands.find((command) => command.name() === "agents");
    const created = agents?.commands.find((command) => command.name() === "new");

    if (!created) {
        throw new Error("agents new was not registered");
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
            [
                "agents",
                "new",
                "claude",
                "--repo",
                "demo",
                "--account",
                "work",
                "--via-tmux",
                "--focus",
                "false",
                "--json",
            ],
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

test("agents status prints one table with every title, state, activity and one-line message, plus JSON", async () => {
    const program = new Command().exitOverride();
    registerAgentsCommand(program);
    const command = program.commands
        .find((entry) => entry.name() === "agents")
        ?.commands.find((entry) => entry.name() === "status");
    expect(command).toBeDefined();
    const row: inventory.ListedAgentSession = {
        type: "created",
        name: "fixture",
        sessionId: "fixture-id",
        agent: "grok",
        account: "work",
        model: null,
        cwd: "/fixture",
        window: "window:1",
        workspace: "workspace:1",
        surface: "surface:1",
        tmuxSession: null,
        pidFile: "",
        command: "",
        createdAt: "2026-01-01T00:00:00Z",
        createdBy: "adopted",
        title: "fixture-title",
        state: "held-message",
        lastActivityAt: "2026-01-01T01:00:00Z",
        lastMessage: "first line\nsecond line",
    };
    const read = spyOn(inventory, "sessionInventory").mockResolvedValue({ recorded: [], adoptable: [row] });
    try {
        const output = await captureStdout(() =>
            program.parseAsync(["agents", "status"], { from: "user" }).then(() => {})
        );
        expect(output).toContain("Title");
        expect(output).toContain("Last message");
        expect(output).toContain("fixture-title");
        expect(output).toContain("held-message");
        expect(output).toContain(formatDateTime("2026-01-01T01:00:00Z", { absolute: "datetime" }));
        expect(output).toContain("first line second line");
        const json = await captureStdout(() =>
            program.parseAsync(["agents", "status", "--json"], { from: "user" }).then(() => {})
        );
        expect(SafeJSON.parse(json)).toEqual([row]);
    } finally {
        read.mockRestore();
    }
});

describe("agents list: live agent tabs the surface journal does not know", () => {
    function listCommand(): Command {
        const program = new Command().exitOverride();
        registerAgentsCommand(program);

        return program;
    }

    async function runList(args: string[], coverage: () => Promise<JournalCoverage>) {
        const inventorySpy = spyOn(inventory, "sessionInventory").mockResolvedValue({ recorded: [], adoptable: [] });
        const coverageSpy = spyOn(coverageLive, "liveJournalCoverage").mockImplementation(coverage);
        const program = listCommand();
        const stderr: string[] = [];
        const original = process.stderr.write;
        process.stderr.write = ((chunk: string | Uint8Array, encoding?: unknown, callback?: unknown) => {
            stderr.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
            const done = typeof encoding === "function" ? encoding : callback;

            if (typeof done === "function") {
                (done as (error?: Error | null) => void)(null);
            }

            return true;
        }) as typeof process.stderr.write;

        try {
            const stdout = await captureStdout(() =>
                program.parseAsync(["agents", "list", ...args], { from: "user" }).then(() => {})
            );

            return { stdout, stderr: stderr.join(""), coverageCalls: coverageSpy.mock.calls.length };
        } finally {
            process.stderr.write = original;
            inventorySpy.mockRestore();
            coverageSpy.mockRestore();
        }
    }

    test("one dim line names the tabs that have no record", async () => {
        const { stderr } = await runList([], async () => ({
            tabs: 5,
            recorded: 3,
            agentTabs: 3,
            unrecordedAgentTabs: ["surface:7", "surface:11"],
        }));

        expect(stderr.trim().split("\n")).toHaveLength(1);
        expect(stderr).toContain("No surface-journal record for 2 live agent tabs (surface:7, surface:11)");
    });

    test("nothing is added when every agent tab is recorded", async () => {
        const { stderr, stdout } = await runList([], async () => ({
            tabs: 5,
            recorded: 5,
            agentTabs: 3,
            unrecordedAgentTabs: [],
        }));

        expect(stderr).not.toContain("surface-journal");
        expect(stdout).toContain("No open sessions from agents new");
    });

    test("--json stays pure JSON and does not read the live tabs", async () => {
        const { stderr, stdout, coverageCalls } = await runList(["--json"], async () => ({
            tabs: 1,
            recorded: 0,
            agentTabs: 1,
            unrecordedAgentTabs: ["surface:1"],
        }));

        expect(SafeJSON.parse(stdout)).toEqual([]);
        expect(stderr).toBe("");
        expect(coverageCalls).toBe(0);
    });

    test("a cmux that cannot list its tabs does not fail the list", async () => {
        const exitCode = process.exitCode;
        const { stderr, stdout } = await runList([], async () => {
            throw new Error("cmux tree failed (1): fixture");
        });

        expect(stdout).toContain("No open sessions from agents new");
        expect(stderr).not.toContain("surface-journal");
        expect(process.exitCode).toBe(exitCode);
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

test("without --account the error lists every account's 5h and weekly budget and tells an agent what to do", () => {
    const now = Date.parse("2026-10-08T20:00:00Z");
    const budgets = budgetsFromSnapshots(
        [
            { id: "acc_work", name: "work", provider: "anthropic-sub", enabled: true },
            { id: "acc_shop", name: "shop", provider: "anthropic-sub", enabled: true },
        ],
        [
            {
                provider: "anthropic-sub",
                accountId: "acc_work",
                accountName: "work",
                fetchedAt: "2026-10-08T19:59:00Z",
                limits: [
                    {
                        key: "five_hour",
                        label: "5h",
                        kind: "session",
                        percentUsed: 13,
                        resetsAt: "2026-10-08T22:00:00Z",
                    },
                    { key: "seven_day", label: "Weekly", kind: "weekly", percentUsed: 100 },
                    { key: "seven_day_opus", label: "7d Opus", kind: "weekly", scopeModel: "opus", percentUsed: 5 },
                ],
            },
        ]
    );

    expect(budgets).toEqual([
        expect.objectContaining({ name: "work", fiveHourLeft: 87, weeklyLeft: 0, note: null }),
        expect.objectContaining({ name: "shop", fiveHourLeft: null, weeklyLeft: null, note: "no usage reading" }),
    ]);

    const message = accountChoiceMessage({
        agent: "claude",
        budgets,
        retry: "tools cmux agents new claude --account <name>",
        now,
    });
    // One aligned table with a header, from the shared formatTable.
    expect(message).toMatch(/^ {2}Account\s+5h\s+Weekly\s+Note$/m);
    expect(message).toMatch(/^ {2}work\s+87% left \(resets in 2h 0m\)\s+0% left$/m);
    expect(message).toMatch(/^ {2}shop\s+\?\s+\?\s+no usage reading$/m);
    const lines = message.split("\n").filter((line) => /^ {2}(work|shop) /.test(line));
    expect(lines[0].indexOf("0% left", 30)).toBe(lines[1].lastIndexOf("?"));
    expect(message).toContain("AGENT INSTRUCTION: do not choose silently");
    expect(message).toContain("tell the user in your reply which one you picked and why");
});

test("budgets come from the poller's cache slice of the agent's provider, and an old reading says how old", () => {
    const now = Date.parse("2026-10-08T20:00:00Z");
    const reading = (accountId: string, accountName: string, fetchedAt: string) => ({
        provider: "anthropic-sub",
        accountId,
        accountName,
        fetchedAt,
        limits: [{ key: "five_hour", label: "5h", kind: "session" as const, percentUsed: 40 }],
    });
    const budgets = budgetsFromCache({
        provider: "anthropic-sub",
        accounts: [
            { id: "acc_work", name: "work", provider: "anthropic-sub", enabled: true },
            { id: "acc_shop", name: "shop", provider: "anthropic-sub", enabled: true },
            { id: "acc_side", name: "side", provider: "anthropic-sub", enabled: true },
        ],
        cache: {
            fetchedAt: "2026-10-08T19:59:00Z",
            providers: {
                "anthropic-sub": {
                    alias: "claude",
                    displayName: "Claude",
                    prominent: [],
                    accounts: [
                        reading("acc_work", "work", "2026-10-08T19:59:00Z"),
                        reading("acc_shop", "shop", "2026-10-08T17:00:00Z"),
                    ],
                },
                "openai-sub": {
                    alias: "codex",
                    displayName: "Codex",
                    prominent: [],
                    accounts: [{ ...reading("acc_side", "side", "2026-10-08T19:59:00Z"), provider: "openai-sub" }],
                },
            },
        },
        now,
    });

    expect(budgets).toEqual([
        expect.objectContaining({ name: "work", fiveHourLeft: 60, note: null }),
        expect.objectContaining({ name: "shop", fiveHourLeft: 60 }),
        expect.objectContaining({ name: "side", fiveHourLeft: null, note: "no usage reading" }),
    ]);
    expect(budgets[1].note).toContain("cached 3h 0m ago");
    expect(budgetsFromCache({ provider: "anthropic-sub", accounts: [], cache: null, now })).toEqual([]);
});

test("list omits screen probes while status retains held-message detection and tolerates failed reads", async () => {
    const live = {
        sessionId: "fixture-id",
        agent: "claude" as const,
        cwd: "/fixture",
        surface: {
            id: "surface-id",
            ref: "surface:1",
            title: "fixture",
            workspace: "workspace:1",
            workspaceId: "workspace-id",
            workspaceTitle: "fixture",
            window: "window:1",
            tty: "ttys001",
        },
    };
    const resolve = spyOn(transcripts, "resolveTranscript").mockRejectedValue(new Error("fixture transcript missing"));
    const screen = spyOn(cmuxCli, "runCmux").mockResolvedValue({ code: 0, stdout: "2 held messages", stderr: "" });
    try {
        const listed = await inventory.sessionInventory({ live: [live], records: [], readScreen: false });
        expect(screen).not.toHaveBeenCalled();
        expect(listed.adoptable[0].state).toBe("unknown");
        expect((await inventory.sessionInventory({ live: [live], records: [] })).adoptable[0].state).toBe(
            "held-message"
        );
        expect(screen).toHaveBeenCalledTimes(1);
        screen.mockResolvedValue({ code: 1, stdout: "", stderr: "unavailable" });
        expect((await inventory.readSessionDetails(live)).state).toBe("unknown");
    } finally {
        screen.mockRestore();
        resolve.mockRestore();
    }
});
