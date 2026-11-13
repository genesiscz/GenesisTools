import type { AgentInfo, ToolCallInput } from "claude-code";
import { expect, mock, test } from "claude-code/testing";
import { agentClock, agentClockTime, noteAgentActive } from "../hooks/agent-clock";
import { forgetAgentDetails, metas } from "../hooks/agents-band";
import { forgetLoopModels, loopModel, loopModelOf, noteLoopModel } from "../hooks/loop-model";
import {
    agentsNamed,
    decideResume,
    forgetResumeGuard,
    guardResume,
    idleBucket,
    lastContextOf,
    recipientOf,
    resumeGuard,
} from "../hooks/resume-guard";
import { forgetSettings, type Host } from "../hooks/shared";

const MINUTE = 60_000;
const SESSION_DIR = "/home/test/.claude/projects/-work-app/sess-1";

interface Fixture {
    host: Host;
    agents: AgentInfo[];
    lines: { path: string; record: Record<string, unknown> }[];
    files: Map<string, { text: string; mtimeMs: number }>;
}

/** A session in /work/app with the resume guard on (or as `mods` says), its agents, and the lines it appended. */
function fixture(mods: Record<string, unknown> = { resumeGuard: { enabled: true } }): Fixture {
    forgetSettings();
    forgetAgentDetails();
    forgetResumeGuard();
    forgetLoopModels();
    const agents: AgentInfo[] = [];
    const lines: Fixture["lines"] = [];
    const files = new Map<string, { text: string; mtimeMs: number }>([
        [`${SESSION_DIR}.jsonl`, { text: "", mtimeMs: Date.now() }],
    ]);
    const done = (stdout: string, exitCode: number) => ({
        exitCode,
        stdout,
        stderr: "",
        isStdoutTruncated: false,
        isStderrTruncated: false,
    });
    const host: Host = {
        async run(argv) {
            const file = files.get(argv.at(-1) ?? "");

            return argv[0] === "tail" && file ? done(file.text, 0) : done("", 1);
        },
        async read(path) {
            if (path === "/home/test/.genesis-tools/agents/hooks.json") {
                return JSON.stringify({ mods });
            }

            throw new Error(`ENOENT ${path}`);
        },
        async write() {},
        async append(path, text) {
            for (const line of text.split("\n").filter(Boolean)) {
                lines.push({ path, record: JSON.parse(line) });
            }
        },
        async list() {
            return [];
        },
        async exists(path) {
            return files.has(path);
        },
        async stat(path) {
            const file = files.get(path);

            if (!file) {
                throw new Error(`ENOENT ${path}`);
            }

            return { kind: "file", size: file.text.length, mtimeMs: file.mtimeMs, isLink: false };
        },
        env: async (name) => (name === "HOME" ? "/home/test" : undefined),
        cwd: async () => "/work/app",
        sessionId: async () => "sess-1",
        model: async () => "claude-test-model",
        messages: async () => [],
        agents: async () => agents,
        every() {},
        storeGet: async () => undefined,
        async storeSet() {},
        status() {},
        fill: async () => ({}),
        submit: async () => ({}),
        openPane: async () => ({}),
        togglePane: async () => ({}),
        closePane: async () => ({}),
        copy: async () => ({ isCopied: true }),
        scroll: async () => ({}),
        openUrl: async () => ({}),
        toast() {},
        redraw() {},
    };

    return { host, agents, lines, files };
}

function agent(id: string, fields: Partial<AgentInfo> = {}): AgentInfo {
    return { id, description: "Read the parser", type: "general-purpose", status: "completed", name: id, ...fields };
}

/** The agent's last model call held `tokens`, `minutesAgo` minutes ago. */
function ranBefore(host: Host, agentId: string, minutesAgo: number, tokens?: number): void {
    if (tokens !== undefined) {
        resumeGuard.afterStep?.(
            host,
            { agentId },
            {
                model: "fixture-model",
                input_tokens: 10,
                cache_read_input_tokens: tokens - 1_010,
                cache_creation_input_tokens: 500,
                output_tokens: 500,
            }
        );
    }

    noteAgentActive(agentId, Date.now() - minutesAgo * MINUTE);
}

function send(to: string, message: string | { type: "shutdown_request" } = "Check one more file"): ToolCallInput {
    return { tool: "SendMessage", tool_use_id: "toolu_send", to, message };
}

function guardLog(lines: Fixture["lines"]): Record<string, unknown>[] {
    return lines.filter((line) => line.path.endsWith("/mods-log/resume-guard.jsonl")).map((line) => line.record);
}

function resumeEvents(lines: Fixture["lines"], metric = "agent.resume"): Record<string, unknown>[] {
    return lines
        .filter((line) => line.path.includes("/metrics/spool/mods-"))
        .map((line) => line.record)
        .filter((record) => record.metric === metric);
}

/** The agent's next model response after a message: `cacheRead` of its context came from the cache. */
function responds(host: Host, agentId: string, usage: { cacheRead: number; cacheWrite: number }): void {
    resumeGuard.afterStep?.(
        host,
        { agentId },
        {
            model: "fixture-model-2",
            input_tokens: 3,
            cache_read_input_tokens: usage.cacheRead,
            cache_creation_input_tokens: usage.cacheWrite,
            output_tokens: 200,
        }
    );
}

/** Lets the result event's appends, started by `afterStep` without a wait, land. */
async function settled(): Promise<void> {
    for (let i = 0; i < 20; i++) {
        await Promise.resolve();
    }
}

test("resume guard: a cold, large agent is refused once, and the same send then goes through", async () => {
    const { host, agents, lines } = fixture();
    agents.push(agent("scout"));
    ranBefore(host, "scout", 7, 240_000);

    const refusal = await guardResume(host, send("scout"));
    expect(refusal).toContain("Not sent (resume guard, once): scout is idle for 7 min 0 s");
    expect(refusal).toContain("holds about 240k tokens of context");
    expect(refusal).toContain("A fresh agent starts at about 66k tokens.");
    expect(refusal).toContain("Thresholds: mods.resumeGuard.idleSeconds=295, mods.resumeGuard.minTokens=150000.");
    expect(refusal).not.toContain("$");
    expect(await guardResume(host, send("scout"))).toBeUndefined();
    expect(await guardResume(host, send("scout"))).toBeUndefined();
    expect(guardLog(lines).map((record) => [record.decision, record.reason])).toEqual([
        ["refused", "cold-and-large"],
        ["passed-after-refusal", "sent-again"],
        ["passed-after-refusal", "sent-again"],
    ]);
    expect(resumeEvents(lines).map((event) => event.dims)).toEqual([
        {
            session: "sess-1",
            agent: "scout",
            agentType: "general-purpose",
            kind: "subagent",
            idleSeconds: "5-15m",
            outcome: "refused",
            model: "fixture-model",
            name: "scout",
        },
        expect.objectContaining({ outcome: "resent" }),
        expect.objectContaining({ outcome: "resent" }),
    ]);
    expect(resumeEvents(lines)[0]?.value).toBe(240_000);
    expect(resumeEvents(lines)[0]?.context).toEqual({
        idleSeconds: 420,
        contextTokens: 240_000,
        thresholds: { idleSeconds: 295, minTokens: 150_000 },
    });
    const defines = lines.filter((line) => line.record.define !== undefined);
    expect(defines.map((line) => line.record.define)).toEqual([
        expect.objectContaining({ project: "agent-context", metric: "agent.resume", unit: "tokens" }),
    ]);
});

test("resume guard: the mark clears once the agent ran again, and a later cold send is refused again", async () => {
    const { host, agents, lines } = fixture();
    agents.push(agent("scout"));
    ranBefore(host, "scout", 10, 300_000);
    const refusedAt = Date.now();

    expect(await guardResume(host, send("scout"))).toContain("Not sent");
    // The agent answers the message it got some other way: one tool call of its own after the refusal.
    noteAgentActive("scout", refusedAt + 1_000);
    await agentClock.afterTool?.(host, { tool: "Bash", tool_use_id: "toolu_a", command: "true", agentId: "scout" });

    try {
        agentClockTime.now = () => refusedAt + 20 * MINUTE;
        expect(await guardResume(host, send("scout"))).toContain("is idle for 1");
    } finally {
        agentClockTime.now = () => Date.now();
    }

    expect(guardLog(lines).map((record) => record.reason)).toEqual(["cold-and-large", "cold-and-large"]);
});

test("resume guard: a warm agent, a small one and a running one pass", async () => {
    const { host, agents, lines } = fixture();
    agents.push(agent("warm"), agent("small"), agent("busy", { status: "running" }));
    ranBefore(host, "warm", 4, 400_000);
    ranBefore(host, "small", 40, 90_000);
    ranBefore(host, "busy", 30, 500_000);

    expect(await guardResume(host, send("warm"))).toBeUndefined();
    expect(await guardResume(host, send("small"))).toBeUndefined();
    expect(await guardResume(host, send("busy"))).toBeUndefined();
    expect(guardLog(lines).map((record) => record.reason)).toEqual(["warm", "small", "running"]);
    expect(resumeEvents(lines).map((event) => (event.dims as Record<string, unknown>).outcome)).toEqual([
        "passed-warm",
        "passed-small",
        "passed-warm",
    ]);
});

test("resume guard: an unknown size passes and is logged; the transcript's last usage counts when there", async () => {
    const { host, agents, lines, files } = fixture();
    agents.push(agent("quiet"), agent("noted"));
    ranBefore(host, "quiet", 20);
    ranBefore(host, "noted", 20);
    const usage = {
        input_tokens: 4,
        cache_read_input_tokens: 180_000,
        cache_creation_input_tokens: 900,
        output_tokens: 96,
    };
    files.set(`${SESSION_DIR}/subagents/agent-noted.jsonl`, {
        text: `{"half a row"}\n${JSON.stringify({ message: { role: "assistant", usage } })}\n{"type":"user","message":{}}\n`,
        mtimeMs: Date.now() - 20 * MINUTE,
    });

    expect(await guardResume(host, send("quiet"))).toBeUndefined();
    expect(guardLog(lines).at(-1)).toMatchObject({ reason: "size-unknown", tokens: null, transcript: null });
    expect(resumeEvents(lines)).toEqual([]);
    expect(await guardResume(host, send("noted"))).toContain("holds about 181k tokens");
    expect(guardLog(lines).at(-1)).toMatchObject({
        reason: "cold-and-large",
        tokens: 181_000,
        tokensFrom: "transcript",
        idleFrom: "clock",
    });
});

test("resume guard: a finished agent the engine no longer lists is found by its transcript and refused once", async () => {
    const { host, files, lines } = fixture();
    files.set(`${SESSION_DIR}/subagents/agent-a1b2c3d4e5f60789.jsonl`, {
        text: `${JSON.stringify({ message: { usage: { input_tokens: 180_000, output_tokens: 10 } } })}\n`,
        mtimeMs: Date.now() - 9 * MINUTE,
    });

    expect(await guardResume(host, send("a1b2c3d4e5f60789"))).toContain("is idle for 9 min");
    expect(await guardResume(host, send("a1b2c3d4e5f60789"))).toBeUndefined();
    expect(guardLog(lines).map((record) => record.decision)).toEqual(["refused", "passed-after-refusal"]);
    // The send after the refusal is counted too, though the clock never saw this agent.
    expect(resumeEvents(lines).map((event) => (event.dims as { outcome: string }).outcome)).toEqual([
        "refused",
        "resent",
    ]);
    // A name that is no agent id and has no transcript is still another session's.
    expect(await guardResume(host, send("some-other-session"))).toBeUndefined();
    expect(guardLog(lines).at(-1)).toMatchObject({ decision: "skipped", reason: "not-an-agent" });
});

test("resume guard: after a reload the transcript's mtime gives the idle time", async () => {
    const { host, agents, files, lines } = fixture();
    agents.push(agent("wf-agent"));
    files.set(`${SESSION_DIR}/subagents/agent-wf-agent.jsonl`, {
        text: `${JSON.stringify({ message: { usage: { input_tokens: 200_000, output_tokens: 10 } } })}\n`,
        mtimeMs: Date.now() - 12 * MINUTE,
    });

    expect(await guardResume(host, send("wf-agent"))).toContain("is idle for 12 min");
    // The refusal is counted with the numbers the transcript gave; the model is unknown until a response is seen.
    expect(resumeEvents(lines)).toEqual([
        expect.objectContaining({
            value: 200_010,
            dims: expect.objectContaining({ outcome: "refused", model: null, name: "wf-agent", idleSeconds: "5-15m" }),
            context: { idleSeconds: 720, contextTokens: 200_010, thresholds: { idleSeconds: 295, minTokens: 150_000 } },
        }),
    ]);
});

test("resume guard: an override's next response is one result event, a miss, and a second response adds none", async () => {
    const { host, agents, lines } = fixture();
    agents.push(agent("scout"));
    ranBefore(host, "scout", 7, 240_000);

    expect(await guardResume(host, send("scout"))).toContain("Not sent");
    expect(await guardResume(host, send("scout"))).toBeUndefined();
    expect(resumeEvents(lines, "agent.resume.result")).toEqual([]);

    responds(host, "scout", { cacheRead: 0, cacheWrite: 239_000 });
    responds(host, "scout", { cacheRead: 239_000, cacheWrite: 900 });
    await settled();
    const results = resumeEvents(lines, "agent.resume.result");
    expect(results).toEqual([
        {
            v: 1,
            project: "agent-context",
            metric: "agent.resume.result",
            at: expect.any(Number),
            value: 239_000,
            dims: {
                session: "sess-1",
                agent: "scout",
                agentType: "general-purpose",
                kind: "subagent",
                model: "fixture-model-2",
                idleSeconds: "5-15m",
                decision: "resent",
                cache: "miss",
            },
            context: {
                idleSeconds: 420,
                contextBefore: 240_000,
                input: 3,
                cacheRead: 0,
                cacheWrite: 239_000,
                output: 200,
            },
        },
    ]);
    const defines = lines.filter((line) => line.record.define !== undefined).map((line) => line.record.define);
    expect(defines).toContainEqual(
        expect.objectContaining({
            metric: "agent.resume.result",
            dims: ["session", "agent", "agentType", "kind", "model", "idleSeconds", "decision", "cache"],
        })
    );
    expect(loopModelOf("scout")).toBe("fixture-model-2");
});

test("resume guard: a warm pass's next response is a hit, a partial read is partial", async () => {
    const { host, agents, lines } = fixture();
    agents.push(agent("warm"), agent("half"));
    ranBefore(host, "warm", 4, 400_000);
    ranBefore(host, "half", 40, 90_000);

    expect(await guardResume(host, send("warm"))).toBeUndefined();
    expect(await guardResume(host, send("half"))).toBeUndefined();
    responds(host, "warm", { cacheRead: 399_000, cacheWrite: 1_200 });
    responds(host, "half", { cacheRead: 45_000, cacheWrite: 45_000 });
    await settled();
    expect(
        resumeEvents(lines, "agent.resume.result").map((event) => {
            const dims = event.dims as Record<string, unknown>;
            return [dims.agent, dims.decision, dims.cache, event.value];
        })
    ).toEqual([
        ["warm", "passed-warm", "hit", 1_200],
        ["half", "passed-small", "partial", 45_000],
    ]);
});

test("resume guard: a compaction clears the agent's remembered size, and the model comes from the band first", async () => {
    const { host, agents, lines } = fixture();
    agents.push(agent("scout"));
    ranBefore(host, "scout", 7, 240_000);
    await resumeGuard.compacted?.(host, "scout");

    // No size from a step and no transcript: the send passes and names no old size.
    expect(await guardResume(host, send("scout"))).toBeUndefined();
    expect(guardLog(lines).at(-1)).toMatchObject({ reason: "size-unknown", tokens: null });

    // Before the main loop's first response after a reload, its model is the one the session runs on now.
    forgetLoopModels();
    expect(await loopModel(host, "main")).toBe("claude-test-model");
    expect(await loopModel(host, "nobody")).toBeNull();
    noteLoopModel("main", "fixture-main");
    metas.set("scout", { model: "fixture-meta" });
    expect(loopModelOf("scout")).toBe("fixture-meta");
    expect(loopModelOf("main")).toBe("fixture-main");
    expect(loopModelOf("nobody")).toBeNull();
});

test("resume guard: another session, a structured message, a subscription and a teammate with teammates off pass", async () => {
    const { host, agents, lines } = fixture({ resumeGuard: { enabled: true, teammates: false } });
    agents.push(agent("scout"), agent("t-1", { name: "reviewer", teammateId: "reviewer@crew", type: "teammate" }));
    ranBefore(host, "scout", 30, 400_000);
    ranBefore(host, "t-1", 30, 400_000);

    expect(await guardResume(host, send("other-session"))).toBeUndefined();
    expect(await guardResume(host, send("main"))).toBeUndefined();
    expect(await guardResume(host, send("scout", { type: "shutdown_request" }))).toBeUndefined();
    const subscription = { ...send("scout"), notify_when_idle: true };
    Reflect.deleteProperty(subscription, "message");
    expect(await guardResume(host, subscription)).toBeUndefined();
    expect(await guardResume(host, send("reviewer"))).toBeUndefined();
    expect(guardLog(lines).map((record) => record.reason)).toEqual([
        "not-an-agent",
        "not-an-agent",
        "structured",
        "subscription",
        "teammates-off",
    ]);
});

test("resume guard: a teammate is refused while teammates is on, by its name or its address's name", async () => {
    const { host, agents, lines } = fixture();
    agents.push(agent("t-1", { name: undefined, teammateId: "reviewer@crew", type: "teammate", status: "idle" }));
    ranBefore(host, "t-1", 30, 400_000);

    expect(await guardResume(host, send("reviewer [crew]"))).toContain("reviewer is idle for 30 min");
    expect(resumeEvents(lines)[0]?.dims).toMatchObject({ kind: "teammate", idleSeconds: "15-60m" });
});

test("resume guard: off, it reads nothing past the settings and passes everything", async () => {
    const { host, agents, lines } = fixture({});
    let listed = 0;
    host.agents = async () => {
        listed++;
        return agents;
    };
    agents.push(agent("scout"));
    ranBefore(host, "scout", 30, 400_000);

    expect(await guardResume(host, send("scout"))).toBeUndefined();
    expect(await guardResume(host, { tool: "Bash", tool_use_id: "toolu_b", command: "true" })).toBeUndefined();
    expect(listed).toBe(0);
    expect(lines).toEqual([]);
});

test("resume guard: names, buckets and the transcript's last usage", () => {
    const list = [agent("a1", { name: "scout" }), agent("a2", { name: undefined, teammateId: "lead@crew" })];
    expect(recipientOf("scout [a1b2]")).toBe("scout");
    expect(recipientOf(42)).toBeUndefined();
    expect(agentsNamed(list, "scout").map((one) => one.id)).toEqual(["a1"]);
    expect(agentsNamed(list, "a2").map((one) => one.id)).toEqual(["a2"]);
    expect(agentsNamed(list, "lead").map((one) => one.id)).toEqual(["a2"]);
    expect(agentsNamed([...list, agent("a3", { name: "scout" })], "scout")).toHaveLength(2);
    expect([4, 5, 14, 15, 59, 60].map((minutes) => idleBucket(minutes * MINUTE))).toEqual([
        "<5m",
        "5-15m",
        "5-15m",
        "15-60m",
        "15-60m",
        "60m+",
    ]);
    expect(lastContextOf('{"cut row "usage": 5\n{"message":{"usage":{"input_tokens":0}}}')).toBeUndefined();
    const settings = { enabled: true, idleSeconds: 295, minTokens: 150_000, teammates: true };
    const cold = { status: "completed", isTeammate: false, idleMs: 20 * MINUTE, tokens: 400_000, isRefused: false };
    expect(decideResume(settings, cold)).toEqual({ refuse: true, reason: "cold-and-large", outcome: "refused" });
    expect(decideResume(settings, { ...cold, idleMs: 294_999 }).reason).toBe("warm");
    expect(decideResume(settings, { ...cold, idleMs: 295_000 }).refuse).toBe(true);
    expect(decideResume(settings, { ...cold, tokens: 149_999 }).reason).toBe("small");
    expect(decideResume(settings, { ...cold, idleMs: undefined }).reason).toBe("idle-unknown");
    expect(decideResume(settings, { ...cold, tokens: undefined }).reason).toBe("size-unknown");
    expect(decideResume(settings, { ...cold, status: "pending" }).reason).toBe("running");
});

test("resume guard: through the engine, the model's SendMessage is denied once and then reaches the agent", async ($, on) => {
    forgetSettings();
    forgetAgentDetails();
    forgetResumeGuard();
    mock.env(on, { HOME: "/home/test" });
    mock.store(on);
    mock.clock(on);
    const lastWrite = Date.now() - 9.5 * MINUTE;
    const agentFile = `${SESSION_DIR}/subagents/agent-scout.jsonl`;
    const usage = {
        input_tokens: 2,
        cache_read_input_tokens: 260_000,
        cache_creation_input_tokens: 0,
        output_tokens: 98,
    };
    on("session.id", async () => ({ value: "sess-1" }));
    on("session.cwd", async () => ({ value: "/work/app" }));
    on("fs.read", async (_$, e) => {
        if (e.path.endsWith("/agents/hooks.json")) {
            return { value: JSON.stringify({ mods: { resumeGuard: { enabled: true } } }) };
        }

        throw new Error(`no file ${e.path}`);
    });
    on("fs.exists", async (_$, e) => ({ value: e.path === `${SESSION_DIR}.jsonl` || e.path === agentFile }));
    on("fs.stat", async () => ({
        value: { kind: "file", size: 10, mtimeMs: lastWrite, isLink: false },
    }));
    on("process.run", async (_$, e) => ({
        value: {
            exitCode: e.argv[0] === "tail" ? 0 : 1,
            stdout: e.argv[0] === "tail" ? `${JSON.stringify({ message: { usage } })}\n` : "",
            stderr: "",
            isStdoutTruncated: false,
            isStderrTruncated: false,
        },
    }));
    on("agent.list", async () => ({ value: [agent("scout")] }));
    let delivered = 0;
    on("tool.call", async () => {
        delivered++;
        return { result: { success: true, message: "sent" } };
    });

    const first = await $.tool.call({ tool: "SendMessage", to: "scout", message: "One more file, please." });
    expect(first.deny).toContain("Not sent (resume guard, once): scout is idle for 9 min");
    expect(delivered).toBe(0);
    const second = await $.tool.call({ tool: "SendMessage", to: "scout", message: "One more file, please." });
    expect(second.deny).toBeUndefined();
    expect(delivered).toBe(1);
});

test("resume guard: a subagent's response cost through the engine is its context at the next send", async ($, on) => {
    // The engine loads its own copy of the plugin's modules, so this test reads what the guard decided from its log.
    const clock = mock.clock(on);
    mock.env(on, { HOME: "/home/test" });
    mock.store(on);
    on("session.id", async () => ({ value: "sess-1" }));
    on("session.cwd", async () => ({ value: "/work/app" }));
    on("fs.read", async (_$, e) => {
        if (e.path.endsWith("/agents/hooks.json")) {
            return { value: JSON.stringify({ mods: { resumeGuard: { enabled: true } } }) };
        }

        throw new Error(`no file ${e.path}`);
    });
    on("fs.exists", async () => ({ value: false }));
    const appended: string[] = [];
    on("process.run", async (_$, e) => {
        if (e.argv.at(-1)?.endsWith("/mods-log/resume-guard.jsonl")) {
            appended.push(String(e.init?.stdin ?? ""));
        }

        return { value: { exitCode: 0, stdout: "", stderr: "", isStdoutTruncated: false, isStderrTruncated: false } };
    });
    on("agent.list", async () => ({ value: [agent("scout")] }));
    const usage = {
        model: "fixture-model",
        input_tokens: 3,
        cache_read_input_tokens: 170_000,
        cache_creation_input_tokens: 2_000,
        output_tokens: 997,
    };
    on("turn.step", async function* () {
        yield { kind: "stop", stopReason: "end_turn", usage };

        return { turnId: "t1", index: 0, answer: "done", toolUses: [], stopReason: "end_turn", usage };
    });
    on("tool.call", async () => ({ result: { success: true, message: "sent" } }));

    const step = $.turn.step({ turnId: "t1", index: 0, model: "fixture-model", messageCount: 1, agentId: "scout" });
    const kinds: string[] = [];

    for await (const chunk of step) {
        kinds.push(chunk.kind);
    }

    const sent = await $.tool.call({ tool: "SendMessage", to: "scout", message: "Anything else?" });
    await clock.advance(30_000);
    await clock.settle();

    expect(kinds).toEqual(["stop"]);
    expect(sent.deny).toBeUndefined();
    expect(
        appended
            .join("")
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line))
    ).toEqual([expect.objectContaining({ reason: "warm", tokens: 173_000, tokensFrom: "step", idleFrom: "clock" })]);
});
