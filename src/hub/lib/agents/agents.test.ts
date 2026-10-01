import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodexSessionMeta } from "@app/codex/lib/store";
import type { GrokSessionMeta } from "@app/grok/lib/store";
import { SafeJSON } from "@genesiscz/utils/json";
import { Command } from "commander";
import { registerAgentsCommand } from "../../commands/agents";
import { hubArgs, hubUrl } from "../open";
import { agentCounts } from "./counts";
import { parentsOfRecentAgents } from "./index";
import { readAgentMail } from "./mail";
import { readParent } from "./parent";
import { unreadInbox } from "./team";
import { type ParentRow, promptPreview, withoutFullPrompts } from "./tree";
import type { AgentNode } from "./types";
import { codexWorkerNode, grokWorkerNode } from "./workers";

const NOW = Date.parse("2026-03-10T12:00:00.000Z");
const HOUR = 3_600_000;
const SESSION = "5e551011-aaaa-bbbb-cccc-000000000001";
const TEAM = "session-5e551011";

function lines(...records: unknown[]): string {
    return `${records.map((record) => SafeJSON.stringify(record)).join("\n")}\n`;
}

function write(path: string, text: string, mtimeMs: number): void {
    writeFileSync(path, text);
    utimesSync(path, mtimeMs / 1000, mtimeMs / 1000);
}

const prompt = (at: string, content: string) => ({ type: "user", timestamp: at, message: { role: "user", content } });
const reply = (model: string) => ({
    type: "assistant",
    timestamp: "2026-03-10T10:05:00.000Z",
    message: { model, stop_reason: "end_turn", content: [{ type: "text", text: "done" }] },
});
const toolUse = (id: string, name: string, input: Record<string, unknown> = {}) => ({
    type: "assistant",
    timestamp: "2026-03-10T10:02:00.000Z",
    message: { model: "claude-test-1", stop_reason: "tool_use", content: [{ type: "tool_use", id, name, input }] },
});
const notification = (taskId: string, status: string) => ({
    type: "queue-operation",
    operation: "enqueue",
    content: `<task-notification>\n<task-id>${taskId}</task-id>\n<tool-use-id>toolu_x</tool-use-id>\n<status>${status}</status>\n<summary>Agent finished</summary>\n</task-notification>`,
});

/**
 * One lead session with: a teammate still in the team (idle, 2 unread mails), a teammate the
 * config dropped (completed), a background agent the parent was told failed, a foreground agent
 * that started a nested one, and a background agent still working.
 */
function fixture() {
    const root = mkdtempSync(join(tmpdir(), "gt-hub-agents-"));
    const projects = join(root, "projects", "-tmp-demo");
    const dir = join(projects, SESSION, "subagents");
    const teams = join(root, "teams");
    mkdirSync(dir, { recursive: true });
    mkdirSync(join(teams, TEAM, "inboxes"), { recursive: true });

    const parentFile = join(projects, `${SESSION}.jsonl`);
    write(
        parentFile,
        lines(
            prompt("2026-03-10T09:00:00.000Z", "lead the work"),
            notification("abgfail0000000001", "completed"),
            // The later notification for the same task wins.
            notification("abgfail0000000001", "failed"),
            // A Monitor event carries no status and is skipped.
            { type: "queue-operation", content: "<task-notification>\n<task-id>bmon</task-id>\n</task-notification>" }
        ),
        NOW - 10 * 60_000
    );

    const agent = (id: string, meta: Record<string, unknown>, records: unknown[], mtimeMs: number) => {
        write(join(dir, `agent-${id}.jsonl`), lines(...records), mtimeMs);
        writeFileSync(join(dir, `agent-${id}.meta.json`), SafeJSON.stringify(meta));
    };

    agent(
        "aworker-one-0000000000000001",
        { name: "worker-one", agentType: "worker-one", taskKind: "in_process_teammate", teamName: TEAM, spawnDepth: 0 },
        [
            prompt(
                "2026-03-10T10:00:00.000Z",
                '<teammate-message teammate_id="team-lead" summary="start">\nBuild the list.\n</teammate-message>'
            ),
            toolUse("toolu_t1", "Bash"),
            toolUse("toolu_t2", "SendMessage", { to: "team-lead", message: "list built" }),
            prompt(
                "2026-03-10T10:03:00.000Z",
                '<teammate-message teammate_id="team-lead">\nThanks, now the detail.\n</teammate-message>'
            ),
            reply("claude-test-1"),
        ],
        NOW - 30 * 60_000
    );
    agent(
        "aworker-two-0000000000000002",
        { name: "worker-two", taskKind: "in_process_teammate", teamName: TEAM, spawnDepth: 0 },
        // Its last act approved the shutdown, so the config dropped it: finished, not mid-work.
        [
            prompt("2026-03-10T10:00:00.000Z", "probe"),
            toolUse("toolu_t3", "SendMessage", {
                to: "team-lead",
                message: { type: "shutdown_response", request_id: "r1", approve: true },
            }),
        ],
        NOW - 60 * 60_000
    );
    agent(
        "aworker-three-0000000000000003",
        { name: "worker-three", taskKind: "in_process_teammate", teamName: TEAM, spawnDepth: 0 },
        // Dropped from the config while mid-work, with no shutdown approval: killed.
        [prompt("2026-03-10T10:00:00.000Z", "probe"), toolUse("toolu_t4", "Bash")],
        NOW - 70 * 60_000
    );
    agent(
        "abgfail0000000001",
        { description: "Research the bug", toolUseId: "toolu_bg1", spawnDepth: 1, requestShape: "background" },
        [prompt("2026-03-10T10:00:00.000Z", "research"), reply("claude-test-2")],
        NOW - 20 * 60_000
    );
    agent(
        "afg00000000000001",
        {
            description: "Plan the change",
            toolUseId: "toolu_fg1",
            spawnDepth: 1,
            requestShape: "foreground",
            model: "inherit",
        },
        [prompt("2026-03-10T10:00:00.000Z", "plan"), toolUse("toolu_nested1", "Agent"), reply("claude-test-3")],
        NOW - 40 * 60_000
    );
    agent(
        "anested0000000001",
        { description: "Nested search", toolUseId: "toolu_nested1", spawnDepth: 2, requestShape: "foreground" },
        [prompt("2026-03-10T10:01:00.000Z", "search"), reply("claude-test-3")],
        NOW - 45 * 60_000
    );
    agent(
        "arunning000000001",
        { description: "Still working", toolUseId: "toolu_run1", spawnDepth: 1, requestShape: "background" },
        [prompt("2026-03-10T11:59:00.000Z", "work"), toolUse("toolu_r1", "Bash")],
        NOW - 5_000
    );

    writeFileSync(
        join(teams, TEAM, "config.json"),
        SafeJSON.stringify({
            name: TEAM,
            leadSessionId: SESSION,
            members: [
                { agentId: `team-lead@${TEAM}`, name: "team-lead", backendType: "in-process" },
                { agentId: `worker-one@${TEAM}`, name: "worker-one", model: "opus", backendType: "in-process" },
            ],
        })
    );
    writeFileSync(
        join(teams, TEAM, "inboxes", "worker-one.json"),
        SafeJSON.stringify([
            { from: "team-lead", text: "delivered", timestamp: "2026-03-10T10:03:00.000Z", read: true },
            { from: "team-lead", text: "not yet", timestamp: "2026-03-10T11:00:00.000Z", read: false },
            { from: "worker-two", text: "also not yet", timestamp: "2026-03-10T11:01:00.000Z", read: false },
        ])
    );

    const row: ParentRow = {
        sessionId: SESSION,
        title: "demo lead",
        project: "demo",
        cwd: "/tmp/demo",
        filePath: parentFile,
        model: "claude-lead",
        account: "work",
        mtime: NOW - 10 * 60_000,
    };
    return { root, dir, teams, row };
}

function find(nodes: AgentNode[], id: string): AgentNode | undefined {
    for (const node of nodes) {
        if (node.id === id) {
            return node;
        }

        const inner = find(node.children, id);
        if (inner) {
            return inner;
        }
    }

    return undefined;
}

describe("hub agents tree", () => {
    const { teams, row, dir } = fixture();
    const parent = readParent(row, [], teams, { now: NOW });

    test("every agent gets its kind, status and team facts", () => {
        const summary = (id: string) => {
            const node = find(parent.children, id);
            return node && { kind: node.kind, status: node.status, unread: node.unreadMail, team: node.team };
        };

        expect(summary("aworker-one-0000000000000001")).toEqual({
            kind: "teammate",
            status: "idle",
            unread: 2,
            team: TEAM,
        });
        expect(summary("aworker-two-0000000000000002")).toEqual({
            kind: "teammate",
            status: "completed",
            unread: 0,
            team: TEAM,
        });
        expect(summary("aworker-three-0000000000000003")).toMatchObject({ kind: "teammate", status: "killed" });
        expect(summary("abgfail0000000001")).toMatchObject({ kind: "background", status: "failed", team: null });
        expect(summary("afg00000000000001")).toMatchObject({ kind: "foreground", status: "completed" });
        expect(summary("arunning000000001")).toMatchObject({ kind: "background", status: "running" });
    });

    test("an agent started by another agent hangs under it; running agents sort first", () => {
        expect(parent.children.map((node) => node.id)).toEqual([
            "arunning000000001",
            "abgfail0000000001",
            "aworker-one-0000000000000001",
            "afg00000000000001",
            "aworker-two-0000000000000002",
            "aworker-three-0000000000000003",
        ]);
        expect(find(parent.children, "afg00000000000001")?.children.map((node) => node.id)).toEqual([
            "anested0000000001",
        ]);
        expect(find(parent.children, "anested0000000001")?.spawnDepth).toBe(2);
    });

    test("row fields: tool calls, spawn prompt without its envelope, model, backend, parent facts", () => {
        const one = find(parent.children, "aworker-one-0000000000000001");
        expect(one).toMatchObject({
            harness: "claude",
            name: "worker-one",
            toolCalls: 2,
            spawnPrompt: "Build the list.",
            model: "claude-test-1",
            account: "work",
            backendType: "in-process",
            spawnDepth: 0,
            startedAt: "2026-03-10T10:00:00.000Z",
            filePath: join(dir, "agent-aworker-one-0000000000000001.jsonl"),
        });
        // `inherit` is no model: the transcript's own reply names it.
        expect(find(parent.children, "afg00000000000001")?.model).toBe("claude-test-3");
        expect(parent).toMatchObject({
            sessionId: SESSION,
            title: "demo lead",
            startedAt: "2026-03-10T09:00:00.000Z",
            live: true,
        });
    });

    test("a parent with no agents and no recent write is not live", () => {
        const quiet = mkdtempSync(join(tmpdir(), "gt-hub-agents-quiet-"));
        const file = join(quiet, "11111111-0000-0000-0000-000000000000.jsonl");
        write(file, lines(prompt("2026-03-09T09:00:00.000Z", "hi")), NOW - 5 * HOUR);
        const lonely = readParent(
            { ...row, sessionId: "11111111-0000-0000-0000-000000000000", filePath: file, mtime: NOW - 5 * HOUR },
            [],
            teams,
            { now: NOW }
        );
        expect(lonely).toMatchObject({ live: false, children: [] });
    });
});

describe("hub agents mail", () => {
    const { teams, dir } = fixture();

    test("received messages keep their arrival time; sent ones come from SendMessage calls", () => {
        const unread = unreadInbox(teams, TEAM, "worker-one").map((entry) => ({
            from: entry.from,
            at: entry.timestamp,
            text: entry.text,
        }));
        const mail = readAgentMail(join(dir, "agent-aworker-one-0000000000000001.jsonl"), unread);
        expect(mail).toEqual({
            received: [
                { from: "team-lead", at: "2026-03-10T10:00:00.000Z", text: "Build the list." },
                { from: "team-lead", at: "2026-03-10T10:03:00.000Z", text: "Thanks, now the detail." },
            ],
            sent: [{ to: "team-lead", at: "2026-03-10T10:02:00.000Z", text: "list built" }],
            unread: [
                { from: "team-lead", at: "2026-03-10T11:00:00.000Z", text: "not yet" },
                { from: "worker-two", at: "2026-03-10T11:01:00.000Z", text: "also not yet" },
            ],
        });
    });
});

describe("hub agents workers", () => {
    const dir = mkdtempSync(join(tmpdir(), "gt-hub-workers-"));

    test("a codex worker: status from its meta, tool calls from its event log, prompt from its launch file", () => {
        const item = (type: string) =>
            SafeJSON.stringify({ source: "app-server", method: "item/started", params: { item: { type, id: "x" } } });
        writeFileSync(
            join(dir, "probe-codex.jsonl"),
            `${[item("userMessage"), item("commandExecution"), item("reasoning"), item("mcpToolCall")].join("\n")}\n`
        );
        writeFileSync(join(dir, "probe-codex.launch.json"), SafeJSON.stringify({ prompt: "measure mail" }));
        const meta = {
            name: "probe-codex",
            daemonPid: 1,
            cwd: "/tmp",
            model: "gpt-test",
            accountName: "work",
            sandbox: "workspace-write",
            approvalPolicy: "never",
            writePolicy: "allow",
            status: "closed",
            agentName: "codex_probe-codex",
            rendezvousSession: SESSION,
            agentsEnabled: true,
            startedAt: "2026-03-10T10:00:00.000Z",
            lastEventAt: "2026-03-10T10:10:00.000Z",
            codexVersion: "0.0.0",
            pendingApprovals: {},
        } satisfies CodexSessionMeta;

        const worker = codexWorkerNode(meta, dir, NOW);
        expect(worker.rendezvousSession).toBe(SESSION);
        expect(worker.node).toMatchObject({
            id: "probe-codex",
            harness: "codex",
            kind: "worker",
            status: "completed",
            toolCalls: 2,
            model: "gpt-test",
            account: "work",
            spawnPrompt: "measure mail",
            filePath: join(dir, "probe-codex.jsonl"),
        });
        expect(
            codexWorkerNode({ ...meta, status: "running", lastEventAt: new Date(NOW).toISOString() }, dir, NOW).node
                .status
        ).toBe("running");
    });

    test("a grok worker: every turn's tool calls, the last turn file opens, an unended turn runs", () => {
        const call = SafeJSON.stringify({ type: "tool_call", toolCallId: "c1", title: "grep" });
        const update = SafeJSON.stringify({ type: "tool_call_update", toolCallId: "c1" });
        write(join(dir, "probe-grok.turn1.jsonl"), `${call}\n${update}\n`, NOW - 60_000);
        write(join(dir, "probe-grok.turn2.jsonl"), `${call}\n${call}\n`, NOW - 30_000);
        const meta = {
            name: "probe-grok",
            sessionId: "g-1",
            cwd: "/tmp",
            workerHome: "/tmp/home",
            model: "grok-test",
            readOnly: false,
            turns: 2,
            createdAt: "2026-03-10T11:00:00.000Z",
            rendezvousSession: SESSION,
            lastTurn: { turn: 2, ended: false, exitCode: null, at: "2026-03-10T11:59:00.000Z" },
        } satisfies GrokSessionMeta;

        const worker = grokWorkerNode(meta, dir, NOW, () => "work");
        expect(worker.node).toMatchObject({
            harness: "grok",
            status: "running",
            toolCalls: 3,
            account: "work",
            filePath: join(dir, "probe-grok.turn2.jsonl"),
        });
        const ended = { ...meta, lastTurn: { turn: 2, ended: true, exitCode: 1, at: meta.lastTurn.at } };
        expect(grokWorkerNode(ended, dir, NOW).node.status).toBe("failed");
    });

    test("a grok worker's first turn runs before its meta counts any turn", () => {
        const call = SafeJSON.stringify({ type: "tool_call", toolCallId: "c1", title: "grep" });
        write(join(dir, "fresh-grok.turn1.jsonl"), `${call}\n`, NOW - 5_000);
        const meta = {
            name: "fresh-grok",
            sessionId: "g-2",
            cwd: "/tmp",
            workerHome: "/tmp/home",
            model: "grok-test",
            readOnly: false,
            turns: 0,
            createdAt: "2026-03-10T11:59:00.000Z",
            rendezvousSession: SESSION,
        } satisfies GrokSessionMeta;

        expect(grokWorkerNode(meta, dir, NOW).node).toMatchObject({
            status: "running",
            filePath: join(dir, "fresh-grok.turn1.jsonl"),
        });
    });
});

describe("hub open deep link", () => {
    test("the app arguments and the URL carry the parent session and the agent", () => {
        expect(hubArgs({ session: SESSION, agent: "aworker-one-0000000000000001" })).toEqual([
            "--hub",
            "--session",
            SESSION,
            "--agent",
            "aworker-one-0000000000000001",
        ]);
        expect(hubUrl({ session: SESSION, agent: "aworker-one-0000000000000001" })).toBe(
            `genesis-tools://hub?session=${SESSION}&agent=aworker-one-0000000000000001`
        );
        // A space stays %20: URLComponents reads `+` as a literal plus.
        expect(hubUrl({ mode: "sessions", filter: "two words" })).toBe(
            "genesis-tools://hub?mode=sessions&filter=two%20words"
        );
        expect(hubArgs({ mode: "sessions", session: SESSION })).toEqual([
            "--hub",
            "--mode",
            "sessions",
            "--session",
            SESSION,
        ]);
    });
});

describe("tools hub agents mail argv", () => {
    test("`agents mail --session X --agent Y --json` reaches mail although `agents` has its own --session", async () => {
        const calls: unknown[] = [];
        const program = new Command().name("hub").option("-v, --verbose");
        program.exitOverride();
        registerAgentsCommand(program, {
            tree: async () => ({ generatedAt: "", parents: [], orphans: [] }),
            agent: async () => null,
            mail: async (options) => {
                calls.push(options);
                return { received: [], sent: [], unread: [] };
            },
            counts: async () => ({ generatedAt: "", agents: [] }),
        });

        await program.parseAsync(
            ["agents", "mail", "--session", "1b4001ba", "--agent", "aworker-one-0000000000000001", "--json"],
            { from: "user" }
        );
        expect(calls).toEqual([{ session: "1b4001ba", agent: "aworker-one-0000000000000001" }]);
    });
});

describe("spawn prompts: previews in the list, the whole prompt from the one-agent door", () => {
    test("a preview folds whitespace and cuts at 200 characters", () => {
        expect(promptPreview("Build\n\n  the   list.")).toBe("Build the list.");
        const long = promptPreview("word ".repeat(100));
        expect(long?.length).toBe(200);
        expect(long?.endsWith("…")).toBe(true);
        expect(promptPreview(null)).toBeNull();
    });

    test("the list form drops every full prompt, nested ones too, and keeps the previews", () => {
        const { teams, row } = fixture();
        const listed = withoutFullPrompts(readParent(row, [], teams, { now: NOW }).children);
        const one = find(listed, "aworker-one-0000000000000001");
        expect(one).toMatchObject({ spawnPrompt: null, spawnPromptPreview: "Build the list." });
        expect(find(listed, "anested0000000001")).toMatchObject({ spawnPrompt: null, spawnPromptPreview: "search" });
    });

    test("`agents --session P --agent C --json` asks the one-agent door, not the list", async () => {
        const asked: unknown[] = [];
        const program = new Command().name("hub").option("-v, --verbose");
        program.exitOverride();
        registerAgentsCommand(program, {
            tree: async () => {
                throw new Error("the list must not be read");
            },
            agent: async (options) => {
                asked.push({ session: options.session, agent: options.agent });
                return null;
            },
            mail: async () => ({ received: [], sent: [], unread: [] }),
            counts: async () => ({ generatedAt: "", agents: [] }),
        });

        await program.parseAsync(["agents", "--session", "5e551011", "--agent", "aworker-one", "--json"], {
            from: "user",
        });
        expect(asked).toEqual([{ session: "5e551011", agent: "aworker-one" }]);
        process.exitCode = 0;
    });
});

describe("a parent is in the window when one of its agents is", () => {
    test("an old lead with a recent agent gets a row; listed leads and non-agent paths are skipped", async () => {
        const root = mkdtempSync(join(tmpdir(), "gt-hub-agent-parents-"));
        const project = join(root, "-tmp-demo");
        const oldLead = "0ld1ead0-0000-0000-0000-000000000001";
        const listedLead = "115ted00-0000-0000-0000-000000000002";
        mkdirSync(join(project, oldLead, "subagents"), { recursive: true });
        write(join(project, `${oldLead}.jsonl`), "{}\n", NOW - 48 * HOUR);
        const record = (lead: string, file: string, mtime: number) => ({
            filePath: join(project, lead, "subagents", file),
            sessionId: lead,
            customTitle: null,
            summary: null,
            firstPrompt: null,
            gitBranch: null,
            project: "demo",
            cwd: "/tmp/demo",
            mtime,
            firstTimestamp: null,
            isSubagent: true,
            allUserText: null,
        });
        const since = NOW - 24 * HOUR;

        const rows = await parentsOfRecentAgents(since, new Set([listedLead]), async () => [
            record(oldLead, "agent-a1.jsonl", NOW - HOUR),
            record(oldLead, "agent-a2.jsonl", NOW - 2 * HOUR),
            record(listedLead, "agent-a3.jsonl", NOW - HOUR),
            // Older than the window: ignored even when the listing returns it.
            record("stale000-0000-0000-0000-000000000003", "agent-a4.jsonl", NOW - 30 * HOUR),
        ]);
        expect(rows).toEqual([
            {
                sessionId: oldLead,
                title: null,
                project: "demo",
                cwd: "/tmp/demo",
                filePath: join(project, `${oldLead}.jsonl`),
                model: null,
                account: null,
                mtime: NOW - 48 * HOUR,
            },
        ]);
    });
});

describe("tools hub agents counts", () => {
    test("reads only the asked agents; status, tool calls, size and last write per agent", async () => {
        const { teams, row, dir } = fixture();
        const counts = await agentCounts({
            session: row.filePath,
            ids: ["aworker-one-0000000000000001", "agent-arunning000000001", "anot-there"],
            now: NOW,
            teamsRoot: teams,
        });
        expect(counts.generatedAt).toBe(new Date(NOW).toISOString());
        expect(counts.agents.map(({ id, status, toolCalls }) => ({ id, status, toolCalls }))).toEqual([
            { id: "aworker-one-0000000000000001", status: "idle", toolCalls: 2 },
            { id: "arunning000000001", status: "running", toolCalls: 1 },
        ]);
        const one = counts.agents[0];
        expect(one.bytes).toBe(Bun.file(join(dir, "agent-aworker-one-0000000000000001.jsonl")).size);
        expect(one.lastAt).toBe(new Date(NOW - 30 * 60_000).toISOString());
    });

    test("`agents counts --session P --ids a,b --json` reaches counts although `agents` has its own --session", async () => {
        const asked: unknown[] = [];
        const program = new Command().name("hub").option("-v, --verbose");
        program.exitOverride();
        registerAgentsCommand(program, {
            tree: async () => {
                throw new Error("the list must not be read");
            },
            agent: async () => null,
            mail: async () => ({ received: [], sent: [], unread: [] }),
            counts: async (options) => {
                asked.push(options);
                return { generatedAt: "", agents: [] };
            },
        });

        await program.parseAsync(["agents", "counts", "--session", "5e551011", "--ids", "a1, a2,", "--json"], {
            from: "user",
        });
        expect(asked).toEqual([{ session: "5e551011", ids: ["a1", "a2"] }]);
    });
});
