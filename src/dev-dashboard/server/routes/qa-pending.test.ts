import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QA_ANSWER_MAX_CHARS } from "@app/dev-dashboard/lib/qa-clip";
import type { RouteContext, RouteDef, RouteResult } from "@app/dev-dashboard/server/types";
import type { DeliverDeps, ToolRun } from "@app/question/lib/decisions/deliver";
import { livePaneTargets } from "@app/question/lib/decisions/deliver.fixtures";
import { parseDecisionBlocks } from "@app/question/lib/decisions/read";
import { postDecisions, readDecisions, updateDecisions } from "@app/question/lib/decisions/store";
import { scanTurns } from "@app/question/lib/inbox/build";
import type { InboxDeps } from "@app/question/lib/inbox/load";
import { appendEntry } from "@app/question/lib/log-store";
import { claimForm, defaultPendingDbPath, openPendingStore } from "@app/question/lib/pending/store";
import type { AskForm } from "@app/question/lib/pending/types";
import type { TranscriptTurn } from "@genesiscz/utils/ai/transcripts/types";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { qaRoutes } from "./qa";
import { qaDecisionRoutes } from "./qa-decisions";

let home = "";

beforeEach(() => {
    // A scratch home keeps every form and log line out of the real ~/.genesis-tools.
    home = mkdtempSync(join(tmpdir(), "qa-pending-route-"));
    const configPath = join(home, "question-config.json");
    // notifyPending off: the repo blocks dispatchNotification under bun test, because it
    // reaches the machine the user is sitting at.
    writeFileSync(
        configPath,
        SafeJSON.stringify({
            sinks: { obsidian: false, sound: false, notify: false, notifyPending: false },
            obsidianPathTemplate: "",
        })
    );
    env.testing.set("GENESIS_TOOLS_HOME", home);
    env.testing.set("QUESTION_LOG_BASE", join(home, "qa-log"));
    env.testing.set("QUESTION_CONFIG_PATH", configPath);
});

afterEach(() => {
    env.testing.unset("GENESIS_TOOLS_HOME");
    env.testing.unset("QUESTION_LOG_BASE");
    env.testing.unset("QUESTION_CONFIG_PATH");
    rmSync(home, { recursive: true, force: true });
});

function findRoute(method: string, pattern: string): RouteDef {
    const def = qaRoutes().find((d) => d.method === method && d.pattern === pattern);

    if (!def) {
        throw new Error(`route not found: ${method} ${pattern}`);
    }

    return def;
}

function makeCtx(opts: { params?: Record<string, string>; body?: unknown; query?: string } = {}): RouteContext {
    return {
        method: "POST",
        pathname: "/",
        query: new URLSearchParams(opts.query ?? ""),
        params: opts.params ?? {},
        headers: {},
        readJson: async <T>() => opts.body as T,
        readRawBody: async () => new Uint8Array(),
        services: {} as RouteContext["services"],
    };
}

function asJson(result: RouteResult): { status: number; body: Record<string, unknown> } {
    if (result.kind !== "json") {
        throw new Error(`expected a json result, got ${result.kind}`);
    }

    return { status: result.status, body: result.body as Record<string, unknown> };
}

async function post(body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
    return asJson(await findRoute("POST", "/api/qa/pending").handler(makeCtx({ body })));
}

async function createForm(items: unknown[] = [{ promptMarkdown: "Ship?", choices: ["yes", "no"] }]): Promise<AskForm> {
    const res = await post({ projectPath: home, items });
    const form = (res.body as { form?: AskForm }).form;

    if (!form) {
        throw new Error(`form creation failed: ${res.status} ${Bun.inspect(res.body)}`);
    }

    return form;
}

describe("qa pending routes", () => {
    it("POST /api/qa/pending creates a form and 201s", async () => {
        const res = await post({ projectPath: home, items: [{ promptMarkdown: "Ship?" }] });

        expect(res.status).toBe(201);
        expect((res.body as { form: AskForm }).form.status).toBe("pending");
    });

    it("POST /api/qa/pending with no items is a 400, not a crash", async () => {
        const res = await post({ projectPath: home, items: [] });

        expect(res.status).toBe(400);
        expect(res.body.error).toContain("items[]");
    });

    it("a projectPath that is missing, blank or not a string is a 400, not a crash", async () => {
        for (const projectPath of [undefined, "  ", 0, false, { path: home }]) {
            const res = await post({ projectPath, items: [{ promptMarkdown: "Ship?" }] });

            expect(res.status).toBe(400);
            expect(res.body.error).toContain("projectPath");
        }
    });

    it("a JSON body that is not an object is a 400, not a 500", async () => {
        // `null` and `7` are valid JSON. Reading a field off one used to throw inside the
        // handler, so a plain client mistake came back as a server error.
        for (const body of [null, 7, "text", []]) {
            const res = await post(body);

            expect(res.status).toBe(400);
        }
    });

    it("POST answer and POST wait also reject a non-object body", async () => {
        const form = await createForm();
        const answer = asJson(
            await findRoute("POST", "/api/qa/pending/:id/answer").handler(
                makeCtx({ params: { id: form.id }, body: null })
            )
        );
        const wait = asJson(
            await findRoute("POST", "/api/qa/pending/:id/wait").handler(
                makeCtx({ params: { id: form.id }, body: null })
            )
        );

        expect(answer.status).toBe(400);
        expect(wait.status).toBe(400);
    });

    it("GET /api/qa/pending lists the pending forms", async () => {
        const form = await createForm();
        const res = asJson(await findRoute("GET", "/api/qa/pending").handler(makeCtx()));

        expect(res.status).toBe(200);
        expect((res.body as { forms: AskForm[] }).forms.map((f) => f.id)).toContain(form.id);
    });

    it("GET /api/qa/pending?ids= answers a batch poll, with null for an unknown id", async () => {
        const form = await createForm();
        const res = asJson(
            await findRoute("GET", "/api/qa/pending").handler(makeCtx({ query: `ids=${form.id},ask_missing` }))
        );
        const forms = res.body.forms as Record<string, AskForm | null>;

        expect(forms[form.id]?.status).toBe("pending");
        expect(forms.ask_missing).toBeNull();
    });

    it("GET /api/qa/pending/:id 404s for an unknown form", async () => {
        const res = asJson(
            await findRoute("GET", "/api/qa/pending/:id").handler(makeCtx({ params: { id: "ask_missing" } }))
        );

        expect(res.status).toBe(404);
    });

    it("POST answer resolves the form and reports the history entry it wrote", async () => {
        const form = await createForm();
        const res = asJson(
            await findRoute("POST", "/api/qa/pending/:id/answer").handler(
                makeCtx({ params: { id: form.id }, body: { answers: [{ itemId: "q1", selectedChoices: ["yes"] }] } })
            )
        );

        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
        expect(typeof res.body.entryId).toBe("string");
    });

    it("POST answer with a required item missing is a 400 naming the item", async () => {
        const form = await createForm([{ promptMarkdown: "A?" }, { promptMarkdown: "B?" }]);
        const res = asJson(
            await findRoute("POST", "/api/qa/pending/:id/answer").handler(
                makeCtx({ params: { id: form.id }, body: { answers: [{ itemId: "q1", freeText: "a" }] } })
            )
        );

        expect(res.status).toBe(400);
        expect(res.body.code).toBe("incomplete");
        expect(res.body.missing).toEqual(["q2"]);
    });

    it("POST answer on an already-answered form is a 404, so a double submit cannot overwrite", async () => {
        const form = await createForm();
        const answer = findRoute("POST", "/api/qa/pending/:id/answer");
        await answer.handler(
            makeCtx({ params: { id: form.id }, body: { answers: [{ itemId: "q1", freeText: "1" }] } })
        );
        const second = asJson(
            await answer.handler(
                makeCtx({ params: { id: form.id }, body: { answers: [{ itemId: "q1", freeText: "2" }] } })
            )
        );

        expect(second.status).toBe(404);
        expect(second.body.code).toBe("not_pending");
    });

    it("DELETE cancels a pending form, and a second delete 404s", async () => {
        const form = await createForm();
        const route = findRoute("DELETE", "/api/qa/pending/:id");
        const first = asJson(await route.handler(makeCtx({ params: { id: form.id } })));

        expect(first.status).toBe(200);
        expect((first.body as { form: AskForm }).form.status).toBe("cancelled");
        expect(asJson(await route.handler(makeCtx({ params: { id: form.id } }))).status).toBe(404);
    });

    it("DELETE on a form an answer holds is a 409 that names it, never a 404", async () => {
        const form = await createForm();
        // Exactly what an in-flight answerAskForm holds while it writes its history entry.
        const db = openPendingStore(defaultPendingDbPath());

        expect(claimForm(db, form.id)).not.toBeNull();
        db.close();

        const res = asJson(
            await findRoute("DELETE", "/api/qa/pending/:id").handler(makeCtx({ params: { id: form.id } }))
        );

        // 404 would tell a client to stop retrying a form that is seconds from resolving.
        expect(res.status).toBe(409);
        expect(res.body.code).toBe("being_answered");
        expect(String(res.body.error)).toContain("is being answered right now");
    });

    it("DELETE on an id no form carries stays a 404, and says so", async () => {
        const res = asJson(
            await findRoute("DELETE", "/api/qa/pending/:id").handler(makeCtx({ params: { id: "ask_nope" } }))
        );

        expect(res.status).toBe(404);
        expect(res.body.code).toBe("not_found");
        expect(String(res.body.error)).toBe("unknown form: ask_nope");
    });

    it("POST wait returns the waiter verdict once its budget is spent", async () => {
        const form = await createForm();
        const res = asJson(
            await findRoute("POST", "/api/qa/pending/:id/wait").handler(
                makeCtx({ params: { id: form.id }, body: { timeoutMs: 20 } })
            )
        );

        expect(res.status).toBe(200);
        expect(res.body.waiter).toBe("budget_exhausted");
    });

    it("POST wait on an unknown form 404s", async () => {
        const res = asJson(
            await findRoute("POST", "/api/qa/pending/:id/wait").handler(
                makeCtx({ params: { id: "ask_missing" }, body: { timeoutMs: 10 } })
            )
        );

        expect(res.status).toBe(404);
    });
});

describe("qa log answer size", () => {
    function seed(id: string, answerMd: string): void {
        appendEntry(
            {
                id,
                ts: Date.now(),
                sessionId: "s",
                sessionTitle: null,
                project: "P",
                repoRoot: home,
                cwd: home,
                branch: null,
                commitSha: null,
                commitMessage: null,
                agent: "unknown",
                isWorktree: false,
                worktreePath: null,
                aiAgent: null,
                agentLabel: null,
                tag: "action",
                question: `q ${id}`,
                answerMd,
                refs: [],
                source: "cli",
                turnUuid: null,
            },
            join(home, "qa-log")
        );
    }

    it("GET /api/qa/log clips a huge answer and GET /api/qa/entry/:id returns it whole", async () => {
        // A tripwire report of 2.36 MB made the log 3.4 MB and /qa never rendered on the phone.
        const huge = "line of a tripwire report\n".repeat(90_000);
        seed("huge", huge);
        seed("small", "short answer");

        const log = asJson(await findRoute("GET", "/api/qa/log").handler(makeCtx({ query: "limit=100" })));
        const entries = log.body.entries as Array<{ id: string; answerMd: string; answerFullChars?: number }>;
        const clipped = entries.find((row) => row.id === "huge");
        const small = entries.find((row) => row.id === "small");

        expect(log.status).toBe(200);
        expect(clipped?.answerMd.length).toBeLessThanOrEqual(QA_ANSWER_MAX_CHARS);
        expect(clipped?.answerMd.endsWith("report")).toBe(true);
        expect(clipped?.answerFullChars).toBe(huge.length);
        expect(small?.answerMd).toBe("short answer");
        expect(small?.answerFullChars).toBeUndefined();

        const full = asJson(await findRoute("GET", "/api/qa/entry/:id").handler(makeCtx({ params: { id: "huge" } })));
        expect(full.status).toBe(200);
        expect((full.body.entry as { answerMd: string }).answerMd).toBe(huge);

        const missing = asJson(
            await findRoute("GET", "/api/qa/entry/:id").handler(makeCtx({ params: { id: "nope" } }))
        );
        expect(missing.status).toBe(404);
    });
});

describe("qa decision routes", () => {
    const SESSION = "s-alpha";
    const ASK = ["Parser done.", "", "❓ DECISION 3: Keep the cache?", "- **a)** keep it", "- **b)** drop it"].join(
        "\n"
    );

    function turn(text: string): TranscriptTurn {
        return { id: "assistant-1", role: "assistant", at: "2026-03-01T10:04:00.000Z", text, tools: [] };
    }

    function scratchFiles(): { file: string; events: string } {
        return { file: join(home, "decisions.jsonl"), events: join(home, "decision-events.jsonl") };
    }

    /** Every delivery the routes attempt; `runTool` never reaches a real `tools` binary. */
    let runs: string[][] = [];
    let runResult: ToolRun = { success: true, stdout: '{"sent":true}', stderr: "" };
    const fakeDeliver: DeliverDeps = {
        runTool: async (args) => {
            runs.push(args);
            return runResult;
        },
        codexWorkerFor: () => null,
        findTargets: livePaneTargets,
    };
    let cache: Awaited<ReturnType<InboxDeps["readCache"]>> = null;
    const inbox: InboxDeps = {
        sessions: async () => [
            {
                provider: "claude",
                sessionId: SESSION,
                title: "parser work",
                cwd: home,
                cwdShort: "app",
                project: "app",
                gitBranch: "feat/parser",
                mtime: Date.parse("2026-03-01T10:05:00.000Z"),
                model: null,
                account: "work",
                filePath: join(home, "s-alpha.jsonl"),
            },
        ],
        tail: async () => [turn(ASK)],
        stat: () => ({ size: 1, mtimeMs: 1 }),
        rows: () => readDecisions(scratchFiles().file),
        forms: () => [],
        readCache: async () => cache,
        writeCache: async (next) => {
            cache = next;
        },
    };

    beforeEach(() => {
        runs = [];
        cache = null;
        runResult = { success: true, stdout: '{"sent":true}', stderr: "" };
    });

    function decisionRoute(method: string, pattern: string): RouteDef {
        const def = qaDecisionRoutes({
            files: scratchFiles,
            inbox,
            session: { rows: inbox.rows, scan: async () => scanTurns([turn(ASK)]) },
            block: async (_session, number) =>
                parseDecisionBlocks(ASK).find((block) => block.number === number) ?? null,
            deliver: fakeDeliver,
        }).find((d) => d.method === method && d.pattern === pattern);

        if (!def) {
            throw new Error(`route not found: ${method} ${pattern}`);
        }

        return def;
    }

    async function seedStored(): Promise<string> {
        const { file, events } = scratchFiles();
        const [row] = await postDecisions(file, events, {
            sessionId: "s-beta",
            title: "port work",
            decisions: [{ prompt: "Which port?", options: ["3000", "4000"] }],
        });

        return row.id;
    }

    function answer(body: unknown) {
        return decisionRoute("POST", "/api/qa/decisions/answer").handler(makeCtx({ body }));
    }

    it("GET /api/qa/decisions is the hub inbox: a decision from the last reply and an open stored one", async () => {
        await seedStored();

        const res = asJson(await decisionRoute("GET", "/api/qa/decisions").handler(makeCtx()));
        const sessions = res.body.sessions as Array<{
            sessionId: string;
            items: Array<{ number: number; source: string }>;
        }>;

        expect(res.status).toBe(200);
        // Newest first, like the hub: the stored decision was posted now, the reply is from March.
        expect(sessions.map((s) => [s.sessionId, s.items.map((i) => `${i.number}:${i.source}`)])).toEqual([
            ["s-beta", ["1:store"]],
            [SESSION, ["3:transcript"]],
        ]);
    });

    it("GET session/:id lists stored rows in every state plus the unstored block of the last reply", async () => {
        const { file, events } = scratchFiles();
        const [row] = await postDecisions(file, events, {
            sessionId: SESSION,
            decisions: [{ prompt: "Rename?", options: ["yes", "no"] }],
        });
        await updateDecisions(file, events, { updates: [{ id: row.id, state: "answered", option: "a" }] });

        const res = asJson(
            await decisionRoute("GET", "/api/qa/decisions/session/:id").handler(makeCtx({ params: { id: SESSION } }))
        );
        const decisions = res.body.decisions as Array<{ number: number; status: string; source: string }>;

        expect(decisions.map((d) => `${d.number}:${d.status}:${d.source}`)).toEqual([
            "1:answered:store",
            "3:waiting:transcript",
        ]);
    });

    it("POST answer refuses a malformed body, a wrong letter and an unknown number, and never reaches the runner", async () => {
        expect(asJson(await answer({ session: SESSION })).status).toBe(400);
        expect(asJson(await answer({ session: SESSION, answers: [{ number: 3, option: "z" }] })).status).toBe(400);
        expect(asJson(await answer({ session: SESSION, answers: [{ number: 9, option: "a" }] })).status).toBe(400);
        expect(runs).toEqual([]);
        expect(readDecisions(scratchFiles().file)).toEqual([]);
    });

    it("POST answer dryRun previews the message and writes nothing", async () => {
        const res = asJson(await answer({ session: SESSION, answers: [{ number: 3, option: "b" }], dryRun: true }));

        expect(res.body).toMatchObject({ channel: "dry-run", delivered: false, text: "DECISION 3: b) drop it" });
        expect(runs).toEqual([]);
        expect(readDecisions(scratchFiles().file)).toEqual([]);
    });

    it("POST answer stores a transcript-only decision, answers it and delivers ONE message", async () => {
        const res = asJson(
            await answer({ session: SESSION, provider: "claude", answers: [{ number: 3, option: "b", text: "stale" }] })
        );

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ channel: "cmux", delivered: true });
        expect(runs).toEqual([["claude", "cmux", "send", SESSION, "DECISION 3: b) stale", "--json"]]);
        expect(readDecisions(scratchFiles().file)).toMatchObject([
            { id: `d_3_${SESSION}`, state: "sent", option: "b", harvested: true },
        ]);
    });

    it("an undelivered answer stays queued, and POST send delivers it later", async () => {
        const id = await seedStored();
        runResult = { success: false, stdout: "", stderr: "No cmux pane matches" };

        const queued = asJson(await answer({ session: "s-beta", answers: [{ number: 1, option: "b" }] }));
        expect(queued.body).toMatchObject({
            channel: "queued",
            delivered: false,
            detail: "no cmux pane runs this session",
            error: "no cmux pane runs this session",
        });
        expect(readDecisions(scratchFiles().file).find((row) => row.id === id)?.state).toBe("answered");

        runResult = { success: true, stdout: '{"sent":true}', stderr: "" };
        const sent = asJson(
            await decisionRoute("POST", "/api/qa/decisions/send").handler(makeCtx({ body: { session: "s-beta" } }))
        );
        expect(sent.body).toMatchObject({ channel: "cmux", delivered: true, numbers: [1] });
        expect(readDecisions(scratchFiles().file).find((row) => row.id === id)?.state).toBe("sent");

        // The /qa history reads where it went from the session route.
        const history = asJson(
            await decisionRoute("GET", "/api/qa/decisions/session/:id").handler(makeCtx({ params: { id: "s-beta" } }))
        );
        const row = (history.body.decisions as Array<{ number: number; delivery: { route: string } | null }>).find(
            (item) => item.number === 1
        );
        expect(row?.delivery?.route).toBe("cmux");
    });

    it("POST send with nothing answered is a 400 and never reaches the runner", async () => {
        await seedStored();

        const res = asJson(
            await decisionRoute("POST", "/api/qa/decisions/send").handler(makeCtx({ body: { session: "s-beta" } }))
        );

        expect(res.status).toBe(400);
        expect(res.body.error).toBe("nothing to send");
        expect(runs).toEqual([]);
    });

    it("the session's provider from the body steers a codex thread whose rows name none, on answer and on send", async () => {
        await seedStored();
        runResult = { success: true, stdout: "", stderr: "" };
        const routes = qaDecisionRoutes({
            files: scratchFiles,
            block: async () => null,
            deliver: { ...fakeDeliver, codexWorkerFor: (session) => (session === "s-beta" ? "w1" : null) },
        });
        const route = (pattern: string) => routes.find((d) => d.method === "POST" && d.pattern === pattern);
        const send = route("/api/qa/decisions/send");
        const answerRoute = route("/api/qa/decisions/answer");

        if (!send || !answerRoute) {
            throw new Error("decision routes missing");
        }

        // The UI's "Send queued again" for an answer that stayed queued.
        const { file, events } = scratchFiles();
        await updateDecisions(file, events, { updates: [{ id: "d_1_s-beta", state: "answered", option: "b" }] });
        const resent = asJson(await send.handler(makeCtx({ body: { session: "s-beta", provider: "codex" } })));

        expect(resent.body).toMatchObject({ channel: "codex", delivered: true, provider: "codex" });
        expect(runs).toEqual([["codex", "steer", "--name", "w1", "--prompt", "DECISION 1: b) 4000"]]);

        const [row] = await postDecisions(file, events, {
            sessionId: "s-beta",
            decisions: [{ prompt: "Rename?", options: ["yes", "no"] }],
        });
        const answered = asJson(
            await answerRoute.handler(
                makeCtx({
                    body: { session: "s-beta", provider: "codex", answers: [{ number: row.number, option: "a" }] },
                })
            )
        );

        expect(answered.body).toMatchObject({ channel: "codex", delivered: true });
        expect(runs.at(-1)).toEqual(["codex", "steer", "--name", "w1", "--prompt", "DECISION 2: a) yes"]);
    });
});
