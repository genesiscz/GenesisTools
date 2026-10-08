import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import * as storage from "@genesiscz/utils/storage/storage";
import {
    attachCodexAgents,
    buildCodexParent,
    type CodexAgentRecord,
    codexAgentHeadOf,
    codexAgentModel,
    codexTurnState,
} from "./codex-agents";
import type { ParentRow } from "./tree";

const NOW = Date.parse("2026-10-05T18:00:00.000Z");
const ROOT = "01a10953-2956-7180-8465-61f7415518c0";
const CHILD_A = "01a10957-6e74-7230-b614-9ca6c30768cd";
const CHILD_B = "01a10ccb-92f8-7c90-81c6-052fc8ce675e";
const GRANDCHILD = "01a10cd0-0000-7000-8000-000000000001";

const dirs: string[] = [];

afterEach(() => {
    dirs.length = 0;
});

function temp(): string {
    const dir = mkdtempSync(join(tmpdir(), "gt-hub-codex-agents-"));
    dirs.push(dir);
    return dir;
}

function line(record: unknown): string {
    return `${SafeJSON.stringify(record)}\n`;
}

/** The first line of a real Codex sub-agent rollout: the link fields sit in its first kilobyte. */
function meta(options: { id: string; parent: string; depth: number; nickname: string; role: string; path: string }) {
    return line({
        timestamp: "2026-10-05T10:00:00.000Z",
        ordinal: 0,
        type: "session_meta",
        payload: {
            creator_user_id: "user-example",
            session_id: ROOT,
            id: options.id,
            parent_thread_id: options.parent,
            timestamp: "2026-10-05T10:00:00.000Z",
            cwd: "/work/app",
            source: {
                subagent: {
                    thread_spawn: {
                        parent_thread_id: options.parent,
                        depth: options.depth,
                        agent_path: options.path,
                        agent_nickname: options.nickname,
                        agent_role: options.role,
                    },
                },
            },
            thread_source: "subagent",
            agent_nickname: options.nickname,
            agent_role: options.role,
            agent_path: options.path,
            base_instructions: { text: "x".repeat(20_000) },
        },
    });
}

const turn = (type: "task_started" | "task_complete" | "turn_aborted") =>
    line({ type: "event_msg", payload: { type } });
const call = (kind: "custom_tool_call" | "function_call" | "custom_tool_call_output") =>
    line({ type: "response_item", payload: { type: kind, name: "exec" } });
/** After the instructions and the world state, as in a real rollout: 300 KB in. */
const turnContext = (model: string) =>
    line({ type: "response_item", payload: { type: "message", text: "y".repeat(300_000) } }) +
    line({ type: "turn_context", payload: { turn_id: "t1", model, cwd: "/work/app" } });

function rollout(dir: string, id: string, text: string, ageMs: number): { filePath: string; mtime: number } {
    const filePath = join(dir, `rollout-2026-10-05T10-00-00-${id}.jsonl`);
    const mtime = NOW - ageMs;

    mkdirSync(dir, { recursive: true });
    writeFileSync(filePath, text);
    utimesSync(filePath, mtime / 1000, mtime / 1000);
    return { filePath, mtime };
}

function record(id: string, file: { filePath: string; mtime: number }): CodexAgentRecord {
    return { id, rootId: ROOT, filePath: file.filePath, mtime: file.mtime, cwd: "/work/app" };
}

describe("codexAgentHeadOf", () => {
    test("reads the link and the names from the first kilobyte, whatever follows", () => {
        const file = rollout(
            temp(),
            CHILD_A,
            meta({
                id: CHILD_A,
                parent: ROOT,
                depth: 1,
                nickname: "Cicero",
                role: "worker",
                path: "/root/astra1_runtime",
            }),
            60_000
        );

        expect(codexAgentHeadOf(file.filePath)).toEqual({
            parentId: ROOT,
            depth: 1,
            nickname: "Cicero",
            role: "worker",
            agentPath: "/root/astra1_runtime",
            startedAt: "2026-10-05T10:00:00.000Z",
        });
    });

    test("reads the native header shape: source.subagent.thread_spawn with no thread_source field", () => {
        const native = line({
            timestamp: "2026-10-05T10:00:00.000Z",
            type: "session_meta",
            payload: {
                id: CHILD_A,
                session_id: ROOT,
                cwd: "/work/app",
                source: { subagent: { thread_spawn: { parent_thread_id: ROOT, depth: 1, agent_nickname: "Ada" } } },
            },
        });
        const file = rollout(temp(), CHILD_A, native, 60_000);

        expect(codexAgentHeadOf(file.filePath)).toMatchObject({ parentId: ROOT, depth: 1, nickname: "Ada" });
    });

    test("a rollout that is not a sub-agent has no head", () => {
        const file = rollout(
            temp(),
            ROOT,
            line({
                type: "session_meta",
                payload: { id: ROOT, session_id: ROOT, cwd: "/work/app", thread_source: "user" },
            }),
            60_000
        );

        expect(codexAgentHeadOf(file.filePath)).toBeNull();
    });
});

describe("codexTurnState", () => {
    const stateOf = (text: string, ageMs: number) => {
        const file = rollout(temp(), CHILD_A, text, ageMs);

        return codexTurnState({ filePath: file.filePath, mtime: file.mtime, now: NOW });
    };

    test("a finished turn is completed, however fresh the file", () => {
        expect(stateOf(turn("task_started") + turn("task_complete"), 5_000)).toBe("completed");
    });

    test("a turn that began and has not ended is running while the file is fresh, killed once it went quiet", () => {
        expect(stateOf(turn("task_started") + turn("task_complete") + turn("task_started"), 30_000)).toBe("running");
        expect(stateOf(turn("task_started"), 20 * 60_000)).toBe("killed");
    });

    test("an aborted turn is killed, and a turn that follows it runs again", () => {
        expect(stateOf(turn("task_started") + turn("turn_aborted"), 5_000)).toBe("killed");
        expect(stateOf(turn("task_started") + turn("turn_aborted") + turn("task_started"), 5_000)).toBe("running");
    });
});

describe("codexAgentModel", () => {
    test("is the model of the first turn_context, found past 300 KB of instructions", () => {
        const file = rollout(
            temp(),
            CHILD_A,
            meta({ id: CHILD_A, parent: ROOT, depth: 1, nickname: "Cicero", role: "worker", path: "/root/a" }) +
                turnContext("gpt-6.1-sol"),
            60_000
        );

        expect(codexAgentModel(file.filePath)).toBe("gpt-6.1-sol");
    });

    test("is null before the turn_context is written", () => {
        const file = rollout(
            temp(),
            CHILD_A,
            meta({ id: CHILD_A, parent: ROOT, depth: 1, nickname: "Cicero", role: "worker", path: "/root/a" }),
            60_000
        );

        expect(codexAgentModel(file.filePath)).toBeNull();
    });
});

describe("attachCodexAgents", () => {
    function family() {
        const dir = temp();
        const a = rollout(
            dir,
            CHILD_A,
            meta({ id: CHILD_A, parent: ROOT, depth: 1, nickname: "Cicero", role: "worker", path: "/root/a" }) +
                turnContext("gpt-6.1-sol") +
                turn("task_started") +
                call("custom_tool_call") +
                call("function_call") +
                call("custom_tool_call_output") +
                turn("task_complete"),
            3_600_000
        );
        const b = rollout(
            dir,
            CHILD_B,
            meta({ id: CHILD_B, parent: ROOT, depth: 1, nickname: "James", role: "explorer", path: "/root/b" }) +
                turn("task_started"),
            20_000
        );
        const g = rollout(
            dir,
            GRANDCHILD,
            meta({ id: GRANDCHILD, parent: CHILD_B, depth: 2, nickname: "Pip", role: "worker", path: "/root/b/c" }) +
                turn("task_started") +
                turn("task_complete"),
            10_000
        );

        return {
            records: [record(CHILD_A, a), record(CHILD_B, b), record(GRANDCHILD, g)],
            cache: join(dir, "cache.json"),
        };
    }

    test("hangs each agent under the thread that spawned it, and a nested one under its spawner", () => {
        const { records, cache } = family();
        const tops = attachCodexAgents(records, { now: NOW, cachePath: cache, model: "gpt-lead" });
        const children = tops.get(ROOT) ?? [];

        expect(children.map((node) => node.id)).toEqual([CHILD_B, CHILD_A]);
        expect(children.find((node) => node.id === CHILD_B)?.children.map((node) => node.id)).toEqual([GRANDCHILD]);
    });

    test("an active grandchild whose spawner fell out of the window still hangs under the lead", () => {
        const { records, cache } = family();
        const onlyGrandchild = records.filter((r) => r.id === GRANDCHILD);
        const tops = attachCodexAgents(onlyGrandchild, { now: NOW, cachePath: cache, model: null });

        expect([...tops.keys()]).toEqual([ROOT]);
        expect((tops.get(ROOT) ?? []).map((node) => node.id)).toEqual([GRANDCHILD]);
    });

    test("a node carries what the Agents tab shows: harness, task name, role, own model, status, tool calls", () => {
        const { records, cache } = family();
        const tops = attachCodexAgents(records, { now: NOW, cachePath: cache, model: "gpt-lead" });
        const children = tops.get(ROOT) ?? [];
        const a = children.find((node) => node.id === CHILD_A);
        const b = children.find((node) => node.id === CHILD_B);

        expect(a).toMatchObject({
            harness: "codex",
            kind: "worker",
            name: "Cicero",
            description: "a",
            agentType: "worker",
            // Its own model, not the lead's.
            model: "gpt-6.1-sol",
            status: "completed",
            toolCalls: 2,
            spawnPrompt: null,
            spawnPromptPreview: null,
            spawnDepth: 1,
            filePath: records[0]?.filePath,
        });
        // No turn_context yet: the lead's model stands in.
        expect(b?.model).toBe("gpt-lead");
    });

    test("a running agent sorts first, and the tool count grows by the appended bytes only", () => {
        const { records, cache } = family();
        const options = { now: NOW, cachePath: cache, model: null };

        attachCodexAgents(records, options);
        writeFileSync(records[0]?.filePath ?? "", call("custom_tool_call"), { flag: "a" });

        const again = attachCodexAgents(records, options);
        const a = (again.get(ROOT) ?? []).find((node) => node.id === CHILD_A);

        expect(a?.toolCalls).toBe(3);
        expect(again.get(ROOT)?.[0]?.id).toBe(CHILD_B);
    });

    test("read-only codex roster reads no memo writes while intentional refreshes still publish them", () => {
        const { records, cache } = family();
        const publish = storage.atomicWriteFileSync;
        let allowWrite = false;
        const write = spyOn(storage, "atomicWriteFileSync").mockImplementation((...args) => {
            if (!allowWrite) {
                throw new Error("Diagnostic reached the durable memo writer");
            }
            return publish(...args);
        });
        try {
            const before = attachCodexAgents(records, { now: NOW, cachePath: cache, model: null, readOnly: true });
            expect(before.get(ROOT)).toHaveLength(2);
            expect(write).not.toHaveBeenCalled();
            expect(existsSync(cache)).toBe(false);
            allowWrite = true;
            attachCodexAgents(records, { now: NOW, cachePath: cache, model: null, readOnly: false });
            allowWrite = false;
            expect(write).toHaveBeenCalledTimes(1);
            const bytes = readFileSync(cache);
            writeFileSync(records[0].filePath, call("custom_tool_call"), { flag: "a" });
            const after = attachCodexAgents(records, { now: NOW, cachePath: cache, model: null, readOnly: true });
            expect(after.get(ROOT)?.find((node) => node.id === CHILD_A)?.toolCalls).toBe(3);
            expect(readFileSync(cache)).toEqual(bytes);
            expect(write).toHaveBeenCalledTimes(1);
        } finally {
            write.mockRestore();
        }
    });

    test("a head that cannot be read leaves the agent out instead of failing the list", () => {
        const { records, cache } = family();
        const broken: CodexAgentRecord = {
            id: "ghost",
            rootId: ROOT,
            filePath: "/nonexistent/x.jsonl",
            mtime: NOW,
            cwd: "/",
        };
        const tops = attachCodexAgents([broken, ...records], { now: NOW, cachePath: cache, model: null });

        expect((tops.get(ROOT) ?? []).map((node) => node.id)).toEqual([CHILD_B, CHILD_A]);
    });
});

describe("buildCodexParent", () => {
    const row: ParentRow = {
        provider: "codex",
        sessionId: ROOT,
        title: "Research AI career paths and tools",
        project: "GenesisTools",
        cwd: "/work/app",
        filePath: "/codex/rollout.jsonl",
        model: "gpt-test",
        account: "work",
        mtime: NOW - 30_000,
    };

    test("is a codex parent whose running child makes it live even when its own file went quiet", () => {
        const quiet = buildCodexParent({ ...row, mtime: NOW - 3_600_000 }, [], NOW, "2026-10-04T23:50:07.467Z");
        const { records, cache } = (() => {
            const file = rollout(
                temp(),
                CHILD_B,
                meta({ id: CHILD_B, parent: ROOT, depth: 1, nickname: "James", role: "worker", path: "/root/b" }) +
                    turn("task_started"),
                5_000
            );

            return { records: [record(CHILD_B, file)], cache: join(temp(), "cache.json") };
        })();
        const children = attachCodexAgents(records, { now: NOW, cachePath: cache, model: null }).get(ROOT) ?? [];
        const withRunning = buildCodexParent({ ...row, mtime: NOW - 3_600_000 }, children, NOW, null);

        expect(quiet).toMatchObject({
            provider: "codex",
            sessionId: ROOT,
            live: false,
            startedAt: "2026-10-04T23:50:07.467Z",
        });
        expect(withRunning.live).toBe(true);
        // The agent's model and account default to the lead's.
        expect(withRunning.children[0]).toMatchObject({ model: "gpt-test", account: "work" });
        expect(buildCodexParent(row, [], NOW, null).live).toBe(true);
    });
});
