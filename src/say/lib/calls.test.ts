import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { runMigrations } from "@genesiscz/utils/database/migrations";
import {
    type AncestryFrame,
    agentFromAncestry,
    type CallerContext,
    describeAncestry,
    parsePidCommands,
    parsePidParents,
    walkParents,
} from "./caller";
import {
    CALLS_MIGRATIONS,
    computeStats,
    finishCall,
    isAttentionText,
    listCalls,
    NO_OUTCOME_AFTER_MS,
    recordCall,
    type SayCallRequest,
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

describe("process ancestry", () => {
    test("walks pid → ppid up to launchd and stops on a cycle", () => {
        const parents = parsePidParents("  100   90\n 90 80\n80 1\n1 0\nbad line\n");
        expect(walkParents(parents, 100)).toEqual([100, 90, 80]);
        expect(
            walkParents(
                new Map([
                    [5, 6],
                    [6, 5],
                ]),
                5
            )
        ).toEqual([5, 6]);
        expect(walkParents(parents, 4242)).toEqual([4242]);
    });

    test("reads full commands per pid and caps their length", () => {
        const commands = parsePidCommands(`  100 /bin/zsh -c 'x'\n90 ${"a".repeat(300)}\n`);
        expect(commands.get(100)).toBe("/bin/zsh -c 'x'");
        expect(commands.get(90)?.length).toBe(240);
    });

    test("names the agent from the nearest agent binary", () => {
        expect(agentFromAncestry(CLAUDE_CHAIN)).toBe("claude-code");
        expect(
            agentFromAncestry([
                { pid: 1, command: "/bin/zsh" },
                { pid: 2, command: "/opt/bin/codex exec" },
            ])
        ).toBe("codex");
        expect(agentFromAncestry([{ pid: 1, command: "/bin/zsh" }])).toBe("unknown");
    });

    test("describes the chain without launcher noise", () => {
        expect(describeAncestry(CLAUDE_CHAIN)).toBe(
            "zsh ← claude[64911] ← zsh ← src/claude/index.ts run work ← tools cc run work ← cmux"
        );
        expect(describeAncestry([])).toBe("");
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
