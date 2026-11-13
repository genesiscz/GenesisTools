// The fixture is the smallest session that has every shape the reader joins, built from the layout of a real session
// (2026-11-10): a run record, a journal, transcripts with a response written as two rows, an agent only the journal
// knows, and a run that left no record. Ported from the session-analyzer skill's `scripts/workflows.test.ts`.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeHooks } from "@genesiscz/utils/ai/providers/plugins/anthropic-sub/harness-hooks";
import type { ResolvedTranscript } from "@genesiscz/utils/ai/transcripts/resolve";
import { sessionCallsWithAgents } from "@genesiscz/utils/ai/transcripts/session-calls";
import { listSubagents } from "@genesiscz/utils/ai/transcripts/subagents";
import {
    listSessionAgents,
    workflowAgentUsage,
    workflowReaderSupport,
} from "@genesiscz/utils/ai/transcripts/workflows";
import { SafeJSON } from "@genesiscz/utils/json";
import { buildSessionReport } from "../analysis/report";
import { factsOf } from "../analysis-types";
import { claudeHistoryReader, codexHistoryReader, grokHistoryReader } from "../compact-readers";
import { pickWorkflowAgent, pickWorkflowRun, type WorkflowRun, workflowRunTotals } from "../workflow-types";
import { subagentFiles } from "./claude-changes-parse";
import {
    claudeSubagentCandidates,
    claudeSubagentLead,
    claudeSubagentTranscripts,
    claudeWorkflowRunOf,
} from "./claude-paths";
import { claudeWorkflows } from "./claude-workflows";

const SESSION = "aaaaaaaa-1111-4111-8111-111111111111";
const RUN_A = "wf_aaaa1111-001";
const RUN_B = "wf_bbbb2222-002";

/** Every temporary folder a test made, removed once the file's tests ran. */
const madeDirs: string[] = [];

function tempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    madeDirs.push(dir);
    return dir;
}

afterAll(() => {
    for (const dir of madeDirs) {
        rmSync(dir, { recursive: true, force: true });
    }
});

function jsonl(rows: unknown[]): string {
    return `${rows.map((row) => SafeJSON.stringify(row)).join("\n")}\n`;
}

function assistantRow(messageId: string, timestamp: string, block: Record<string, unknown>) {
    return {
        type: "assistant",
        timestamp,
        message: {
            id: messageId,
            model: "claude-opus-4-5",
            stop_reason: "tool_use",
            usage: {
                input_tokens: 100,
                cache_creation_input_tokens: 0,
                cache_read_input_tokens: 900,
                output_tokens: 10,
            },
            content: [block],
        },
    };
}

function buildSession(): string {
    const project = tempDir("gt-workflows-reader-");
    const parent = join(project, `${SESSION}.jsonl`);
    const records = join(project, SESSION, "workflows");
    const runA = join(project, SESSION, "subagents", "workflows", RUN_A);
    const runB = join(project, SESSION, "subagents", "workflows", RUN_B);
    mkdirSync(join(records, "scripts"), { recursive: true });
    mkdirSync(runA, { recursive: true });
    mkdirSync(runB, { recursive: true });
    writeFileSync(parent, jsonl([{ type: "user", timestamp: "2026-11-01T10:00:00.000Z", message: "go" }]));
    writeFileSync(
        join(project, SESSION, "subagents", "agent-direct1.jsonl"),
        jsonl([{ type: "user", timestamp: "2026-11-01T09:59:00.000Z", message: { role: "user", content: "direct" } }])
    );
    writeFileSync(join(records, "scripts", `review-${RUN_A}.js`), "export const meta = { name: 'review' }\n");
    writeFileSync(
        join(records, `${RUN_A}.json`),
        SafeJSON.stringify({
            runId: RUN_A,
            workflowName: "review-changes",
            summary: "Review two files",
            status: "completed",
            error: null,
            startTime: Date.parse("2026-11-01T10:00:00.000Z"),
            durationMs: 5_400_000,
            defaultModel: "claude-opus-4-5",
            scriptPath: `/gone/review-${RUN_A}.js`,
            agentCount: 2,
            totalTokens: 2020,
            totalToolCalls: 2,
            phases: [{ title: "Review" }, { title: "Verify" }],
            workflowProgress: [
                { type: "workflow_phase", index: 1, title: "Review" },
                {
                    type: "workflow_agent",
                    label: "review:bugs",
                    phaseTitle: "Review",
                    agentId: "aaa1",
                    model: "claude-opus-4-5",
                    state: "done",
                    attempt: 1,
                    startedAt: Date.parse("2026-11-01T10:00:05.000Z"),
                    promptPreview: "Review the diff for bugs",
                },
                {
                    type: "workflow_agent",
                    label: "verify:bugs",
                    phaseTitle: "Verify",
                    agentId: "bbb2",
                    model: "claude-opus-4-5",
                    state: "done",
                    attempt: 1,
                },
            ],
        }) ?? ""
    );
    writeFileSync(
        join(runA, "journal.jsonl"),
        jsonl([
            { type: "launched" },
            { type: "started", key: "v2:1", agentId: "aaa1", label: "review:bugs", phase: "Review" },
            {
                type: "result",
                key: "v2:1",
                agentId: "aaa1",
                result: { findings: [{ file: "a.ts", problem: "off by one" }] },
            },
            { type: "started", key: "v2:2", agentId: "bbb2", label: "verify:bugs", phase: "Verify" },
            { type: "started", key: "v2:3", agentId: "ccc3", label: "review:perf", phase: "Review" },
        ])
    );
    // One API response written as two rows (one per content block): one call, two tool calls.
    writeFileSync(
        join(runA, "agent-aaa1.jsonl"),
        jsonl([
            {
                type: "user",
                timestamp: "2026-11-01T10:00:05.000Z",
                message: { role: "user", content: "Review the diff. The voucher is not restored." },
            },
            assistantRow("msg_1", "2026-11-01T10:00:10.000Z", {
                type: "tool_use",
                id: "toolu_1",
                name: "Skill",
                input: { skill: "code-review" },
            }),
            assistantRow("msg_1", "2026-11-01T10:00:10.000Z", {
                type: "tool_use",
                id: "toolu_2",
                name: "Bash",
                input: { command: "git diff" },
            }),
            {
                type: "user",
                timestamp: "2026-11-01T10:00:20.000Z",
                message: {
                    role: "user",
                    content: [
                        {
                            type: "tool_result",
                            tool_use_id: "toolu_2",
                            content: "decrementUsedVouchers($reservation);",
                        },
                    ],
                },
            },
            assistantRow("msg_2", "2026-11-01T10:00:30.000Z", {
                type: "text",
                text: "decrementUsedVouchers runs before approval",
            }),
        ])
    );
    writeFileSync(
        join(runA, "agent-aaa1.meta.json"),
        SafeJSON.stringify({ agentType: "workflow-subagent", description: "review:bugs", workflowPhase: "Review" }) ??
            ""
    );
    writeFileSync(
        join(runA, "agent-ccc3.jsonl"),
        jsonl([{ type: "user", timestamp: "2026-11-01T10:01:00.000Z", message: { role: "user", content: "perf" } }])
    );
    writeFileSync(
        join(runA, "agent-ccc3.meta.json"),
        SafeJSON.stringify({ description: "review:perf", workflowPhase: "Review" }) ?? ""
    );
    // A run that was stopped before its record was written: transcripts and a journal only.
    writeFileSync(
        join(runB, "journal.jsonl"),
        jsonl([
            { type: "launched" },
            { type: "started", key: "v2:9", agentId: "ddd4", label: "implement x", phase: "Build" },
        ])
    );
    writeFileSync(
        join(runB, "agent-ddd4.jsonl"),
        jsonl([{ type: "user", message: { role: "user", content: "build" } }])
    );
    return parent;
}

async function runsOf(parent: string): Promise<WorkflowRun[]> {
    const facts = await claudeWorkflows.runs(parent);

    if (!facts.supported) {
        throw new Error("the Claude reader must support workflow runs");
    }

    return facts.items;
}

const parent = buildSession();
const resolved: ResolvedTranscript = { provider: "claude", source: "native", sessionId: SESSION, filePath: parent };
const tail = (path: string): string => path.split(/[/\\]/).slice(-2).join("/");

describe("the Claude session folder layout", () => {
    test("one walk lists the direct agents and the agents of every run, each with its run id", () => {
        const files = claudeSubagentTranscripts(parent);
        expect(files.map((file) => [file.runId, file.agentId])).toEqual([
            [null, "direct1"],
            [RUN_A, "aaa1"],
            [RUN_A, "ccc3"],
            [RUN_B, "ddd4"],
        ]);
        expect(tail(files[1]?.meta ?? "")).toBe(`${RUN_A}/agent-aaa1.meta.json`);
    });

    test("a workflow agent's path names its run and its lead session; a direct agent's names no run", () => {
        const [direct, inRun] = claudeSubagentTranscripts(parent);
        expect(claudeWorkflowRunOf(inRun?.transcript ?? "")).toBe(RUN_A);
        expect(claudeWorkflowRunOf(direct?.transcript ?? "")).toBeNull();
        expect(claudeSubagentLead(inRun?.transcript ?? "")).toEqual({ sessionId: SESSION, transcript: parent });
        expect(claudeSubagentLead(direct?.transcript ?? "")).toEqual({ sessionId: SESSION, transcript: parent });
        expect(claudeSubagentLead(join(parent, "..", SESSION, "workflows", `${RUN_A}.json`))).toBeNull();
    });

    test("an agent id resolves in a run folder, and a hook finds a workflow agent's own transcript", () => {
        const candidates = claudeSubagentCandidates(parent, "ddd4");
        expect(candidates.map((file) => file.runId)).toEqual([null, RUN_A, RUN_B]);
        expect(tail(claudeHooks.subagentTranscript(parent, "ddd4") ?? "")).toBe(`${RUN_B}/agent-ddd4.jsonl`);
        expect(tail(claudeHooks.subagentTranscript(parent, "direct1") ?? "")).toBe("subagents/agent-direct1.jsonl");
        // No such agent anywhere: the direct path stands, as before.
        expect(tail(claudeHooks.subagentTranscript(parent, "nobody") ?? "")).toBe("subagents/agent-nobody.jsonl");
    });

    test("a session with no sub-agent folder lists nothing and has no run", async () => {
        const lonely = join(tempDir("gt-workflows-none-"), `${SESSION}.jsonl`);
        writeFileSync(lonely, jsonl([{ type: "user", message: "hi" }]));
        expect(claudeSubagentTranscripts(lonely)).toEqual([]);
        expect(await runsOf(lonely)).toEqual([]);
    });
});

describe("the Claude workflow reader", () => {
    test("joins the run record, the journal and the folder by agent id", async () => {
        const runs = await runsOf(parent);
        expect(runs.map((run) => run.runId)).toEqual([RUN_A, RUN_B]);

        const run = pickWorkflowRun(runs, "wf_aaaa");
        expect(run).toMatchObject({
            name: "review-changes",
            status: "completed",
            startedAt: "2026-11-01T10:00:00.000Z",
            phases: ["Review", "Verify"],
            reported: { agents: 2, tokens: 2020, toolCalls: 2 },
        });

        const byId = new Map(run.agents.map((agent) => [agent.agentId, agent]));
        expect([...byId.keys()].sort()).toEqual(["aaa1", "bbb2", "ccc3"]);
        expect(byId.get("aaa1")).toMatchObject({
            label: "review:bugs",
            phase: "Review",
            state: "done",
            hasResult: true,
            sources: ["record", "journal", "disk"],
        });
        // Named by the record and the journal, never written to disk: the transcript is null, not a guessed path.
        expect(byId.get("bbb2")).toMatchObject({
            transcript: null,
            bytes: 0,
            hasResult: false,
            sources: ["record", "journal"],
        });
        // Started and written, absent from the record: the journal and the meta file still name it.
        expect(byId.get("ccc3")).toMatchObject({
            label: "review:perf",
            phase: "Review",
            model: null,
            sources: ["journal", "disk"],
        });
        expect(workflowRunTotals(run)).toMatchObject({ agents: 3, withTranscript: 2, withResult: 1 });
    });

    test("an empty label or phase in the record does not hide the journal's and the folder's value", async () => {
        const local = buildSession();
        const file = join(local.replace(/\.jsonl$/, ""), "workflows", `${RUN_A}.json`);
        const record = SafeJSON.parse(readFileSync(file, "utf8"), { strict: true });
        record.workflowProgress[1].label = "";
        record.workflowProgress[1].phaseTitle = "";
        writeFileSync(file, SafeJSON.stringify(record) ?? "");
        const agent = pickWorkflowRun(await runsOf(local), RUN_A).agents.find(
            (candidate) => candidate.agentId === "aaa1"
        );
        expect(agent).toMatchObject({ label: "review:bugs", phase: "Review" });
    });

    test("finds the saved script when the record's absolute path no longer exists", async () => {
        const run = pickWorkflowRun(await runsOf(parent), "review-changes");
        expect(tail(run.scriptPath ?? "")).toBe(`scripts/review-${RUN_A}.js`);
    });

    test("an epoch a Date cannot hold reads as no time, and the run is still listed", async () => {
        const record = join(parent.replace(/\.jsonl$/, ""), "workflows", `${RUN_A}.json`);
        const original = readFileSync(record, "utf8");
        const row = SafeJSON.parse(original, { strict: true });
        row.startTime = 1e20;
        row.workflowProgress[1].startedAt = 1e20;
        writeFileSync(record, SafeJSON.stringify(row) ?? "");
        try {
            const run = pickWorkflowRun(await runsOf(parent), "wf_aaaa");
            expect(run.startedAt).toBeNull();
            expect(run.agents.find((agent) => agent.agentId === "aaa1")?.startedAt).toBeNull();
        } finally {
            writeFileSync(record, original);
        }
    });

    test("an unreadable journal leaves its run and the other runs listed, with the agents the record and folder name", async () => {
        const local = buildSession();
        const journal = join(local.replace(/\.jsonl$/, ""), "subagents", "workflows", RUN_A, "journal.jsonl");
        // A folder where the journal belongs: it exists, so the reader opens it, and reading it fails.
        renameSync(journal, `${journal}.moved`);
        mkdirSync(journal);

        const runs = await runsOf(local);
        expect(runs.map((run) => run.runId)).toEqual([RUN_A, RUN_B]);
        const run = pickWorkflowRun(runs, RUN_A);
        expect(run.agents.map((agent) => agent.agentId).sort()).toEqual(["aaa1", "bbb2", "ccc3"]);
        expect(run.agents.every((agent) => agent.journal === null && !agent.hasResult)).toBe(true);
        expect(claudeWorkflows.results(run).size).toBe(0);
    });

    test("keeps a run that has transcripts but no run record", async () => {
        const run = pickWorkflowRun(await runsOf(parent), "wf_bbbb");
        expect(run).toMatchObject({ recordPath: null, name: null, status: null, phases: ["Build"] });
        expect(run.agents.map((agent) => agent.label)).toEqual(["implement x"]);
    });

    test("returns the journal's final answers by agent id", async () => {
        const results = claudeWorkflows.results(pickWorkflowRun(await runsOf(parent), RUN_A));
        expect([...results.keys()]).toEqual(["aaa1"]);
        expect(results.get("aaa1")).toEqual({ findings: [{ file: "a.ts", problem: "off by one" }] });
    });

    test("grep says whether the agent wrote the text or was shown it", async () => {
        const hits = await claudeWorkflows.grep(await runsOf(parent), /decrementUsedVouchers/, {
            maxHits: 5,
            context: 10,
        });
        expect(hits).toHaveLength(1);
        expect(hits[0]?.agent.agentId).toBe("aaa1");
        expect(hits[0]?.matchingLines).toBe(2);
        expect(hits[0]?.hits.map((hit) => [hit.line, hit.where])).toEqual([
            [4, "tool-result"],
            [5, "assistant"],
        ]);
        expect(hits[0]?.hits[0]?.excerpt.length).toBeLessThanOrEqual("decrementUsedVouchers".length + 20);
    });

    test("grep tells a prompt from the agent's own words and honours `before`", async () => {
        const runs = await runsOf(parent);
        const prompt = await claudeWorkflows.grep(runs, /voucher is not restored/i);
        expect(prompt[0]?.hits[0]).toMatchObject({ line: 1, where: "prompt" });

        const early = await claudeWorkflows.grep(runs, /decrementUsedVouchers/g, {
            before: "2026-11-01T10:00:25.000Z",
        });
        expect(early[0]?.matchingLines).toBe(1);
        expect(early[0]?.hits[0]?.where).toBe("tool-result");
    });

    test("prices each model call once for a response written as two rows", async () => {
        const agent = pickWorkflowRun(await runsOf(parent), RUN_A).agents.find(
            (candidate) => candidate.agentId === "aaa1"
        );
        const usage = await workflowAgentUsage("claude", agent?.transcript ?? "");
        expect(usage).toMatchObject({
            calls: 2,
            input: 200,
            cacheRead: 1800,
            output: 20,
            models: ["claude-opus-4-5"],
            firstAt: "2026-11-01T10:00:10.000Z",
            lastAt: "2026-11-01T10:00:30.000Z",
        });
    });

    test("pickWorkflowRun takes an id prefix or a name, and refuses a miss or an ambiguous one", async () => {
        const runs = await runsOf(parent);
        expect(pickWorkflowRun(runs, "wf_bbbb2222").runId).toBe(RUN_B);
        expect(pickWorkflowRun(runs, "REVIEW-changes").runId).toBe(RUN_A);
        expect(() => pickWorkflowRun(runs, "nope")).toThrow(/no workflow run matches/);
        expect(() => pickWorkflowRun(runs, "wf_")).toThrow(/matches 2 runs/);
    });

    test("pickWorkflowAgent takes an id, an id prefix, a label or a part of it, and refuses a miss or an ambiguous one", async () => {
        const run = pickWorkflowRun(await runsOf(parent), RUN_A);
        expect(pickWorkflowAgent(run, "aaa1").agentId).toBe("aaa1");
        expect(pickWorkflowAgent(run, "bb").agentId).toBe("bbb2");
        expect(pickWorkflowAgent(run, "review:perf").agentId).toBe("ccc3");
        expect(pickWorkflowAgent(run, "VERIFY").agentId).toBe("bbb2");
        expect(() => pickWorkflowAgent(run, "review")).toThrow(/matches 2 agents/);
        expect(() => pickWorkflowAgent(run, "nobody")).toThrow(/no agent "nobody"/);
    });

    test("an agent's journal rows carry their lines, and an attempt with no result names the retry that replaced it", async () => {
        const local = buildSession();
        const journal = join(local.replace(/\.jsonl$/, ""), "subagents", "workflows", RUN_B, "journal.jsonl");
        writeFileSync(
            journal,
            jsonl([
                { type: "launched" },
                { type: "started", key: "v2:9", agentId: "ddd4", label: "implement x", phase: "Build" },
                { type: "started", key: "v2:9", agentId: "eee5", label: "implement x", phase: "Build" },
                { type: "result", key: "v2:9", agentId: "eee5", result: { ok: true } },
            ])
        );
        const runs = await runsOf(local);
        const byId = new Map(pickWorkflowRun(runs, RUN_B).agents.map((agent) => [agent.agentId, agent]));
        expect(byId.get("ddd4")).toMatchObject({
            journal: { key: "v2:9", startedLine: 2, resultLine: null },
            supersededBy: { agentId: "eee5", startedLine: 3, hasResult: true },
        });
        expect(byId.get("eee5")).toMatchObject({
            journal: { key: "v2:9", startedLine: 3, resultLine: 4 },
            supersededBy: null,
        });
        // A step that ran once replaces nothing: an agent with no result there is not "retried".
        const once = pickWorkflowRun(runs, RUN_A).agents;
        expect(once.map((agent) => [agent.agentId, agent.journal?.startedLine, agent.supersededBy])).toEqual([
            ["aaa1", 2, null],
            ["bbb2", 4, null],
            ["ccc3", 5, null],
        ]);
    });
});

describe("a session's calls", () => {
    test("are its own and its agents', each once, and an agent's call is a side-chain call the report prices", async () => {
        const local = buildSession();
        writeFileSync(
            local,
            jsonl([
                { type: "user", timestamp: "2026-11-01T10:00:00.000Z", message: { role: "user", content: "go" } },
                assistantRow("msg_lead", "2026-11-01T10:00:01.000Z", { type: "text", text: "starting the review" }),
            ])
        );
        const session = { ...resolved, filePath: local };
        const { calls, agentTranscripts, unreadable } = await sessionCallsWithAgents(session);
        expect(agentTranscripts).toBe(4);
        expect(unreadable).toEqual([]);
        expect(factsOf(calls).map((call) => [call.id, call.sidechain])).toEqual([
            ["msg_lead", false],
            ["msg_1", true],
            ["msg_2", true],
        ]);

        const report = buildSessionReport({ calls, compactions: { supported: true, items: [] }, agent: "claude" });
        expect(report.overview).toMatchObject({ calls: 3, subagentCalls: 2 });
        // Read from the lead's transcript alone, the sub-agent cost of this session is zero.
        expect(report.cost.subagentUsd).toBeCloseTo(report.cost.mainUsd * 2, 10);
        expect(report.cost.mainUsd).toBeGreaterThan(0);
    });
});

describe("a session's agent listing", () => {
    test("lists the workflow agents with their run, label and phase beside the direct agents", async () => {
        const listing = await listSessionAgents(resolved);
        expect(listing.subagents.map((agent) => [agent.id, agent.workflow])).toEqual([
            ["direct1", null],
            ["aaa1", { runId: RUN_A, label: "review:bugs", phase: "Review" }],
            ["ccc3", { runId: RUN_A, label: "review:perf", phase: "Review" }],
            ["ddd4", { runId: RUN_B, label: null, phase: null }],
        ]);
        expect(listing.workflowReader).toEqual({ supported: true });
        expect(listing.workflowRuns).toEqual([
            {
                runId: RUN_A,
                name: "review-changes",
                status: "completed",
                startedAt: "2026-11-01T10:00:00.000Z",
                durationMs: 5_400_000,
                agents: 3,
                transcripts: 2,
                results: 1,
                phases: ["Review", "Verify"],
            },
            {
                runId: RUN_B,
                name: null,
                status: null,
                startedAt: null,
                durationMs: null,
                agents: 1,
                transcripts: 1,
                results: 0,
                phases: ["Build"],
            },
        ]);
    });

    test("a session's file changes are read from its workflow agents' transcripts too", () => {
        expect(subagentFiles(parent).map((file) => file.agentId)).toEqual(["direct1", "aaa1", "ccc3", "ddd4"]);
    });

    test("`ids` reads only the named agents, in a run folder too", () => {
        expect(listSubagents(resolved, { ids: ["ccc3"] }).subagents.map((agent) => agent.id)).toEqual(["ccc3"]);
    });

    test("a workflow agent the lead revived is one sub-agent with both files, not two agents with one id", () => {
        const local = buildSession();
        const folder = join(local.replace(/\.jsonl$/, ""), "subagents");
        const first = join(folder, "workflows", RUN_A, "agent-aaa1.jsonl");
        const revival = join(folder, "agent-aaa1.jsonl");
        // A revival has no meta file: the harness writes the SendMessage and the reply into the direct folder.
        writeFileSync(
            revival,
            jsonl([
                {
                    type: "user",
                    timestamp: "2026-11-01T11:00:00.000Z",
                    message: { role: "user", content: "one more thing" },
                },
                assistantRow("msg_9", "2026-11-01T11:00:05.000Z", { type: "text", text: "done" }),
            ])
        );
        const agents = listSubagents({ ...resolved, filePath: local }).subagents;
        expect(agents.map((agent) => agent.id)).toEqual(["direct1", "aaa1", "ccc3", "ddd4"]);

        const revived = agents.find((agent) => agent.id === "aaa1");
        expect(revived).toMatchObject({
            workflow: { runId: RUN_A, label: "review:bugs", phase: "Review" },
            description: "review:bugs",
            startedAt: "2026-11-01T10:00:05.000Z",
            filePath: revival,
            files: [first, revival],
            bytes: statSync(first).size + statSync(revival).size,
        });
    });
});

describe("the cross-provider contract", () => {
    test("a harness with no workflow tool says so, with the reason, instead of answering zero runs", async () => {
        for (const reader of [codexHistoryReader, grokHistoryReader]) {
            const facts = await reader.workflows.runs(parent);
            expect(facts.supported).toBe(false);
            expect(facts.supported ? "" : facts.reason).toMatch(/no workflow tool/);
            expect(reader.workflows.support).toMatchObject({ supported: false });
        }

        expect(claudeHistoryReader.workflows.support).toEqual({ supported: true });
    });

    test("the support list names every provider once, without reading a file", () => {
        const support = workflowReaderSupport();
        expect(support.map((entry) => [entry.provider, entry.support.supported])).toEqual([
            ["claude", true],
            ["codex", false],
            ["grok", false],
        ]);
    });
});
