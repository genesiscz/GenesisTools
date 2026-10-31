import { describe, expect, it, spyOn } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ChatAnswerRun, userMessageOutcome } from "@app/question/lib/decisions/chat-answer-run";
import {
    type DecisionsHookConfig,
    decisionHooksWanted,
    decisionStopWanted,
} from "@app/question/lib/decisions/hook-config";
import { sendAnsweredDecisions } from "@app/question/lib/decisions/send";
import { postDecisions, readDecisions, updateDecision } from "@app/question/lib/decisions/store";
import { createClaudeHistoryOperations } from "@genesiscz/utils/agent-sessions/readers/claude";
import { createCodexHistoryOperations } from "@genesiscz/utils/agent-sessions/readers/codex";
import { createGrokHistoryOperations } from "@genesiscz/utils/agent-sessions/readers/grok";
import type { NativeHistoryEntry } from "@genesiscz/utils/agent-sessions/types";
import { SafeJSON } from "@genesiscz/utils/json";
import { atomicWriteIo } from "@genesiscz/utils/storage/atomic-file";
import { DEFAULT_HOOKS_CONFIG, wantedEntryKinds } from "./config";
import { finalReply, type PromptHookOutput, type ReadSession, runDecisionInject, runDecisionStop } from "./decisions";
import { entriesFor, installHooks, readSettings } from "./install";
import type { HookPayload } from "./payload";
import { parseHookPayload } from "./payload";
import { applySetting } from "./set-config";

describe("decision hub hooks", () => {
    const decisionsOn = (overrides: Partial<DecisionsHookConfig> = {}): DecisionsHookConfig => ({
        ...DEFAULT_HOOKS_CONFIG.decisions,
        stopHook: "block",
        ...overrides,
    });

    function stopPayload(reply: string, extra: Record<string, unknown> = {}): HookPayload {
        const parsed = parseHookPayload(
            SafeJSON.stringify({
                hook_event_name: "Stop",
                session_id: "sess-1",
                cwd: "/tmp",
                last_assistant_message: reply,
                ...extra,
            })
        );

        if (!parsed) {
            throw new Error("fixture payload did not parse");
        }

        return parsed;
    }

    function harness() {
        const dir = mkdtempSync(join(tmpdir(), "gt-decision-hooks-"));
        const log = { file: join(dir, "decisions.jsonl"), events: join(dir, "events.jsonl") };
        const blocks = new Map<string, number>();
        const counts = {
            read: (session: string) => blocks.get(session) ?? 0,
            bump: (session: string) => {
                blocks.set(session, (blocks.get(session) ?? 0) + 1);
            },
        };

        return { log, counts, deps: { log, counts } };
    }

    const asking = "Ready.\n\n❓ DECISION 1 — Cache\nKeep it?\n- a) yes\n- b) no";

    it("ships off: no Stop or prompt entry is wired and a reply with a marker is left alone", async () => {
        const { deps, log } = harness();

        expect(DEFAULT_HOOKS_CONFIG.decisions).toMatchObject({ stopHook: "off", harvest: false, injectAnswers: false });
        expect(decisionHooksWanted(DEFAULT_HOOKS_CONFIG)).toBe(false);
        expect(await runDecisionStop(stopPayload(asking), DEFAULT_HOOKS_CONFIG.decisions, deps)).toBeNull();
        expect(existsSync(log.file)).toBe(false);
    });

    it("leaves a normal turn with no ❓ untouched even in block mode with harvest on", async () => {
        const { deps, log } = harness();
        const output = await runDecisionStop(stopPayload("Done. Tests pass."), decisionsOn({ harvest: true }), deps);

        expect(output).toBeNull();
        expect(existsSync(log.file)).toBe(false);
    });

    it("blocks an unposted DECISION, counts it, and falls back to a warning past the loop guard", async () => {
        const { deps, counts } = harness();
        const config = decisionsOn({ maxBlocksPerSession: 1 });

        const first = await runDecisionStop(stopPayload(asking), config, deps);
        expect(first).toMatchObject({ decision: "block" });
        expect(counts.read("sess-1")).toBe(1);

        const second = await runDecisionStop(stopPayload(asking), config, deps);
        expect(second).toHaveProperty("systemMessage");
        expect(counts.read("sess-1")).toBe(1);
    });

    it("warn mode only tells the user, and a posted number passes", async () => {
        const { deps, log } = harness();
        const warn = await runDecisionStop(stopPayload(asking), decisionsOn({ stopHook: "warn" }), deps);

        expect(warn).toHaveProperty("systemMessage");

        await postDecisions(log.file, log.events, {
            sessionId: "sess-1",
            decisions: [{ prompt: "Keep it?", options: [] }],
        });
        expect(await runDecisionStop(stopPayload(asking), decisionsOn(), deps)).toBeNull();
    });

    it("skips a harness that is not listed", async () => {
        const { deps } = harness();
        const codex = stopPayload(asking, { model: "gpt-5" });

        expect(codex.harness).toBe("codex");
        expect(await runDecisionStop(codex, decisionsOn({ harnesses: ["claude"] }), deps)).toBeNull();
    });

    it("harvest stores the unposted block under its number instead of blocking", async () => {
        const { deps, log } = harness();
        const output = await runDecisionStop(stopPayload(asking), decisionsOn({ harvest: true }), deps);

        expect(output).toEqual({ systemMessage: "Stored ❓ DECISION 1 from the reply so the hub shows it." });
        expect(readDecisions(log.file).map((row) => [row.id, row.options, row.harvested])).toEqual([
            ["d_1_sess-1", ["yes", "no"], true],
        ]);
    });

    it("reads the final reply through each provider, preserving all text blocks in its last row", async () => {
        const fixtures = [
            {
                kind: "claude" as const,
                rows: [
                    { type: "user", message: { content: "go" } },
                    { type: "assistant", message: { content: [{ type: "text", text: "old" }] } },
                    {
                        type: "assistant",
                        message: {
                            content: [
                                { type: "text", text: "❓ DECISION 2" },
                                { type: "text", text: "Choose?" },
                            ],
                        },
                    },
                ],
            },
            {
                kind: "codex" as const,
                rows: [
                    {
                        type: "response_item",
                        payload: { type: "message", role: "user", content: [{ type: "input_text", text: "go" }] },
                    },
                    {
                        type: "response_item",
                        payload: {
                            type: "message",
                            role: "assistant",
                            content: [
                                { type: "output_text", text: "❓ DECISION 2" },
                                { type: "output_text", text: "Choose?" },
                            ],
                        },
                    },
                ],
            },
            {
                kind: "grok" as const,
                rows: [
                    { type: "user", content: [{ type: "text", text: "<user_query>go</user_query>" }] },
                    {
                        type: "assistant",
                        content: [
                            { type: "text", text: "❓ DECISION 2" },
                            { type: "text", text: "Choose?" },
                        ],
                    },
                ],
            },
        ];

        for (const { kind, rows } of fixtures) {
            const transcriptPath = join(mkdtempSync(join(tmpdir(), "gt-final-reply-")), "chat_history.jsonl");
            writeFileSync(transcriptPath, rows.map((row) => SafeJSON.stringify(row)).join("\n"));
            // Each provider receives the native source type through its own implementation below.
            const read: ReadSession = async (options) => {
                const source = {
                    root: "/",
                    sourceHome: "/",
                    filePath: transcriptPath,
                    dataPaths: [transcriptPath],
                    metadataPaths: [],
                };

                if (kind === "claude") {
                    return createClaudeHistoryOperations().readBackward({ ...source, kind: "claude" }, options);
                }

                if (kind === "codex") {
                    return createCodexHistoryOperations().readBackward({ ...source, kind: "codex" }, options);
                }

                return createGrokHistoryOperations().readBackward({ ...source, kind: "grok" }, options);
            };
            const payload = {
                ...stopPayload("", { last_assistant_message: undefined, transcript_path: transcriptPath }),
                harness: kind,
            };
            expect(await finalReply(payload, read)).toBe("❓ DECISION 2\nChoose?");
            expect(await finalReply(stopPayload("given"), read)).toBe("given");
        }
    });

    it("records an unambiguous chat answer as automatic_heuristic and sends the agent back once about an unclear one", async () => {
        const { log, counts } = harness();
        const [keep, ship] = await postDecisions(log.file, log.events, {
            sessionId: "sess-1",
            decisions: [
                { prompt: "Keep it?", options: ["yes", "no"] },
                { prompt: "Ship it?", options: ["now", "later"] },
            ],
        });
        const after = (minutes: number) => new Date(Date.parse(keep.createdTs ?? "") + minutes * 60_000).toISOString();
        const reads: { kind: string; transcriptPath: string; old: boolean }[] = [];
        const chat = new Map<string, number>();
        const deps = {
            log,
            counts,
            now: () => Date.parse(after(10)),
            chat: {
                checkedAt: (session: string) => chat.get(`${session}:checked`),
                offset: () => undefined,
                setOffset: () => undefined,
                setCheckedAt: (session: string, at: number) => {
                    chat.set(`${session}:checked`, at);
                },
                sentBack: (session: string, id: string) => chat.has(`${session}:${id}`),
                markSentBack: (session: string, ids: string[]) => {
                    for (const id of ids) {
                        chat.set(`${session}:${id}`, 1);
                    }
                },
            },
            readSession: async (options: {
                kind: string;
                transcriptPath: string;
                until: (entry: NativeHistoryEntry) => boolean;
            }) => {
                const old = options.until({
                    line: -9,
                    role: "user",
                    text: "old",
                    paths: [],
                    commits: [],
                    timestamp: after(-5),
                });
                reads.push({ kind: options.kind, transcriptPath: options.transcriptPath, old });
                const entry = (
                    role: NativeHistoryEntry["role"],
                    text: string,
                    minutes: number
                ): NativeHistoryEntry => ({
                    line: -minutes,
                    role,
                    text,
                    paths: [],
                    commits: [],
                    timestamp: after(minutes),
                });

                return {
                    found: true,
                    issues: [],
                    entries: [
                        entry("assistant", "❓ DECISION 1 — Keep\n❓ DECISION 2 — Ship", 1),
                        entry("user", "D1 b) drop it\nand D2 when you can", 2),
                        entry("assistant", "Recap: [❓ DECISION 1](link) is open.", 3),
                    ],
                };
            },
        };
        const payload = stopPayload("Done.", { transcript_path: "/tmp/sess-1.jsonl" });

        expect(await runDecisionStop(payload, decisionsOn({ chatAnswers: "off" }), deps)).toBeNull();
        expect(reads).toEqual([]);

        const first = await runDecisionStop(payload, decisionsOn({ chatAnswers: "record" }), deps);

        // The read stops at the first entry older than the oldest open ask, and goes through the session's harness.
        expect(reads).toEqual([{ kind: "claude", transcriptPath: "/tmp/sess-1.jsonl", old: true }]);
        expect(first && "decision" in first ? first.reason : "").toContain(
            "Recorded the chat answer to ❓ DECISION 1 b)"
        );
        expect(first && "decision" in first ? first.reason : "").toContain(
            '❓ DECISION 2 (mentioned without an option): "and D2 when you can"'
        );
        const [stored, open] = readDecisions(log.file);
        expect(stored).toMatchObject({ id: keep.id, state: "acknowledged", option: "b", answer: "drop it" });
        expect(stored?.answeredVia).toBe("automatic_heuristic");
        expect(stored?.comments?.at(-1)).toContain('"D1 b) drop it"');
        expect(open).toMatchObject({ id: ship.id, state: "open" });

        // Said once per decision: the next Stop reads again and says nothing about DECISION 2.
        expect(await runDecisionStop(payload, decisionsOn({ chatAnswers: "record" }), deps)).toBeNull();
        expect(readDecisions(log.file)[1]?.state).toBe("open");
    });

    it("reads each transcript row once: from the agent's last reply on, a bare answer still found", async () => {
        const { log, counts } = harness();
        const [row] = await postDecisions(log.file, log.events, {
            sessionId: "sess-1",
            decisions: [{ prompt: "Keep?", options: ["yes", "no"] }],
        });
        const at = (minutes: number) => new Date(Date.parse(row.createdTs ?? "") + minutes * 60_000).toISOString();
        const transcriptPath = join(mkdtempSync(join(tmpdir(), "gt-chat-offset-")), "session.jsonl");
        const line = (item: object) => `${SafeJSON.stringify(item)}\n`;
        const before = line({ type: "user", timestamp: at(-60), message: { content: "an old turn" } });
        const reply = line({ type: "assistant", timestamp: at(1), message: { content: "❓ DECISION 1 — Keep?" } });
        writeFileSync(transcriptPath, `${before}${reply}`);
        const offsets = new Map<string, number>();
        let checked: number | undefined;
        let now = Date.parse(at(2));
        const asked: { fromOffset?: number; maxBytes?: number }[] = [];
        const readSession: ReadSession = (options) => {
            asked.push({ fromOffset: options.fromOffset, maxBytes: options.maxBytes });
            return createClaudeHistoryOperations().readBackward(
                {
                    kind: "claude",
                    root: "/",
                    sourceHome: "/",
                    filePath: transcriptPath,
                    dataPaths: [transcriptPath],
                    metadataPaths: [],
                },
                options
            );
        };
        const runs: ChatAnswerRun[] = [];
        const deps = {
            log,
            counts,
            readSession,
            now: () => now,
            appendRun: (run: ChatAnswerRun) => {
                runs.push(run);
            },
            chat: {
                checkedAt: () => checked,
                setCheckedAt: (_session: string, value: number) => {
                    checked = value;
                },
                offset: (_session: string, path: string) => offsets.get(path),
                setOffset: (_session: string, path: string, value: number) => {
                    offsets.set(path, value);
                },
                sentBack: () => false,
                markSentBack: () => undefined,
            },
        };
        const payload = stopPayload("Done.", { transcript_path: transcriptPath });

        // First Stop: no offset yet, so it reads back by time; the next read starts at the reply that asked.
        expect(await runDecisionStop(payload, decisionsOn({ chatAnswers: "record" }), deps)).toBeNull();
        expect(asked[0]).toEqual({ fromOffset: undefined, maxBytes: 512 * 1024 * 1024 });
        expect(offsets.get(transcriptPath)).toBe(Buffer.byteLength(before));

        // The user answers with a bare letter; the agent replies. Only the rows from the asking reply on are read.
        writeFileSync(
            transcriptPath,
            `${before}${reply}${line({ type: "user", timestamp: at(3), message: { content: "b)" } })}${line({
                type: "assistant",
                timestamp: at(4),
                message: { content: "Dropping it." },
            })}`
        );
        now = Date.parse(at(5));
        expect(await runDecisionStop(payload, decisionsOn({ chatAnswers: "record" }), deps)).toHaveProperty(
            "systemMessage"
        );
        expect(asked[1]).toEqual({ fromOffset: Buffer.byteLength(before), maxBytes: Number.POSITIVE_INFINITY });
        expect(runs[1]?.read).toMatchObject({ fromOffset: Buffer.byteLength(before), entries: 3 });
        expect(readDecisions(log.file)[0]).toMatchObject({ id: row.id, state: "acknowledged", option: "b" });

        // A transcript shorter than the stored offset was replaced: the offset is ignored and the read goes by time.
        offsets.set(transcriptPath, 10_000_000);
        await postDecisions(log.file, log.events, {
            sessionId: "sess-1",
            decisions: [{ prompt: "Ship?", options: ["now"] }],
        });
        await runDecisionStop(payload, decisionsOn({ chatAnswers: "record" }), deps);
        expect(asked[2]?.fromOffset).toBeUndefined();
    });

    it("keeps a split assistant ask at the cursor boundary for a bare answer on the next Stop", async () => {
        const { log, counts } = harness();
        const [row] = await postDecisions(log.file, log.events, {
            sessionId: "sess-1",
            decisions: [{ prompt: "Keep?", options: ["yes", "no"] }],
        });
        const at = (minutes: number) => new Date(Date.parse(row.createdTs ?? "") + minutes * 60_000).toISOString();
        const transcriptPath = join(mkdtempSync(join(tmpdir(), "gt-chat-cursor-")), "session.jsonl");
        const rows = [
            { type: "user", timestamp: at(1), message: { content: "go" } },
            {
                type: "assistant",
                timestamp: at(2),
                message: {
                    content: [
                        { type: "text", text: "❓ DECISION 1 — Keep?" },
                        { type: "text", text: "- a) yes\n- b) no" },
                    ],
                },
            },
        ];
        const writeTranscript = () =>
            writeFileSync(transcriptPath, rows.map((item) => SafeJSON.stringify(item)).join("\n"));
        const runs: ChatAnswerRun[] = [];
        let checked: number | undefined;
        let now = Date.parse(at(3));
        const readSession: ReadSession = (options) =>
            createClaudeHistoryOperations().readBackward(
                {
                    kind: "claude",
                    root: "/",
                    sourceHome: "/",
                    filePath: transcriptPath,
                    dataPaths: [transcriptPath],
                    metadataPaths: [],
                },
                options
            );
        const deps = {
            log,
            counts,
            readSession,
            now: () => now,
            appendRun: (run: ChatAnswerRun) => {
                runs.push(run);
            },
            chat: {
                checkedAt: () => checked,
                offset: () => undefined,
                setOffset: () => undefined,
                setCheckedAt: (_session: string, value: number) => {
                    checked = value;
                },
                sentBack: () => false,
                markSentBack: () => undefined,
            },
        };
        const payload = stopPayload("Done.", { transcript_path: transcriptPath });
        writeTranscript();
        expect(await runDecisionStop(payload, decisionsOn({ chatAnswers: "record" }), deps)).toBeNull();
        expect(checked).toBe(now);

        rows.push({ type: "user", timestamp: at(4), message: { content: "b)" } });
        writeTranscript();
        now = Date.parse(at(5));
        expect(await runDecisionStop(payload, decisionsOn({ chatAnswers: "record" }), deps)).toHaveProperty(
            "systemMessage"
        );
        expect(readDecisions(log.file)[0]).toMatchObject({ id: row.id, state: "acknowledged", option: "b" });
        expect(runs[1]?.recorded).toEqual([row.id]);
    });

    it("does not record a timestamp-free answer from an earlier decision revision", async () => {
        const { log, counts } = harness();
        const [original] = await postDecisions(log.file, log.events, {
            sessionId: "sess-1",
            decisions: [{ prompt: "Keep?", options: ["yes", "no"] }],
        });
        const [revised] = await postDecisions(log.file, log.events, {
            sessionId: "sess-1",
            decisions: [{ prompt: "Ship?", options: ["later", "now"], supersedes: original.id }],
        });
        const transcriptPath = join(mkdtempSync(join(tmpdir(), "gt-chat-revised-")), "chat_history.jsonl");
        writeFileSync(
            transcriptPath,
            [
                { type: "assistant", content: [{ type: "text", text: "❓ DECISION 1 — Keep?" }] },
                { type: "user", content: [{ type: "text", text: "<user_query>D1 b)</user_query>" }] },
                { type: "assistant", content: [{ type: "text", text: "❓ DECISION 1 — Ship?" }] },
            ]
                .map((item) => SafeJSON.stringify(item))
                .join("\n")
        );
        const readSession: ReadSession = (options) =>
            createGrokHistoryOperations().readBackward(
                {
                    kind: "grok",
                    root: "/",
                    sourceHome: "/",
                    filePath: transcriptPath,
                    dataPaths: [transcriptPath],
                    metadataPaths: [],
                },
                options
            );
        const payload = { ...stopPayload("Done.", { transcript_path: transcriptPath }), harness: "grok" as const };
        const runs: ChatAnswerRun[] = [];
        expect(
            await runDecisionStop(payload, decisionsOn({ chatAnswers: "record" }), {
                log,
                counts,
                readSession,
                appendRun: (run) => {
                    runs.push(run);
                },
                chat: {
                    checkedAt: () => undefined,
                    offset: () => undefined,
                    setOffset: () => undefined,
                    setCheckedAt: () => undefined,
                    sentBack: () => false,
                    markSentBack: () => undefined,
                },
            })
        ).toBeNull();
        expect(readDecisions(log.file)[0]).toEqual(revised);
        expect(runs[0]?.recorded).toEqual([]);
    });

    it("retries a chat answer after a failed store write before advancing the cursor", async () => {
        const { log, counts } = harness();
        const [row] = await postDecisions(log.file, log.events, {
            sessionId: "sess-1",
            decisions: [{ prompt: "Keep?", options: ["yes", "no"] }],
        });
        const after = (minutes: number) => new Date(Date.parse(row.createdTs ?? "") + minutes * 60_000).toISOString();
        const entry = (role: NativeHistoryEntry["role"], text: string, minutes: number): NativeHistoryEntry => ({
            line: -4 + minutes,
            role,
            text,
            paths: [],
            commits: [],
            timestamp: after(minutes),
        });
        const entries = [
            entry("assistant", "❓ DECISION 1 — Keep?", 1),
            entry("user", "D1 b) drop it", 2),
            entry("assistant", "Done.", 3),
        ];
        const runs: ChatAnswerRun[] = [];
        let checked: number | undefined;
        const deps = {
            log,
            counts,
            now: () => Date.parse(after(10)),
            appendRun: (run: ChatAnswerRun) => {
                runs.push(run);
            },
            chat: {
                checkedAt: () => checked,
                offset: () => undefined,
                setOffset: () => undefined,
                setCheckedAt: (_session: string, at: number) => {
                    checked = at;
                },
                sentBack: () => false,
                markSentBack: () => undefined,
            },
            readSession: async (options: { until: (entry: NativeHistoryEntry) => boolean }) => {
                let start = 0;

                for (let index = entries.length - 1; index >= 0; index--) {
                    const candidate = entries[index];

                    if (candidate && options.until(candidate)) {
                        start = index;
                        break;
                    }
                }

                return { entries: entries.slice(start), found: start > 0, issues: [] };
            },
        };
        const payload = stopPayload("Done.", { transcript_path: "/fixture.jsonl" });
        const failedWrite = spyOn(atomicWriteIo, "writeSync").mockImplementationOnce(() => {
            throw new Error("simulated ENOSPC");
        });

        try {
            expect(await runDecisionStop(payload, decisionsOn({ chatAnswers: "record" }), deps)).toBeNull();
            expect(failedWrite).toHaveBeenCalledTimes(1);
            expect(readDecisions(log.file)[0]?.state).toBe("open");
            expect(checked).toBeUndefined();
            expect(runs[0]?.recorded).toEqual([]);
        } finally {
            failedWrite.mockRestore();
        }

        expect(await runDecisionStop(payload, decisionsOn({ chatAnswers: "record" }), deps)).toHaveProperty(
            "systemMessage"
        );
        expect(readDecisions(log.file)[0]).toMatchObject({ state: "acknowledged", option: "b", answer: "drop it" });
        expect(runs[1]?.recorded).toEqual([row.id]);
        expect(checked).toBe(Date.parse(after(10)));
    });

    it("logs every chat-answer run with each user message read, and marks the ones that matched nothing", async () => {
        const { log, counts } = harness();
        const [row] = await postDecisions(log.file, log.events, {
            sessionId: "sess-1",
            decisions: [{ prompt: "Keep it?", options: ["yes", "no"] }],
        });
        const at = (minutes: number) => new Date(Date.parse(row.createdTs ?? "") + minutes * 60_000).toISOString();
        const runs: ChatAnswerRun[] = [];
        const user = (text: string, minutes: number): NativeHistoryEntry => ({
            line: -minutes,
            role: "user",
            text,
            paths: [],
            commits: [],
            timestamp: at(minutes),
        });
        const deps = {
            log,
            counts,
            appendRun: (run: ChatAnswerRun) => runs.push(run),
            chat: {
                checkedAt: () => undefined,
                offset: () => undefined,
                setOffset: () => undefined,
                setCheckedAt: () => undefined,
                sentBack: () => false,
                markSentBack: () => undefined,
            },
            readSession: async () => ({
                found: true,
                issues: [],
                entries: [
                    user("first, the cache stays as it is", 1),
                    user(`${"long context ".repeat(40)}\nD1 a) keep it`, 2),
                ],
            }),
        };

        await runDecisionStop(
            stopPayload("Done.", { transcript_path: "/tmp/sess-1.jsonl" }),
            decisionsOn({ chatAnswers: "record" }),
            deps
        );

        const [run] = runs;
        expect(run?.open).toMatchObject([{ id: row.id, number: 1 }]);
        expect(run?.recorded).toEqual([row.id]);
        expect(run?.users.map((message) => (run ? userMessageOutcome(run, message) : ""))).toEqual([
            "no match",
            "recorded D1 a)",
        ]);
        // A long message keeps its start and the line that answers, so a review sees why it matched.
        expect(run?.users[1]?.candidates).toEqual(["D1 a) keep it"]);
    });

    it("logs a completed chat read with no user messages", async () => {
        const { log, counts } = harness();
        await postDecisions(log.file, log.events, {
            sessionId: "sess-1",
            decisions: [{ prompt: "Keep?", options: ["yes", "no"] }],
        });
        const runs: ChatAnswerRun[] = [];
        await runDecisionStop(
            stopPayload("Done.", { transcript_path: "/fixture.jsonl" }),
            decisionsOn({ chatAnswers: "record" }),
            {
                log,
                counts,
                appendRun: (run) => {
                    runs.push(run);
                },
                readSession: async () => ({
                    found: false,
                    entries: [],
                    issues: [{ path: "/fixture.jsonl", message: "maxBytes" }],
                }),
                chat: {
                    checkedAt: () => undefined,
                    offset: () => undefined,
                    setOffset: () => undefined,
                    setCheckedAt: () => undefined,
                    sentBack: () => false,
                    markSentBack: () => undefined,
                },
            }
        );

        expect(runs).toHaveLength(1);
        expect(runs[0]).toMatchObject({ users: [], recorded: [], read: { entries: 0, issues: 1, found: false } });
    });

    it("in remind mode stores nothing and sends the agent back to record the chat answer itself", async () => {
        const { log, counts } = harness();
        const [row] = await postDecisions(log.file, log.events, {
            sessionId: "sess-1",
            decisions: [{ prompt: "Keep it?", options: ["yes", "no"] }],
        });
        const later = new Date(Date.parse(row.createdTs ?? "") + 60_000).toISOString();
        const deps = {
            log,
            counts,
            readSession: async () => ({
                found: true,
                issues: [],
                entries: [{ line: -1, role: "user" as const, text: "1 a)", paths: [], commits: [], timestamp: later }],
            }),
        };
        const output = await runDecisionStop(
            stopPayload("Done.", { transcript_path: "/tmp/sess-1.jsonl", session_id: "sess-remind" }),
            decisionsOn({ chatAnswers: "remind" }),
            deps
        );

        // Another session's decision is not this session's to read.
        expect(output).toBeNull();

        const own = await runDecisionStop(
            stopPayload("Done.", { transcript_path: "/tmp/sess-1.jsonl" }),
            decisionsOn({ chatAnswers: "remind" }),
            {
                ...deps,
                chat: {
                    checkedAt: () => undefined,
                    offset: () => undefined,
                    setOffset: () => undefined,
                    setCheckedAt: () => undefined,
                    sentBack: () => false,
                    markSentBack: () => undefined,
                },
            }
        );

        expect(own && "decision" in own ? own.reason : "").toContain('❓ DECISION 1: a) from "1 a)"');
        expect(readDecisions(log.file)[0]?.state).toBe("open");
    });

    it("hands answered decisions to the next prompt once, and stays silent when off or nothing is due", async () => {
        const { log, counts } = harness();
        const emitted: PromptHookOutput[] = [];
        const deps = { log, counts, emit: (output: PromptHookOutput) => emitted.push(output) };
        const prompt = { ...stopPayload(""), event: "UserPromptSubmit" };
        const [row] = await postDecisions(log.file, log.events, {
            sessionId: "sess-1",
            decisions: [{ prompt: "Keep it?", options: ["yes", "no"] }],
        });
        await updateDecision(log.file, log.events, row.id, { state: "answered", option: "a" });

        expect(await runDecisionInject(prompt, DEFAULT_HOOKS_CONFIG.decisions, deps)).toBeNull();
        expect(readDecisions(log.file)[0]?.state).toBe("answered");

        const output = await runDecisionInject(prompt, decisionsOn({ injectAnswers: true }), deps);
        expect(output?.hookSpecificOutput.additionalContext).toContain("DECISION 1: a) yes");
        expect(emitted).toEqual(output ? [output] : []);
        expect(emitted).toHaveLength(1);
        expect(readDecisions(log.file)[0]?.state).toBe("sent");
        // The hub and /qa read the delivery, not the state: it must not still say "queued".
        expect(readDecisions(log.file)[0]?.delivery?.route).toBe("prompt");
        expect(await runDecisionInject(prompt, decisionsOn({ injectAnswers: true }), deps)).toBeNull();
        expect(emitted).toHaveLength(1);
        // The agent then confirms it read the answer: answered → sent → acknowledged.
        expect((await updateDecision(log.file, log.events, row.id, { state: "acknowledged" })).state).toBe(
            "acknowledged"
        );
    });

    it("does not inject a batch reserved by the sidebar's own submitted prompt", async () => {
        const { log, counts } = harness();
        const emitted: PromptHookOutput[] = [];
        const deps = { log, counts, emit: (output: PromptHookOutput) => emitted.push(output) };
        const prompt = { ...stopPayload(""), event: "UserPromptSubmit" };
        const [row] = await postDecisions(log.file, log.events, {
            sessionId: "sess-1",
            decisions: [{ prompt: "Keep it?", options: ["yes", "no"] }],
        });
        await updateDecision(log.file, log.events, row.id, { state: "answered", option: "a" });
        const prepared = await sendAnsweredDecisions({ session: "sess-1", inSession: true, files: log });
        expect(await runDecisionInject(prompt, decisionsOn({ injectAnswers: true }), deps)).toBeNull();
        expect(emitted).toEqual([]);
        const sent = await sendAnsweredDecisions({
            session: "sess-1",
            inSession: true,
            promptReceipt: prepared.promptReceipt,
            files: log,
        });
        expect(sent.numbers).toEqual([1]);
        expect(readDecisions(log.file)[0]?.state).toBe("sent");
        expect(readDecisions(log.file)[0]?.promptReservation).toBeUndefined();
        expect(await runDecisionInject(prompt, decisionsOn({ injectAnswers: true }), deps)).toBeNull();
    });

    it("keeps the answers queued when the hook output cannot be written", async () => {
        const { log, counts } = harness();
        const prompt = { ...stopPayload(""), event: "UserPromptSubmit" };
        const [row] = await postDecisions(log.file, log.events, {
            sessionId: "sess-1",
            decisions: [{ prompt: "Keep it?", options: ["yes", "no"] }],
        });
        await updateDecision(log.file, log.events, row.id, { state: "answered", option: "a" });
        const broken = {
            log,
            counts,
            emit: () => {
                throw new Error("EPIPE");
            },
        };

        await expect(runDecisionInject(prompt, decisionsOn({ injectAnswers: true }), broken)).rejects.toThrow("EPIPE");
        expect(readDecisions(log.file)[0]?.state).toBe("answered");

        const delivered: PromptHookOutput[] = [];
        const retried = await runDecisionInject(prompt, decisionsOn({ injectAnswers: true }), {
            log,
            counts,
            emit: (output: PromptHookOutput) => delivered.push(output),
        });
        expect(retried?.hookSpecificOutput.additionalContext).toContain("DECISION 1: a) yes");
        expect(delivered).toHaveLength(1);
    });

    it("install wires Stop and UserPromptSubmit only when asked, and removes them when turned off", () => {
        const path = join(mkdtempSync(join(tmpdir(), "gt-hooks-settings-")), "settings.json");
        writeFileSync(
            path,
            SafeJSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "/mine.sh" }] }] } })
        );

        const on = installHooks({ dist: "/dist", settingsPath: path, write: true, decisions: true, unpushed: false });
        expect(on.added).toEqual(expect.arrayContaining(["Stop", "UserPromptSubmit"]));
        expect(readSettings(path).hooks?.Stop?.map((entry) => entry.hooks[0]?.command)).toEqual([
            "/mine.sh",
            "bun '/dist/src/agents/bin/hook-stop.ts'",
        ]);

        const off = installHooks({ dist: "/dist", settingsPath: path, write: true, decisions: false, unpushed: false });
        expect(off.removed).toEqual(["Stop", "UserPromptSubmit"]);
        expect(readSettings(path).hooks?.Stop).toEqual([{ hooks: [{ type: "command", command: "/mine.sh" }] }]);
    });

    it("config set validates the decision keys", () => {
        const next = applySetting(DEFAULT_HOOKS_CONFIG, "decisions.stopHook", "warn");

        expect(next.decisions.stopHook).toBe("warn");
        expect(DEFAULT_HOOKS_CONFIG.decisions.stopHook).toBe("off");
        expect(applySetting(next, "decisions.harnesses", "claude,grok").decisions.harnesses).toEqual([
            "claude",
            "grok",
        ]);
        expect(() => applySetting(next, "decisions.stopHook", "loud")).toThrow(/off, warn or block/);
        expect(() => applySetting(next, "decisions.harnesses", "cursor")).toThrow(/no such harness/);
        expect(applySetting(next, "decisions.questionNudge", "block").decisions.questionNudge).toBe("block");
        expect(DEFAULT_HOOKS_CONFIG.decisions.questionNudge).toBe("off");
        expect(() => applySetting(next, "decisions.questionNudge", "on")).toThrow(/off, warn or block/);
    });

    describe("the question nudge", () => {
        const promptAt = "2026-10-23T09:00:00.000Z";
        const transcript = (prompt: string) =>
            [
                SafeJSON.stringify({ type: "user", timestamp: "2026-10-23T08:00:00.000Z", message: { content: "x" } }),
                SafeJSON.stringify({ type: "user", timestamp: prompt, message: { content: "go" } }),
                SafeJSON.stringify({
                    type: "user",
                    timestamp: "2026-10-23T09:05:00.000Z",
                    message: { content: [{ type: "tool_result", content: "ok" }] },
                }),
                SafeJSON.stringify({
                    type: "user",
                    isMeta: true,
                    timestamp: "2026-10-23T09:06:00.000Z",
                    message: { content: "Stop hook feedback:\nanother hook" },
                }),
            ].join("\n");
        const asks = "Done. One decision is yours.\nShould I keep the cache?";
        const nudgeOn = (overrides: Partial<DecisionsHookConfig> = {}): DecisionsHookConfig =>
            decisionsOn({ stopHook: "off", questionNudge: "block", ...overrides });
        const stop = (reply: string, extra: Record<string, unknown> = {}) =>
            stopPayload(reply, { transcript_path: "/fixture.jsonl", ...extra });

        function nudgeHarness() {
            const base = harness();
            const turns = new Map<string, number>();
            const blocks = new Map<string, number>();
            const tail = { text: transcript(promptAt) };
            const nudge = {
                blocks: (session: string) => blocks.get(session) ?? 0,
                lastTurn: (session: string) => turns.get(session),
                record: (session: string, turn: number, blocked: boolean) => {
                    turns.set(session, turn);
                    blocks.set(session, (blocks.get(session) ?? 0) + (blocked ? 1 : 0));
                },
            };
            const post = (at: string) =>
                postDecisions(
                    base.log.file,
                    base.log.events,
                    { sessionId: "sess-1", decisions: [{ prompt: "Keep the cache?", options: ["yes", "no"] }] },
                    { now: () => at }
                );

            const transcriptPath = join(mkdtempSync(join(tmpdir(), "gt-turn-boundary-")), "session.jsonl");
            const readTurn = async () => {
                writeFileSync(transcriptPath, tail.text);
                return createClaudeHistoryOperations().readTurnBoundary(
                    {
                        kind: "claude",
                        root: "/",
                        sourceHome: "/",
                        filePath: transcriptPath,
                        dataPaths: [transcriptPath],
                        metadataPaths: [],
                    },
                    {}
                );
            };

            return { ...base, blocks, tail, post, deps: { ...base.deps, nudge, readTurn } };
        }

        it("blocks a reply that asks the user to decide when the turn logged no decision, quoting the line", async () => {
            const { deps, blocks } = nudgeHarness();
            const output = await runDecisionStop(stop(asks), nudgeOn(), deps);

            expect(output).toMatchObject({ decision: "block" });
            expect(output && "reason" in output ? output.reason : "").toContain('("Should I keep the cache?")');
            expect(blocks.get("sess-1")).toBe(1);
        });

        it("passes once the session logged a decision after the turn's prompt", async () => {
            const { deps, post } = nudgeHarness();

            await post("2026-10-23T09:03:00.000Z");
            expect(await runDecisionStop(stop(asks), nudgeOn(), deps)).toBeNull();
        });

        it("passes a question about a decision logged in an earlier turn, found in the log, not the transcript", async () => {
            const { deps, post } = nudgeHarness();

            // Logged an hour before this turn's prompt: the log, not the turn, says it reached the inbox.
            await post("2026-10-23T08:00:00.000Z");
            const linked =
                "❓ [DECISION 1](https://genesis.tools/claude/find/sess-1/decision/1) is still open: should each tool " +
                "folder get its own `tsconfig.json`? I recommend a).";

            expect(await runDecisionStop(stop(linked), nudgeOn(), deps)).toBeNull();
            expect(
                await runDecisionStop(stop("D1 is still open.\nShould I keep the cache, decide?"), nudgeOn(), deps)
            ).toBeNull();
            // A question about a number nobody logged still blocks.
            expect(
                await runDecisionStop(stop("D7 is new.\nShould I keep the cache, decide?"), nudgeOn(), deps)
            ).toMatchObject({
                decision: "block",
            });
        });

        it("does not count a decision logged before the turn's prompt", async () => {
            const { deps, post } = nudgeHarness();

            await post("2026-10-23T08:30:00.000Z");
            expect(await runDecisionStop(stop(asks), nudgeOn(), deps)).toMatchObject({ decision: "block" });
        });

        it("passes a question with no decision cue, and a cue inside code or a quote", async () => {
            const { deps } = nudgeHarness();
            const replies = [
                "Tests pass. Should I push?",
                "Should I push?\n```ts\nconst decision = choose();\n```",
                "Should I push? The `decision` field stays.",
                "> Which decision do you want?\nDone. Should I push?",
            ];

            for (const reply of replies) {
                expect(await runDecisionStop(stop(reply), nudgeOn(), deps)).toBeNull();
            }
        });

        it("lets the second Stop of the same turn pass, by Claude's flag or by the turn it already spoke in", async () => {
            const flagged = nudgeHarness();

            expect(await runDecisionStop(stop(asks, { stop_hook_active: true }), nudgeOn(), flagged.deps)).toBeNull();

            const { deps, tail } = nudgeHarness();

            expect(await runDecisionStop(stop(asks), nudgeOn(), deps)).toMatchObject({ decision: "block" });
            expect(await runDecisionStop(stop(asks), nudgeOn(), deps)).toBeNull();

            tail.text = transcript("2026-10-23T10:00:00.000Z");
            expect(await runDecisionStop(stop(asks), nudgeOn(), deps)).toMatchObject({ decision: "block" });
        });

        it("only warns past the per-session cap, and in warn mode", async () => {
            const { deps, tail } = nudgeHarness();

            expect(await runDecisionStop(stop(asks), nudgeOn({ maxBlocksPerSession: 1 }), deps)).toMatchObject({
                decision: "block",
            });
            tail.text = transcript("2026-10-23T10:00:00.000Z");
            expect(await runDecisionStop(stop(asks), nudgeOn({ maxBlocksPerSession: 1 }), deps)).toHaveProperty(
                "systemMessage"
            );
            expect(
                await runDecisionStop(stop(asks), nudgeOn({ questionNudge: "warn" }), nudgeHarness().deps)
            ).toHaveProperty("systemMessage");
        });

        it("never fires while off, and the shipped default is off", async () => {
            const { deps } = nudgeHarness();

            expect(DEFAULT_HOOKS_CONFIG.decisions.questionNudge).toBe("off");
            expect(decisionStopWanted(DEFAULT_HOOKS_CONFIG)).toBe(false);
            expect(await runDecisionStop(stop(asks), decisionsOn({ questionNudge: "off" }), deps)).toBeNull();
            expect(await runDecisionStop(stop(asks), DEFAULT_HOOKS_CONFIG.decisions, deps)).toBeNull();
        });

        it("leaves a reply that names ❓ DECISION N to the existing check", async () => {
            const { deps, post } = nudgeHarness();
            const both = decisionsOn({ questionNudge: "block" });
            const blocked = await runDecisionStop(stop(asking), both, deps);

            expect(blocked && "reason" in blocked ? blocked.reason : "").toContain(
                "Your reply asks ❓ DECISION 1 without posting it."
            );

            await post("2026-10-23T08:30:00.000Z");
            expect(await runDecisionStop(stop(asking), both, deps)).toBeNull();
            expect(await runDecisionStop(stop(asking), nudgeOn(), nudgeHarness().deps)).toBeNull();
        });

        it("stays quiet when the transcript holds no prompt", async () => {
            const { deps } = nudgeHarness();

            expect(await runDecisionStop(stopPayload(asks), nudgeOn(), deps)).toBeNull();
            expect(await runDecisionStop(stop(asks), nudgeOn(), { ...deps, readTurn: async () => null })).toBeNull();
        });

        it("nudges a timestamp-free Grok turn once, then recognizes a new turn", async () => {
            const { deps } = nudgeHarness();
            let key = -12;
            const grok = { ...stop(asks), harness: "grok" as const };
            const options = nudgeOn({ harnesses: ["grok"] });
            const grokDeps = { ...deps, readTurn: async () => ({ key }) };

            expect(await runDecisionStop(grok, options, grokDeps)).toMatchObject({ decision: "block" });
            expect(await runDecisionStop(grok, options, grokDeps)).toBeNull();
            key = -25;
            expect(await runDecisionStop(grok, options, grokDeps)).toMatchObject({ decision: "block" });
        });

        it("wires the Stop hook alone, and the Stop entrypoint loads the decision checks for it", () => {
            const nudging = { ...DEFAULT_HOOKS_CONFIG, decisions: nudgeOn() };
            const alone = { ...nudging, unpushed: { ...DEFAULT_HOOKS_CONFIG.unpushed, enabled: false } };
            const events = entriesFor("/dist", wantedEntryKinds(alone, {})).map((item) => item.event);

            expect(events).toContain("Stop");
            expect(events).not.toContain("UserPromptSubmit");
            expect(decisionStopWanted(nudging)).toBe(true);
            expect(decisionHooksWanted(nudging)).toBe(false);
        });
    });
});
