import { Database } from "bun:sqlite";
import { describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { whoIsCalling } from "@genesiscz/utils/agent/identity";
import { runMigrations } from "@genesiscz/utils/database/migrations";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import {
    type AncestryFrame,
    type CallerContext,
    callerContextOf,
    captureCallerContext,
    describeAncestry,
} from "./caller";
import {
    CALLS_MIGRATIONS,
    computeStats,
    finishCall,
    isAttentionText,
    listCalls,
    NO_OUTCOME_AFTER_MS,
    openCallsDb,
    recordCall,
    type SayCallOutcome,
    type SayCallRequest,
    withCallLog,
} from "./calls";
import { agentLabel, parseSince } from "./calls-view";

function openMemoryDb(): Database {
    const db = new Database(":memory:");
    runMigrations(db, CALLS_MIGRATIONS, { tableName: "say_calls" });
    return db;
}

const CLAUDE_CHAIN: AncestryFrame[] = [
    { pid: 7398, command: "/bin/zsh -c source /Users/x/.claude/shell-snapshots/snapshot.sh && eval 'tools say hi'" },
    { pid: 64911, command: "/Users/x/.bun/bin/claude --dangerously-skip-permissions" },
    { pid: 64829, command: "/bin/zsh -ic exec ccc" },
    { pid: 64706, command: "bun run /Users/x/Projects/GenesisTools/src/claude/index.ts run work" },
    {
        pid: 64704,
        command: "/Users/x/.genesis-tools/bin/gt-cc --preload /Users/x/Projects/GenesisTools/src/utils/bun/preload.ts",
    },
    {
        pid: 64703,
        command: "/Users/x/Applications/GenesisTools.app/Contents/MacOS/GenesisTools /Users/x/.genesis-tools/bin/gt-cc",
    },
    { pid: 64679, command: "bun /Users/x/Projects/GenesisTools/tools cc run work" },
    { pid: 63092, command: "/Applications/cmux.app/Contents/MacOS/cmux" },
];

function caller(overrides: Partial<CallerContext> = {}): CallerContext {
    return {
        agent: "claude-code",
        sessionId: "29fdd41b-ade0-40d6-8997-1b2c2af6641d",
        aiAgent: "claude-code_2-1-263_agent",
        account: "work",
        surfaceId: "EAD405E1-75FF-49D2-860A-03BBE0F30E11",
        workspaceId: "67547A08-D69E-4881-B969-9427064CFCEA",
        tabId: null,
        tmuxPane: null,
        termProgram: "ghostty",
        cwd: "/Users/x/Projects/GenesisTools",
        callerPid: 7398,
        ancestry: CLAUDE_CHAIN,
        ...overrides,
    };
}

function request(overrides: Partial<SayCallRequest> = {}): SayCallRequest {
    return {
        id: overrides.id ?? crypto.randomUUID(),
        ts: 1_000_000,
        text: "review done",
        argv: ["review done", "--app", "claude"],
        app: "claude",
        pid: 500,
        ...overrides,
    };
}

/** The agent the call log records for a caller whose environment names none, from a process chain alone. */
function agentOfChain(chain: AncestryFrame[]): string {
    const identity = whoIsCalling({ origin: "local", env: {} });
    identity.process = { pid: 1000, ancestry: chain };
    return callerContextOf(identity, { termProgram: null, callerPid: 1 }).agent;
}

describe("process ancestry", () => {
    test("names the agent from the nearest agent process", () => {
        expect(agentOfChain(CLAUDE_CHAIN)).toBe("claude-code");
        expect(
            agentOfChain([
                { pid: 1, command: "/bin/zsh" },
                { pid: 2, command: "/opt/bin/codex exec" },
            ])
        ).toBe("codex");
        expect(agentOfChain([{ pid: 1, command: "/bin/zsh" }])).toBe("unknown");
    });

    test("a helper binary of an agent and an agent's own MCP door name no agent", () => {
        expect(agentOfChain([{ pid: 1, command: "/opt/bin/codex-gateway serve" }])).toBe("unknown");
        expect(agentOfChain([{ pid: 1, command: "/Users/x/.bun/bin/claude mcp serve" }])).toBe("unknown");
    });

    test("describes the chain without launcher noise", () => {
        expect(describeAncestry(CLAUDE_CHAIN)).toBe(
            "zsh ← claude[64911] ← zsh ← src/claude/index.ts run work ← tools cc run work ← cmux"
        );
        expect(describeAncestry([])).toBe("");
    });
});

describe.skipIf(process.platform !== "darwin")("the caller's ancestry on live processes", () => {
    test("starts at our parent, stops before launchd and gives every frame a command or executable path", async () => {
        const caller = await captureCallerContext();

        expect(caller.ancestry.length).toBeGreaterThan(1);
        expect(caller.ancestry[0]?.pid).toBe(caller.callerPid);
        expect(caller.ancestry.map((frame) => frame.pid)).not.toContain(1);
        expect(caller.ancestry.map((frame) => frame.pid)).not.toContain(process.pid);

        for (const frame of caller.ancestry) {
            expect(frame.command).not.toBe("");
        }
    });

    test("walks the chain without ps, using executable paths for withheld argv", async () => {
        const spawn = spyOn(Bun, "spawn");
        const spawnSync = spyOn(Bun, "spawnSync");

        try {
            const caller = await captureCallerContext();
            expect(caller.ancestry.length).toBeGreaterThan(1);

            const psCalls = [...spawn.mock.calls, ...spawnSync.mock.calls].filter(
                (call) => Array.isArray(call[0]) && /(?:^|[/\\])ps$/.test(call[0][0])
            );
            expect(psCalls).toHaveLength(0);
        } finally {
            spawnSync.mockRestore();
            spawn.mockRestore();
        }
    });
});

describe("call log store", () => {
    test("foreground then speaker: caller kept, outcome filled in", () => {
        const db = openMemoryDb();
        const req = request({ text: "Attention please!! deploy failed" });
        recordCall(db, req, caller(), "started");

        let [row] = listCalls(db, { limit: 10 });
        expect(row.status).toBe("started");
        expect(row.attention).toBe(true);
        expect(row.caller.sessionId).toBe("29fdd41b-ade0-40d6-8997-1b2c2af6641d");
        expect(row.caller.ancestry).toHaveLength(8);

        finishCall(
            db,
            { ...req, argv: [...req.argv, "--wait"], pid: 501 },
            {
                status: "spoken",
                speakerPid: 501,
                provider: "xai",
                voice: "una",
                cacheHit: true,
                finishedAt: 1_002_500,
            }
        );

        [row] = listCalls(db, { limit: 10 });
        expect(row.status).toBe("spoken");
        expect(row.pid).toBe(500);
        expect(row.speakerPid).toBe(501);
        expect(row.argv).toEqual(["review done", "--app", "claude"]);
        expect(row.cacheHit).toBe(true);
        expect(row.finishedAt).toBe(1_002_500);
    });

    test("speaker before foreground: the row survives and the caller lands later", () => {
        const db = openMemoryDb();
        const req = request();
        finishCall(
            db,
            { ...req, pid: 501 },
            { status: "failed", speakerPid: 501, error: "boom", finishedAt: 1_000_900 }
        );

        let [row] = listCalls(db, { limit: 10 });
        expect(row.status).toBe("failed");
        expect(row.caller.agent).toBe("unknown");

        recordCall(db, req, caller(), "started");
        [row] = listCalls(db, { limit: 10 });
        expect(row.status).toBe("failed");
        expect(row.error).toBe("boom");
        expect(row.caller.agent).toBe("claude-code");
        expect(row.pid).toBe(500);
        expect(listCalls(db, { limit: 10 })).toHaveLength(1);
    });

    test("lists newest N oldest-first and filters by attention, text and time", () => {
        const db = openMemoryDb();

        for (let i = 0; i < 5; i++) {
            recordCall(
                db,
                request({ ts: 1000 + i, text: i === 3 ? "Attention please!! look" : `call ${i}` }),
                caller(),
                "started"
            );
        }

        expect(listCalls(db, { limit: 2 }).map((r) => r.ts)).toEqual([1003, 1004]);
        expect(listCalls(db, { limit: 10, attention: true }).map((r) => r.ts)).toEqual([1003]);
        expect(listCalls(db, { limit: 10, grep: "CALL 1" }).map((r) => r.ts)).toEqual([1001]);
        expect(listCalls(db, { limit: 10, sinceMs: 1003 }).map((r) => r.ts)).toEqual([1003, 1004]);
    });

    test("attention marker is case-insensitive", () => {
        expect(isAttentionText("ATTENTION please!! x")).toBe(true);
        expect(isAttentionText("all done")).toBe(false);
    });
});

describe("stats", () => {
    test("aggregates outcomes, agents, apps, providers, sessions, phrases and latency", () => {
        const db = openMemoryDb();
        const now = Date.UTC(2026, 8, 16, 12, 0, 0);
        const spoken = (id: string, ts: number, provider: string, cacheHit: boolean, latency: number) => {
            const req = request({ id, ts, text: "done" });
            recordCall(db, req, caller(), "started");
            finishCall(db, req, { status: "spoken", speakerPid: 9, provider, cacheHit, finishedAt: ts + latency });
        };

        spoken("a", now - 1000, "xai", true, 1000);
        spoken("b", now - 2000, "xai", false, 3000);
        spoken("c", now - 3000, "macos", false, 500);
        recordCall(
            db,
            request({ id: "d", ts: now - 4000, text: "Attention please!! x", app: "codex" }),
            caller({ agent: "codex", sessionId: "s2", workspaceId: null }),
            "muted"
        );
        recordCall(db, request({ id: "e", ts: now - NO_OUTCOME_AFTER_MS - 1 }), caller(), "started");
        recordCall(db, request({ id: "f", ts: now - 10 }), caller(), "started");

        const stats = computeStats(db, { now, top: 2 });
        expect(stats.total).toBe(6);
        expect(stats.attention).toBe(1);
        expect(stats.noOutcome).toBe(1);
        expect(stats.byStatus).toEqual([
            { key: "spoken", count: 3 },
            { key: "started", count: 2 },
            { key: "muted", count: 1 },
        ]);
        expect(stats.byAgent).toEqual([
            { key: "claude-code", count: 5, attention: 0 },
            { key: "codex", count: 1, attention: 1 },
        ]);
        expect(stats.byApp.map((a) => a.key)).toEqual(["claude", "codex"]);
        expect(stats.byProvider).toEqual([
            { key: "xai", count: 2, cacheHits: 1, fallbacks: 0 },
            { key: "macos", count: 1, cacheHits: 0, fallbacks: 0 },
        ]);
        expect(stats.byDay.reduce((sum, d) => sum + d.count, 0)).toBe(6);
        expect(stats.byHour.reduce((sum, c) => sum + c, 0)).toBe(6);
        expect(stats.topSessions).toHaveLength(2);
        expect(stats.topSessions[0]).toMatchObject({
            sessionId: "29fdd41b-ade0-40d6-8997-1b2c2af6641d",
            agent: "claude-code",
            count: 5,
            lastTs: now - 10,
        });
        expect(stats.topTexts).toEqual([
            { text: "done", count: 3 },
            { text: "review done", count: 2 },
        ]);
        expect(stats.latency).toEqual({ count: 3, medianMs: 1000, p90Ms: 3000, maxMs: 3000 });
    });

    test("--since narrows every aggregate", () => {
        const db = openMemoryDb();
        recordCall(db, request({ id: "old", ts: 100 }), caller(), "muted");
        recordCall(db, request({ id: "new", ts: 200 }), caller(), "muted");

        const stats = computeStats(db, { sinceMs: 150, now: 1000 });
        expect(stats.total).toBe(1);
        expect(stats.firstTs).toBe(200);
        expect(stats.byAgent[0].count).toBe(1);
        expect(stats.latency).toBeNull();
    });
});

describe("withCallLog", () => {
    test("writes failed when work returns without an outcome", async () => {
        const finished: SayCallOutcome[] = [];
        const req = request();
        await withCallLog(req, async () => "ok", {
            finish: (_request, outcome) => {
                finished.push(outcome);
            },
        });
        expect(finished).toEqual([
            {
                status: "failed",
                error: "speaker exited without recording an outcome",
                speakerPid: process.pid,
            },
        ]);
    });

    test("writes the set outcome on success", async () => {
        const finished: SayCallOutcome[] = [];
        const req = request();
        await withCallLog(
            req,
            async (setOutcome) => {
                setOutcome({ status: "spoken", provider: "macos", cacheHit: false });
            },
            {
                finish: (_request, outcome) => {
                    finished.push(outcome);
                },
            }
        );
        expect(finished).toEqual([
            {
                status: "spoken",
                provider: "macos",
                cacheHit: false,
                speakerPid: process.pid,
            },
        ]);
    });

    test("still writes failed when work throws", async () => {
        const finished: SayCallOutcome[] = [];
        const req = request();
        await expect(
            withCallLog(
                req,
                async () => {
                    throw new Error("boom");
                },
                {
                    finish: (_request, outcome) => {
                        finished.push(outcome);
                    },
                }
            )
        ).rejects.toThrow("boom");
        expect(finished).toEqual([
            {
                status: "failed",
                error: "boom",
                speakerPid: process.pid,
            },
        ]);
    });
});

describe("view helpers", () => {
    test("parseSince reads durations and dates, rejects noise", () => {
        const now = 10_000_000;
        expect(parseSince(undefined, now)).toBeUndefined();
        expect(parseSince("7d", now)).toBe(now - 7 * 24 * 3600 * 1000);
        expect(parseSince("90m", now)).toBe(now - 90 * 60 * 1000);
        expect(parseSince("2026-01-02", now)).toBe(Date.parse("2026-01-02"));
        expect(parseSince("yesterday-ish", now)).toBeNull();
    });

    test("agentLabel shortens claude and hides unknown", () => {
        expect(agentLabel("claude-code")).toBe("claude");
        expect(agentLabel("grok")).toBe("grok");
        expect(agentLabel("unknown")).toBe("—");
    });
});

// Characterization tests (2026-11-04): what `tools say` records about its caller today, before the agent-context
// gatherers are unified. `captureCallerContext` reads the live process env and the live process chain, so each
// case clears every variable it reads and sets only its own.
const CALLER_ENV_KEYS = [
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDECODE",
    "CODEX_CI",
    "CODEX_THREAD_ID",
    "GROK_SESSION_ID",
    "COPILOT_AGENT_SESSION_ID",
    "AI_AGENT",
    "TOOLS_CLAUDE_ACCOUNT",
    "TOOLS_CODEX_ACCOUNT",
    "TOOLS_GROK_ACCOUNT",
    "CMUX_SURFACE_ID",
    "CMUX_WORKSPACE_ID",
    "CMUX_TAB_ID",
    "TMUX_PANE",
    "TERM_PROGRAM",
] as const;

async function captureWith(vars: Partial<Record<(typeof CALLER_ENV_KEYS)[number], string>>) {
    const cleared = Object.fromEntries(CALLER_ENV_KEYS.map((key) => [key, undefined]));
    let caller: CallerContext | undefined;
    await env.testing.withOverrides({ ...cleared, ...vars }, async () => {
        caller = await captureCallerContext();
    });

    if (!caller) {
        throw new Error("captureCallerContext did not run");
    }

    return caller;
}

describe("characterization: the caller `tools say` records", () => {
    test("the env host wins over the process chain", async () => {
        const caller = await captureWith({ GROK_SESSION_ID: "grok-session-1" });
        expect(caller.agent).toBe("grok");
        expect(caller.sessionId).toBe("grok-session-1");
    });

    test("the outer host of two in the env wins, with its session id", async () => {
        const caller = await captureWith({
            CLAUDE_CODE_SESSION_ID: "claude-session-1",
            CLAUDECODE: "1",
            CODEX_THREAD_ID: "codex-thread-1",
        });
        expect(caller.agent).toBe("claude-code");
        expect(caller.sessionId).toBe("claude-session-1");
    });

    test("with no host in the env the agent is whatever the process chain names, and the session is null", async () => {
        const caller = await captureWith({});
        expect(caller.agent).toBe(agentOfChain(caller.ancestry));
        expect(caller.sessionId).toBeNull();
        expect(caller.callerPid).toBe(process.ppid);
        expect(caller.cwd).toBe(process.cwd());
    });

    test("the terminal ids come from the cmux, tmux and terminal variables", async () => {
        const caller = await captureWith({
            CMUX_SURFACE_ID: "surface-1",
            CMUX_WORKSPACE_ID: "workspace-1",
            CMUX_TAB_ID: "tab-1",
            TMUX_PANE: "%3",
            TERM_PROGRAM: "ghostty",
        });
        expect(caller).toMatchObject({
            surfaceId: "surface-1",
            workspaceId: "workspace-1",
            tabId: "tab-1",
            tmuxPane: "%3",
            termProgram: "ghostty",
        });
    });

    test("a terminal variable that is not set is null", async () => {
        const caller = await captureWith({});
        expect(caller).toMatchObject({
            surfaceId: null,
            workspaceId: null,
            tabId: null,
            tmuxPane: null,
            termProgram: null,
            account: null,
        });
    });

    // Changed 2026-11-04 (spec decision on candidate 5): the account is the stamp of the caller's OWN harness, so a
    // Codex or Grok caller has an account and a caller the environment does not name has none. It was
    // TOOLS_CLAUDE_ACCOUNT whatever the host was.
    test("the account is the stamp of the caller's own harness", async () => {
        expect((await captureWith({ CLAUDECODE: "1", TOOLS_CLAUDE_ACCOUNT: "work" })).account).toBe("work");
        expect((await captureWith({ CODEX_THREAD_ID: "t1", TOOLS_CODEX_ACCOUNT: "side" })).account).toBe("side");
        expect((await captureWith({ GROK_SESSION_ID: "g1", TOOLS_GROK_ACCOUNT: "shop" })).account).toBe("shop");
    });

    test("another harness's stamp is no account, and a caller the environment does not name has none", async () => {
        expect((await captureWith({ GROK_SESSION_ID: "g1", TOOLS_CLAUDE_ACCOUNT: "work" })).account).toBeNull();
        expect((await captureWith({ TOOLS_CLAUDE_ACCOUNT: "work" })).account).toBeNull();
    });

    // Changed 2026-11-04 (defect 4 of the W1 list: a label read for Codex, which has none): a Codex caller's label is
    // null. It was AI_AGENT, so the call log disagreed with every other record of the same caller.
    test("aiAgent is the host's label: AI_AGENT for Claude, Grok and no host, null for Codex", async () => {
        expect((await captureWith({ CLAUDECODE: "1", AI_AGENT: "label" })).aiAgent).toBe("label");
        expect((await captureWith({ GROK_SESSION_ID: "g1", AI_AGENT: "label" })).aiAgent).toBe("label");
        expect((await captureWith({ AI_AGENT: "label" })).aiAgent).toBe("label");
        expect((await captureWith({ CODEX_CI: "1", AI_AGENT: "label" })).aiAgent).toBeNull();
    });

    test("the agent comes from the ancestry binary name only when the env names none", () => {
        const chain: AncestryFrame[] = [
            { pid: 30, command: "/bin/zsh -c tools say hi" },
            { pid: 20, command: "/opt/homebrew/bin/codex exec" },
            { pid: 10, command: "/Users/x/.bun/bin/claude --resume" },
        ];
        // The nearest agent binary wins, so Codex running inside Claude reads as Codex here.
        expect(agentOfChain(chain)).toBe("codex");
        expect(agentOfChain([...chain].reverse())).toBe("claude-code");
    });
});

test("the on-disk say call row stores caller fields and JSON argv and ancestry", () => {
    const path = join(mkdtempSync(join(tmpdir(), "say-row-")), "calls.db");
    const db = openCallsDb(path);
    const req = request({ id: "call-1", argv: ["hello", "--app", "codex"], text: "hello", app: "codex" });
    const who = caller({
        agent: "codex",
        sessionId: "thread-1",
        aiAgent: "label",
        account: "work",
        ancestry: [{ pid: 10, command: "codex" }],
    });
    try {
        recordCall(db, req, who, "started");
    } finally {
        db.close();
    }
    const reopened = new Database(path, { readonly: true });
    try {
        const row = reopened.query("SELECT * FROM calls WHERE id = ?").get("call-1");
        expect(row).toEqual({
            id: "call-1",
            ts: 1000000,
            text: "hello",
            argv: SafeJSON.stringify(["hello", "--app", "codex"]),
            app: "codex",
            attention: 0,
            agent: "codex",
            session_id: "thread-1",
            ai_agent: "label",
            account: "work",
            surface_id: who.surfaceId,
            workspace_id: who.workspaceId,
            tab_id: null,
            tmux_pane: null,
            term_program: "ghostty",
            cwd: who.cwd,
            caller_pid: 7398,
            ancestry: SafeJSON.stringify([{ pid: 10, command: "codex" }]),
            pid: 500,
            speaker_pid: null,
            status: "started",
            provider: null,
            voice: null,
            cache_hit: null,
            fallback_from: null,
            error: null,
            finished_at: null,
        });
    } finally {
        reopened.close();
    }
});

// Changed 2026-11-04 (spec: terminal and account are facets of the identity, and a blank value names nothing, as a
// whitespace-only TMUX_PANE already did for send-self): a blank or whitespace cmux, tmux or account value is recorded
// as null. It was recorded as given (an empty string, or the whitespace untrimmed). The label and the terminal program
// are no facet and keep their old answer.
describe("characterization: blank labels and terminal ids in say callers", () => {
    test("empty account and terminal values are recorded as null, an empty label and program as given", async () => {
        const caller = await captureWith({
            CLAUDE_CODE_SESSION_ID: "thread-1",
            AI_AGENT: "",
            TOOLS_CLAUDE_ACCOUNT: "",
            CMUX_SURFACE_ID: "",
            CMUX_WORKSPACE_ID: "",
            CMUX_TAB_ID: "",
            TMUX_PANE: "",
            TERM_PROGRAM: "",
        });
        expect(caller).toMatchObject({
            agent: "claude-code",
            sessionId: "thread-1",
            aiAgent: "",
            account: null,
            surfaceId: null,
            workspaceId: null,
            tabId: null,
            tmuxPane: null,
            termProgram: "",
        });
    });

    test("whitespace account and terminal values are recorded as null, a whitespace label and program as given", async () => {
        const value = " \t ";
        const caller = await captureWith({
            GROK_SESSION_ID: " g1 ",
            AI_AGENT: value,
            TOOLS_GROK_ACCOUNT: value,
            CMUX_SURFACE_ID: value,
            CMUX_WORKSPACE_ID: value,
            CMUX_TAB_ID: value,
            TMUX_PANE: value,
            TERM_PROGRAM: value,
        });
        expect(caller).toMatchObject({
            agent: "grok",
            sessionId: "g1",
            aiAgent: value,
            account: null,
            surfaceId: null,
            workspaceId: null,
            tabId: null,
            tmuxPane: null,
            termProgram: value,
        });
    });

    test("a workspace and a tab are kept only beside a surface, and trimmed", async () => {
        expect(await captureWith({ CMUX_WORKSPACE_ID: "workspace-1", CMUX_TAB_ID: "tab-1" })).toMatchObject({
            surfaceId: null,
            workspaceId: null,
            tabId: null,
        });
        expect(await captureWith({ CMUX_SURFACE_ID: " surface-1 ", CMUX_WORKSPACE_ID: " workspace-1 " })).toMatchObject(
            { surfaceId: "surface-1", workspaceId: "workspace-1", tabId: null }
        );
    });
});
