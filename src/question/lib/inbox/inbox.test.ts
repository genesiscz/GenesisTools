import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSessionRow } from "@app/ai/lib/sessions/agent-session-rows";
import type { TranscriptTurn } from "@genesiscz/utils/ai/transcripts/types";
import { SafeJSON } from "@genesiscz/utils/json";
import { Command } from "commander";
import { type InboxCommandDeps, registerInboxCommand } from "../../commands/inbox";
import { paneMiss } from "../decisions/deliver";
import { livePaneTargets } from "../decisions/deliver.fixtures";
import { parseDecisionBlocks } from "../decisions/read";
import { type DecisionRecord, postDecisions, readDecisions } from "../decisions/store";
import { type AskDeps, getAskForm, postAskForm } from "../pending/ask";
import type { AskForm } from "../pending/types";
import { answerInboxDecision, answerInboxDecisions, answerInboxForm } from "./answer";
import { buildInbox, type InboxSessionInfo, inboxDelivery, scanTurns, sessionDecisions } from "./build";
import { type InboxDeps, loadInbox, waitingBlock } from "./load";

function turn(role: TranscriptTurn["role"], text: string, at = "2026-03-01T10:00:00.000Z"): TranscriptTurn {
    return { id: `${role}-${at}`, role, at, text, tools: [] };
}

const ASK = [
    "Done with the parser.",
    "",
    "❓ DECISION 3: Keep the cache?",
    "- **a)** keep it",
    "- **b)** drop it",
    "",
    "⏳ Still running: the linter.",
].join("\n");

const SESSION: InboxSessionInfo = {
    provider: "claude",
    sessionId: "s-alpha",
    title: "parser work",
    cwd: "/tmp/gt-inbox/app",
    project: "app",
    gitBranch: "feat/parser",
    account: "work",
    mtime: Date.parse("2026-03-01T10:05:00.000Z"),
};

function scratch(): { file: string; events: string } {
    const dir = mkdtempSync(join(tmpdir(), "gt-inbox-"));
    return { file: join(dir, "decisions.jsonl"), events: join(dir, "events.jsonl") };
}

function form(overrides: Partial<AskForm> = {}): AskForm {
    return {
        id: "ask_1",
        createdAt: Date.parse("2026-03-01T09:00:00.000Z"),
        projectPath: "/tmp/gt-inbox/shop",
        cwd: "/tmp/gt-inbox/shop",
        status: "pending",
        items: [{ id: "q1", promptMarkdown: "Ship it?", choices: [{ id: "c1", label: "yes" }] }],
        ...overrides,
    };
}

describe("scanTurns", () => {
    test("the last reply asks a decision: its blocks, without the text after the options", () => {
        const scan = scanTurns([turn("user", "go"), turn("assistant", ASK, "2026-03-01T10:04:00.000Z")]);

        expect(scan?.at).toBe("2026-03-01T10:04:00.000Z");
        expect(scan?.blocks).toMatchObject([
            { number: 3, title: "Keep the cache?", prompt: "Keep the cache?", options: ["keep it", "drop it"] },
        ]);
        // The findings before the block are the context; the ⏳ line after the options is not.
        expect(scan?.blocks[0]?.context).toBe("Done with the parser.");
        expect(scan?.blocks[0]?.context ?? "").not.toContain("Still running");
    });

    test("a user turn after the question, or a reply without a marker, waits on nothing", () => {
        expect(scanTurns([turn("assistant", ASK), turn("user", "a")])).toBeNull();
        expect(scanTurns([turn("assistant", ASK), turn("assistant", "All done.")])).toBeNull();
        expect(scanTurns([turn("assistant", ASK), turn("assistant", "   ")])?.blocks[0]?.number).toBe(3);
        expect(scanTurns([])).toBeNull();
    });

    test("a heading ends a block even before its options", () => {
        expect(parseDecisionBlocks("❓ DECISION 1: Rename?\n## Next\nsomething else")).toEqual([
            { number: 1, title: "Rename?", prompt: "Rename?", options: [] },
        ]);
    });
});

describe("buildInbox", () => {
    test("transcript decisions, open store rows and pending forms, grouped by session", () => {
        const stored: DecisionRecord = {
            id: "d_9_s-beta",
            sessionId: "s-beta",
            number: 9,
            prompt: "Which port?",
            options: ["3000", "4000"],
            recommended: "b",
            blocking: true,
            state: "open",
            sessionTitle: "server",
            createdTs: "2026-03-01T08:00:00.000Z",
            updatedTs: "2026-03-01T08:00:00.000Z",
        };
        const inbox = buildInbox({
            sessions: [SESSION],
            scans: new Map([["s-alpha", scanTurns([turn("assistant", ASK)]) ?? { at: null, blocks: [] }]]),
            rows: [stored],
            forms: [form({ sessionHint: "s-alpha" }), form({ id: "ask_2" })],
        });

        expect(
            inbox.map((session) => [session.sessionId, session.waiting, session.items.map((item) => item.id)])
        ).toEqual([
            ["s-alpha", 2, ["ask_1", "d_3_s-alpha"]],
            [null, 1, ["ask_2"]],
            ["s-beta", 1, ["d_9_s-beta"]],
        ]);
        expect(inbox[0]).toMatchObject({
            title: "parser work",
            project: "app",
            branch: "feat/parser",
            account: "work",
        });
        expect(inbox[2]).toMatchObject({ title: "server", project: null });
        expect(inbox[2]?.items[0]).toMatchObject({ recommended: "b", blocking: true, source: "store" });
        expect(inbox[1]).toMatchObject({ project: "shop", cwd: "/tmp/gt-inbox/shop" });
    });

    test("a stored answer wins over the transcript and stays listed only while the reply still ends on it", () => {
        const sent: DecisionRecord = {
            id: "d_3_s-alpha",
            sessionId: "s-alpha",
            number: 3,
            prompt: "Keep the cache?",
            options: ["keep it", "drop it"],
            state: "sent",
            option: "b",
            updatedTs: "2026-03-01T10:06:00.000Z",
        };
        const scans = new Map([["s-alpha", { at: "2026-03-01T10:04:00.000Z", blocks: parseDecisionBlocks(ASK) }]]);
        const shown = buildInbox({ sessions: [SESSION], scans, rows: [sent], forms: [] });

        expect(shown[0]?.waiting).toBe(0);
        expect(shown[0]?.items[0]).toMatchObject({ status: "sent", option: "b", source: "store" });
        expect(buildInbox({ sessions: [SESSION], scans: new Map(), rows: [sent], forms: [] })).toEqual([]);
    });
});

describe("sessionDecisions", () => {
    test("every stored state plus the unstored blocks of the last reply, by number", () => {
        const rows: DecisionRecord[] = [
            {
                id: "d_1_s-alpha",
                sessionId: "s-alpha",
                number: 1,
                prompt: "Old?",
                options: ["x"],
                state: "sent",
                option: "a",
                updatedTs: "2026-03-01T08:00:00.000Z",
            },
            {
                id: "d_3_s-alpha",
                sessionId: "s-alpha",
                number: 3,
                prompt: "Keep the cache?",
                options: ["keep it"],
                state: "drafted",
                updatedTs: "2026-03-01T10:05:00.000Z",
            },
            {
                id: "d_1_s-beta",
                sessionId: "s-beta",
                number: 1,
                prompt: "Other session",
                options: [],
                state: "open",
                updatedTs: "2026-03-01T08:00:00.000Z",
            },
        ];
        const scan = {
            at: "2026-03-01T10:04:00.000Z",
            blocks: [...parseDecisionBlocks(ASK), { number: 4, prompt: "Rename?", options: ["yes"] }],
        };

        expect(
            sessionDecisions({ sessionId: "s-alpha", rows, scan }).map((item) => [
                item.number,
                item.status,
                item.source,
            ])
        ).toEqual([
            [1, "sent", "store"],
            [3, "drafted", "store"],
            [4, "waiting", "transcript"],
        ]);
        expect(sessionDecisions({ sessionId: "s-gamma", rows, scan: null })).toEqual([]);
    });
});

describe("loadInbox", () => {
    test("an unchanged transcript is read from the scan cache, a changed one is read again", async () => {
        let reads = 0;
        let cache: Record<string, unknown> | null = null;
        let size = 100;
        const row = { ...SESSION, provider: "claude", cwdShort: "app", model: null, filePath: "/tmp/gt-inbox/s.jsonl" };
        const deps: InboxDeps = {
            sessions: async () => [row as AgentSessionRow],
            tail: async () => {
                reads++;
                return [turn("assistant", ASK)];
            },
            stat: () => ({ size, mtimeMs: 1 }),
            rows: () => [],
            forms: () => [],
            readCache: async () => cache as never,
            writeCache: async (next) => {
                cache = next;
            },
        };

        const first = await loadInbox({ deps });
        const second = await loadInbox({ deps });
        size = 200;
        const third = await loadInbox({ deps });

        expect(reads).toBe(2);
        expect([first.scanned.read, second.scanned.fromCache, third.scanned.read]).toEqual([1, 1, 1]);
        const item = second.sessions[0]?.items[0];
        expect(item?.kind === "decision" ? item.number : null).toBe(3);
    });
});

describe("answerInboxDecision", () => {
    const block = parseDecisionBlocks(ASK)[0] ?? null;

    test("a transcript-only decision is stored under its number, answered and delivered", async () => {
        const { file, events } = scratch();
        const delivered: string[][] = [];
        const result = await answerInboxDecision(
            { session: "s-alpha", provider: "claude", cwd: "/tmp/gt-inbox/app", number: 3, option: "b" },
            {
                file,
                events,
                block: async () => block,
                deliver: {
                    runTool: async (args) => {
                        delivered.push(args);
                        return { success: true, stdout: '{"sent":true}', stderr: "" };
                    },
                    findTargets: livePaneTargets,
                },
            }
        );

        expect(delivered).toEqual([["claude", "cmux", "send", "s-alpha", "DECISION 3: b) drop it", "--json"]]);
        expect(result).toMatchObject({ channel: "cmux", delivered: true, text: "DECISION 3: b) drop it" });
        expect(readDecisions(file)).toMatchObject([{ id: "d_3_s-alpha", state: "sent", option: "b", harvested: true }]);
    });

    test("an undelivered answer stays answered and reports the route", async () => {
        const { file, events } = scratch();
        await postDecisions(file, events, {
            sessionId: "s-beta",
            decisions: [{ prompt: "Port?", options: ["3000", "4000"] }],
        });
        const result = await answerInboxDecision(
            { session: "s-beta", number: 1, option: "a", text: "keep the default" },
            {
                file,
                events,
                block: async () => {
                    throw new Error("a stored decision must not read the transcript");
                },
                deliver: {
                    runTool: async () => ({ success: false, stdout: "", stderr: "no cmux pane matched" }),
                    findTargets: livePaneTargets,
                },
            }
        );

        // The reason is one sentence in `error`; `target` stays a place, never an error text.
        expect(result).toMatchObject({
            channel: "queued",
            delivered: false,
            detail: "no cmux pane runs this session",
            error: "no cmux pane runs this session",
        });
        expect(readDecisions(file)[0]?.delivery).toMatchObject({
            route: "queued",
            error: "no cmux pane runs this session",
        });
        expect(readDecisions(file)[0]?.delivery?.target).toBeUndefined();
        expect(result.text).toBe("DECISION 1: a) keep the default");
        expect(readDecisions(file)[0]).toMatchObject({ state: "answered", option: "a" });
    });

    test("dry run writes nothing; a wrong letter, an unknown number and a sent decision are refused", async () => {
        const { file, events } = scratch();
        const deps = {
            file,
            events,
            block: async (_session: string, number: number) => (number === 3 ? block : null),
            deliver: {
                runTool: async (): Promise<never> => {
                    throw new Error("must not deliver");
                },
            },
        };

        const preview = await answerInboxDecision({ session: "s-alpha", number: 3, option: "a", dryRun: true }, deps);
        expect(preview).toMatchObject({ channel: "dry-run", delivered: false, text: "DECISION 3: a) keep it" });
        expect(existsSync(file)).toBe(false);

        await expect(answerInboxDecision({ session: "s-alpha", number: 3, option: "c" }, deps)).rejects.toThrow(
            "options a-b"
        );
        await expect(answerInboxDecision({ session: "s-alpha", number: 4, option: "a" }, deps)).rejects.toThrow(
            "not waiting"
        );
        await expect(answerInboxDecision({ session: "s-alpha", number: 3 }, deps)).rejects.toThrow("option letter");

        await answerInboxDecision(
            { session: "s-alpha", number: 3, option: "a" },
            {
                ...deps,
                deliver: {
                    runTool: async () => ({ success: true, stdout: '{"sent":true}', stderr: "" }),
                    findTargets: livePaneTargets,
                },
            }
        );
        await expect(answerInboxDecision({ session: "s-alpha", number: 3, option: "b" }, deps)).rejects.toThrow(
            "already sent"
        );
    });
});

describe("answerInboxDecisions", () => {
    test("several answers reach the session as ONE message, and one bad answer writes nothing", async () => {
        const { file, events } = scratch();
        await postDecisions(file, events, {
            sessionId: "s-beta",
            decisions: [{ prompt: "Port?", options: ["3000", "4000"] }],
        });
        const blocks = [...parseDecisionBlocks(ASK)];
        const typed: string[][] = [];
        const deps = {
            file,
            events,
            block: async (_session: string, number: number) => blocks.find((block) => block.number === number) ?? null,
            deliver: {
                runTool: async (args: string[]) => {
                    typed.push(args);
                    return { success: true, stdout: '{"sent":true}', stderr: "" };
                },
                findTargets: livePaneTargets,
            },
        };

        await expect(
            answerInboxDecisions(
                {
                    session: "s-beta",
                    answers: [
                        { number: 1, option: "b" },
                        { number: 9, option: "a" },
                    ],
                },
                deps
            )
        ).rejects.toThrow("DECISION 9 is not waiting");
        expect(readDecisions(file)[0]?.state).toBe("open");

        blocks.push({ number: 2, prompt: "Rename?", options: ["yes", "no"] });
        const result = await answerInboxDecisions(
            {
                session: "s-beta",
                answers: [
                    { number: 1, option: "b" },
                    { number: 2, text: "later" },
                ],
            },
            deps
        );

        expect(typed).toEqual([
            ["claude", "cmux", "send", "s-beta", "DECISION 1: b) 4000 ; DECISION 2: later", "--json"],
        ]);
        expect(result).toMatchObject({ channel: "cmux", delivered: true });
        expect(readDecisions(file).map((row) => [row.number, row.state, row.delivery?.route])).toEqual([
            [1, "sent", "cmux"],
            [2, "sent", "cmux"],
        ]);
    });
});

describe("answerInboxForm", () => {
    test("answers the form and names the waiting agent as the route", async () => {
        const calls: unknown[] = [];
        const result = await answerInboxForm({
            formId: "ask_1",
            answers: [{ itemId: "q1", selectedChoices: ["c1"] }],
            answer: async (id, answers) => {
                calls.push([id, answers]);
                return { ok: true, form: form({ sessionHint: "s-alpha", status: "answered" }), entryId: "e1" };
            },
        });

        expect(calls).toEqual([["ask_1", [{ itemId: "q1", selectedChoices: ["c1"] }]]]);
        expect(result).toMatchObject({ session: "s-alpha", channel: "form", delivered: true });
        await expect(
            answerInboxForm({
                formId: "ask_9",
                answers: [],
                answer: async () => ({ ok: false, code: "not_found", error: "no such form" }),
            })
        ).rejects.toThrow("no such form");
    });
});

describe("legacy delivery rows", () => {
    test("a pre-rework queued row with the raw cmux dump in target reads as one sentence, the dump behind raw", () => {
        // The exact shape of the launch-probe row of 2026-09-24: the whole `tools claude cmux send`
        // failure went into `target` and the hub drew it under a green check.
        const dump = [
            "ERROR: [cmux] command failed",
            "    args: [",
            '      "send",',
            '      "--surface",',
            '      "B81F2283-0000-4000-8000-000000000000",',
            '      "--",',
            '      "DECISION 2: a) It belongs to another session."',
            "    ]",
            "    code: 1",
            '    stderr: "Error: not_found: Workspace not found\\n"',
        ].join("\n");
        const legacy = inboxDelivery({ route: "queued", target: dump, at: "2026-09-24T21:41:27.939Z" });

        expect(legacy).toMatchObject({
            route: "queued",
            error: "the cmux workspace of this session was closed",
            raw: dump,
            at: "2026-09-24T21:41:27.939Z",
        });
        expect(legacy?.target).toBeUndefined();

        // A pre-rework "why" that was already one sentence stays that sentence; a real place is kept.
        expect(inboxDelivery({ route: "queued", target: "no cmux pane matched", at: "x" })).toMatchObject({
            error: "no cmux pane runs this session",
        });
        expect(inboxDelivery({ route: "cmux", target: "work · agent", at: "x" })).toEqual({
            route: "cmux",
            target: "work · agent",
            at: "x",
        });
        expect(inboxDelivery(undefined)).toBeNull();
    });

    test("a session whose only decision is answered and queued counts as queued, not waiting", () => {
        const queued: DecisionRecord = {
            id: "d_2_s-probe",
            sessionId: "s-probe",
            number: 2,
            prompt: "Where does your answer go?",
            options: ["another session", "a different pane"],
            state: "answered",
            option: "a",
            delivery: { route: "queued", target: "ERROR: [cmux] command failed\n    stderr: not_found", at: "x" },
            updatedTs: "2026-03-01T10:06:00.000Z",
        };
        const reply = [
            "❓ DECISION 2: Where does your answer go?",
            "- a) another session",
            "- b) a different pane",
        ].join("\n");
        const scans = new Map([["s-probe", { at: "2026-03-01T10:04:00.000Z", blocks: parseDecisionBlocks(reply) }]]);
        const [session] = buildInbox({ sessions: [], scans, rows: [queued], forms: [] });

        expect(session).toMatchObject({ waiting: 0, queued: 1, drafted: 0 });
        const item = session?.items[0];
        expect(item?.kind === "decision" ? item.delivery : null).toMatchObject({
            route: "queued",
            error: "the cmux workspace of this session was closed",
        });
    });
});

describe("delivery record", () => {
    test("a send names the pane it typed into; a later queued send replaces it; old rows read without one", async () => {
        const { file, events } = scratch();
        await postDecisions(file, events, {
            sessionId: "s-gamma",
            decisions: [
                { prompt: "Go?", options: ["yes", "no"] },
                { prompt: "Now?", options: ["yes"] },
            ],
        });
        const pane = {
            success: true,
            stdout: '{"sent":true,"target":{"workspaceName":"work","paneTitle":"agent"}}',
            stderr: "",
        };
        const deps = {
            file,
            events,
            block: async () => null,
            deliver: { runTool: async () => pane, findTargets: livePaneTargets },
        };

        await answerInboxDecision({ session: "s-gamma", number: 1, option: "a" }, deps);
        const first = readDecisions(file);
        expect(first[0]?.delivery).toMatchObject({ route: "cmux", target: "cmux · work · agent" });
        expect(first[1]?.delivery).toBeUndefined();
        expect(sessionDecisions({ sessionId: "s-gamma", rows: first, scan: null })[1]?.delivery).toBeNull();

        await answerInboxDecision(
            { session: "s-gamma", number: 2, option: "a" },
            {
                ...deps,
                deliver: {
                    runTool: async () => ({ success: false, stdout: "", stderr: "cmux is not running" }),
                    findTargets: livePaneTargets,
                },
            }
        );
        const second = readDecisions(file);
        expect(second[1]).toMatchObject({
            state: "answered",
            delivery: { route: "queued", error: "cmux is not running" },
        });
        expect(second[0]?.delivery?.route).toBe("cmux");
    });
});

describe("paneMiss", () => {
    test("the cmux send outcome in words", () => {
        expect(paneMiss('{"query":"s","sent":false,"matches":[]}')).toBe("no cmux pane runs this session");
        expect(paneMiss('{"sent":false,"matches":[{},{}]}')).toBe("2 cmux panes match this session; none was picked");
        expect(paneMiss("", "Error: not_found: Workspace not found")).toBe(
            "the cmux workspace of this session was closed"
        );
        expect(paneMiss("", "No cmux pane matches")).toBe("no cmux pane runs this session");
        expect(paneMiss("")).toBe("the cmux send failed");
    });
});

/**
 * `tools question inbox answer` run with the argv the hub sends (HubInbox.swift, HubDecisionsSource.swift),
 * through commander, against a scratch store. What it prints on stdout is what Swift decodes.
 */
async function runInboxAnswer(argv: string[], deps: InboxCommandDeps): Promise<Record<string, unknown>> {
    const program = new Command();
    program.exitOverride();
    registerInboxCommand(program, deps);
    const printed: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => {
        printed.push(String(chunk));
        return true;
    }) as typeof process.stdout.write;

    try {
        await program.parseAsync(["inbox", "answer", ...argv], { from: "user" });
        await Bun.sleep(5);
    } finally {
        process.stdout.write = write;
        process.exitCode = 0;
    }

    return SafeJSON.parse(printed.join("").trim(), { strict: true }) as Record<string, unknown>;
}

describe("inbox answer: the hub's argv", () => {
    test("--provider codex steers a codex thread even when the stored row names no provider", async () => {
        const { file, events } = scratch();
        await postDecisions(file, events, {
            sessionId: "s-codex",
            decisions: [{ prompt: "Port?", options: ["3000", "4000"] }],
        });
        const runs: string[][] = [];
        const printed = await runInboxAnswer(
            ["--session", "s-codex", "--batch", '[{"number":1,"option":"b","text":"note"}]', "--provider", "codex"],
            {
                decisions: () => ({
                    file,
                    events,
                    block: async () => null,
                    deliver: {
                        runTool: async (args) => {
                            runs.push(args);
                            return { success: true, stdout: "", stderr: "" };
                        },
                        codexWorkerFor: (session) => (session === "s-codex" ? "w1" : null),
                    },
                }),
            }
        );

        expect(runs).toEqual([["codex", "steer", "--name", "w1", "--prompt", "DECISION 1: b) note"]]);
        expect(printed).toMatchObject({
            channel: "codex",
            delivered: true,
            target: "codex worker w1",
            detail: "codex worker w1",
        });
    });

    test("--form with --dry-run checks the answer and leaves the form pending", async () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-inbox-forms-"));
        const askDeps: AskDeps = {
            dbPath: join(dir, "qa.db"),
            eventBase: join(dir, "events"),
            logBase: join(dir, "log"),
            notify: false,
            env: {},
        };
        const posted = await postAskForm(
            { projectPath: dir, items: [{ promptMarkdown: "Ship it?", choices: ["yes", "no"] }] },
            askDeps
        );
        const itemId = posted.items[0]?.id ?? "";
        const choice = posted.items[0]?.choices?.[0]?.id ?? "";

        const printed = await runInboxAnswer(
            [
                "--form",
                posted.id,
                "--answers",
                SafeJSON.stringify([{ itemId, selectedChoices: [choice] }]),
                "--dry-run",
            ],
            { forms: askDeps }
        );

        expect(printed).toMatchObject({ channel: "dry-run", delivered: false, text: `form ${posted.id}` });
        expect(getAskForm(posted.id, askDeps)?.status).toBe("pending");
    });

    test("a number the session never asked is refused as not waiting, also when the session has no transcript", async () => {
        const { file, events } = scratch();
        const printed = await runInboxAnswer(
            ["--session", "00000000-0000-4000-8000-00000000dead", "--decision", "9", "--option", "a", "--dry-run"],
            { decisions: () => ({ file, events, block: waitingBlock }) }
        );

        expect(printed).toEqual({
            error: "DECISION 9 is not waiting in session 00000000-0000-4000-8000-00000000dead",
        });
        expect(
            await waitingBlock("s-any", 1, async () => {
                throw new Error('No session file found for "s-any"');
            })
        ).toBeNull();
    });
});
