import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    CodexCompactionFlow,
    type CompactionShaping,
    compactionTurn,
    type FailureClient,
} from "@app/ai-proxy/lib/providers/codex/compaction-flow";
import {
    backgroundInFlight,
    forgetBackgroundInMemoryForTests,
    resetBackgroundForTests,
} from "@app/ai-proxy/lib/sessions/background-compaction";
import { type CompactionRecord, compactionNote } from "@app/ai-proxy/lib/sessions/codex-compaction";
import { setCompactionEventsPathForTests } from "@app/ai-proxy/lib/sessions/compaction-events";
import { createSessionRecord, readSessionRecord } from "@app/ai-proxy/lib/sessions/records";
import { anthropicToResponses } from "@app/ai-proxy/lib/translators/formats/anthropic/anthropic-to-responses";
import {
    CLAUDE_CODE_COMPACTION_MARK,
    ClaudeCodeTurn,
} from "@app/ai-proxy/lib/translators/formats/anthropic/claude-code-turns";
import type { SessionsInConfig } from "@app/ai-proxy/lib/types";
import type { UsageRequestRecord } from "@app/ai-proxy/lib/usage/types";
import { SafeJSON } from "@genesiscz/utils/json";
import { isObject } from "@genesiscz/utils/object";

// The flow through its two calls: an in-memory CompactionStore (the second adapter of the port; the first is the file
// store under ai-proxy/compactions/), a fake upstream callback, and a provider build that only translates the body
// and applies the shaping. The provider's own test keeps one wiring case per branch.

const MODEL = "gpt-6.1-sol";
const LOGIN = "loginaaa";
const OTHER = "loginbbb";

function sse(text: string): Response {
    return new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/** WHAM's answer to a `compaction_trigger`: one compaction item, and the usage of the cached prefix. */
function compactionResponse(encrypted: string, summary?: string): Response {
    const item = { type: "compaction", id: "cmp_1", encrypted_content: encrypted };
    const readable = summary
        ? `event: response.output_text.delta\ndata: ${SafeJSON.stringify({ type: "response.output_text.delta", delta: summary })}\n\n`
        : "";

    return sse(
        readable +
            `event: response.output_item.done\ndata: ${SafeJSON.stringify({ type: "response.output_item.done", item })}\n\n` +
            `event: response.completed\ndata: ${SafeJSON.stringify({
                type: "response.completed",
                response: {
                    usage: { input_tokens: 400, input_tokens_details: { cached_tokens: 380 }, output_tokens: 50 },
                },
            })}\n\n`
    );
}

/** A plain answer with no compaction item. */
function textResponse(): Response {
    return sse(
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"ok"}\n\n' +
            'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\n'
    );
}

const isTrigger = (body: Record<string, unknown>) =>
    SafeJSON.stringify(Array.isArray(body.input) ? body.input.at(-1) : undefined) ===
    SafeJSON.stringify({ type: "compaction_trigger" });

interface TurnOptions {
    sessionId?: string;
    sessionsIn?: SessionsInConfig;
    efforts?: readonly string[];
    accountHash?: string;
    signal?: AbortSignal;
}

/** Either branch of the decision, flat, so a test reads `body` without narrowing first. */
interface TestDecision {
    answer?: Response;
    body?: Record<string, unknown>;
    onUsage?: (usage: Record<string, unknown>) => void;
}

function harness(answer: (body: Record<string, unknown>) => Response) {
    const records = new Map<string, CompactionRecord>();
    const calls: Array<{ body: Record<string, unknown>; client?: FailureClient }> = [];
    const written: string[] = [];
    const usage: UsageRequestRecord[] = [];
    let ids = 0;
    const flow = new CodexCompactionFlow({
        upstream: async (_req, _model, body, client) => {
            calls.push({ body, client: client ? { ...client } : undefined });
            return answer(body);
        },
        writtenSummary: async (_req, _model, bodyText) => {
            written.push(bodyText);
            return new Response("written");
        },
        store: {
            load: (id) => records.get(id),
            save: (record) => {
                records.set(record.id, record);
            },
            newId: () => `gtc1.00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`,
        },
        usage: (row) => {
            usage.push(row);
        },
        account: "work",
        provider: "openai-subscription",
    });

    async function turn(body: Record<string, unknown>, options: TurnOptions = {}) {
        const parsed = { model: MODEL, ...body };
        const bodyText = SafeJSON.stringify(parsed);
        const req = new Request("http://localhost/v1/messages", {
            method: "POST",
            body: bodyText,
            signal: options.signal,
        });
        const shapings: CompactionShaping[] = [];
        const compacting = compactionTurn({
            req,
            model: MODEL,
            concreteModel: MODEL,
            bodyText,
            context: {
                ...(options.sessionId ? { sessionId: options.sessionId } : {}),
                ...(options.sessionsIn ? { sessionsIn: options.sessionsIn } : {}),
            },
            parsed,
            claudeTurn: ClaudeCodeTurn.read(parsed),
            stamp: { provider: "codex", accountHash: options.accountHash ?? LOGIN, model: MODEL, compHash: "0" },
            client: { anthropic: true },
            ...(options.efforts ? { efforts: options.efforts } : {}),
        });
        const decided = await flow.beforeUpstream(compacting, (shaping) => {
            shapings.push(shaping);
            const built = anthropicToResponses(shaping.parsed, MODEL, { reasoningItem: () => undefined });

            if (shaping.toolChoice) {
                built.tool_choice = shaping.toolChoice;
            }

            if (shaping.effort) {
                built.reasoning = { effort: shaping.effort };
            }

            return { body: built };
        });
        const decision: TestDecision = decided.answer
            ? { answer: decided.answer }
            : { body: decided.body, ...(decided.onUsage ? { onUsage: decided.onUsage } : {}) };

        return { decision, shapings, compacting };
    }

    /** The text of an answered turn's reply, or "" when the turn continues upstream. */
    async function answered(decision: TestDecision): Promise<string> {
        return decision.answer ? decision.answer.text() : "";
    }

    return { flow, records, calls, written, usage, turn, answered };
}

const mark = (text = "Summarize.") => ({ role: "user", content: `${CLAUDE_CODE_COMPACTION_MARK}\n\n${text}` });
const history = [
    { role: "user", content: "Which shelf holds line 12?" },
    { role: "assistant", content: "Shelf 12." },
];
const inputText = (decision: { body?: Record<string, unknown> }) => SafeJSON.stringify(decision.body?.input);
const inputOf = (body: Record<string, unknown> | undefined): unknown[] =>
    Array.isArray(body?.input) ? body.input : [];

function saved(items: Record<string, Record<string, unknown>>, rest: Partial<CompactionRecord> = {}): CompactionRecord {
    return {
        id: "gtc1.00000000-0000-4000-8000-0000000000aa",
        model: MODEL,
        createdAt: "2026-11-10T00:00:00.000Z",
        items,
        history: [{ role: "user", content: [{ type: "input_text", text: "the earlier work" }] }],
        ...rest,
    };
}

let eventsFile = "";

function events(): Array<Record<string, unknown>> {
    try {
        return readFileSync(eventsFile, "utf8")
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => SafeJSON.parse(line) as Record<string, unknown>);
    } catch {
        return [];
    }
}

beforeEach(() => {
    eventsFile = join(mkdtempSync(join(tmpdir(), "gt-flow-")), "events.jsonl");
    setCompactionEventsPathForTests(eventsFile);
    resetBackgroundForTests();
});

afterEach(() => {
    setCompactionEventsPathForTests(undefined);
});

describe("CodexCompactionFlow: the written summary's shaping", () => {
    it("asks for no tool call and for the summary limit, at the session's effort", async () => {
        const { turn, calls } = harness(textResponse);
        const summary = { claude: { providers: { codex: { compaction: { mode: "summary" as const } } } } };
        const { decision, shapings } = await turn(
            { stream: true, messages: [...history, mark()] },
            { sessionsIn: summary }
        );

        expect(shapings[0]?.toolChoice).toBe("none");
        expect(shapings[0]?.effort).toBeUndefined();
        expect(SafeJSON.stringify(shapings[0]?.parsed.messages)).toContain("under 5000 words");
        expect(decision.answer).toBeUndefined();
        expect(decision.body?.tool_choice).toBe("none");
        // The limit goes at the end, so the cached prefix stays.
        expect(SafeJSON.stringify(inputOf(decision.body).at(-1))).toContain("under 5000 words");
        expect(calls).toHaveLength(0);
    });

    it("the compaction setting sets another effort and drops the length; an effort the model lacks stays off", async () => {
        const { turn } = harness(textResponse);
        const sessionsIn = {
            claude: {
                providers: { codex: { compaction: { mode: "summary" as const, effort: "low" as const, words: 0 } } },
            },
        };
        const low = await turn({ stream: true, messages: [mark()] }, { sessionsIn, efforts: ["low", "high"] });
        const lacking = await turn({ stream: true, messages: [mark()] }, { sessionsIn, efforts: ["high"] });

        expect(low.shapings[0]?.effort).toBe("low");
        expect(SafeJSON.stringify(low.shapings[0]?.parsed.messages)).not.toContain("words");
        expect(lacking.shapings[0]?.effort).toBeUndefined();
        expect(lacking.shapings[0]?.toolChoice).toBe("none");
    });

    it("a turn that is not a compaction is not shaped", async () => {
        const { turn } = harness(textResponse);
        const body = { stream: true, messages: [{ role: "user", content: "hi" }] };
        const { decision, shapings } = await turn(body);

        expect(shapings).toEqual([{ parsed: { model: MODEL, ...body } }]);
        expect(decision.onUsage).toBeUndefined();
    });
});

describe("CodexCompactionFlow: native compaction", () => {
    it("sends the turn without the summary prompt plus compaction_trigger, and answers a marker in summary tags", async () => {
        const { turn, calls, records, answered } = harness(() => compactionResponse("ENC-A"));
        const { decision, shapings } = await turn({ stream: false, messages: [...history, mark()] });
        const reply = SafeJSON.parse(await answered(decision)) as Record<string, unknown>;
        const text = String((reply.content as Array<Record<string, unknown>>)[0]?.text ?? "");

        expect(shapings[0]?.toolChoice).toBeUndefined();
        expect(SafeJSON.stringify(shapings[0]?.parsed)).not.toContain(CLAUDE_CODE_COMPACTION_MARK);
        expect(calls).toHaveLength(1);
        expect(inputOf(calls[0]?.body).at(-1)).toEqual({ type: "compaction_trigger" });
        expect(calls[0]?.body.stream).toBe(true);
        expect(reply.usage).toEqual({ input_tokens: 20, cache_read_input_tokens: 380, output_tokens: 50 });
        const inner = text.match(/^<summary>\n([\s\S]*)\n<\/summary>$/)?.[1] ?? "";
        expect(inner).toContain("[codex-compaction gtc1.");
        expect(inner).not.toContain("codex-compaction-fallback");
        expect([...records.values()][0]?.items).toEqual({
            [LOGIN]: { type: "compaction", id: "cmp_1", encrypted_content: "ENC-A" },
        });
        expect(events().map((event) => [event.kind, event.mode])).toEqual([
            ["turn", "native"],
            ["done", "native"],
        ]);

        // The next turn carries the note Claude Code keeps from inside the tags; the item goes back in front of it.
        const next = await turn({
            stream: true,
            messages: [{ role: "user", content: `This session is being continued.\n\nSummary:\n${inner}\n\nGo on.` }],
        });
        expect(calls).toHaveLength(1);
        expect(inputOf(next.decision.body)[0]).toEqual({
            type: "compaction",
            id: "cmp_1",
            encrypted_content: "ENC-A",
        });
        expect(inputText(next.decision)).not.toContain("codex-compaction");
        expect(inputText(next.decision)).toContain("Go on.");
    });

    it("compacts natively when Claude Code sends a system message after the compaction prompt", async () => {
        const { turn, calls, answered } = harness(() => compactionResponse("ENC-SYS"));
        const { decision } = await turn({
            stream: false,
            messages: [
                ...history,
                { role: "user", content: [{ type: "text", text: `${CLAUDE_CODE_COMPACTION_MARK}\nSummarize.` }] },
                { role: "system", content: "<total_tokens>15000000 tokens left</total_tokens>" },
            ],
        });

        expect(calls).toHaveLength(1);
        expect(inputOf(calls[0]?.body).at(-1)).toEqual({ type: "compaction_trigger" });
        expect(SafeJSON.stringify(calls[0]?.body.input)).not.toContain(CLAUDE_CODE_COMPACTION_MARK);
        expect(await answered(decision)).toContain("[codex-compaction gtc1.");
    });

    it("keeps readable text supplied by native compaction without a second model request", async () => {
        const { turn, calls, answered } = harness(() =>
            compactionResponse("ENC-A", "The earlier answer is on shelf 12.")
        );
        const note = await answered((await turn({ stream: false, messages: [mark()] })).decision);

        expect(calls).toHaveLength(1);
        expect(note).toContain("The earlier answer is on shelf 12.");
        expect(note).toContain("codex-compaction-fallback");
    });

    it("hands a compaction with no item to the written summary", async () => {
        const { turn, calls, written, answered } = harness(textResponse);
        const { decision } = await turn({ stream: true, messages: [...history, mark()] });

        expect(calls).toHaveLength(1);
        expect(await answered(decision)).toBe("written");
        expect(written).toHaveLength(1);
        expect(written[0]).toContain(CLAUDE_CODE_COMPACTION_MARK);
        expect(events().map((event) => event.mode)).toEqual(["native", "summary"]);
    });

    it("logs Claude Code's second ask for a summary as a retry", async () => {
        const { turn } = harness(() => compactionResponse("ENC-R"));
        await turn({
            stream: true,
            messages: [
                ...history,
                mark("Summarize.\n\nFor this reply only: put the summary inside <summary></summary> tags."),
            ],
        });

        expect(events().find((event) => event.kind === "retry")).toBeDefined();
    });
});

describe("CodexCompactionFlow: the items behind markers", () => {
    it("gives back the login's own item and its kept tail without an upstream request", async () => {
        const { turn, calls, records } = harness(() => new Response("", { status: 500 }));
        const record = saved(
            { [LOGIN]: { type: "compaction", encrypted_content: "A" } },
            { tail: { account: LOGIN, items: [{ role: "user", content: [{ type: "input_text", text: "kept" }] }] } }
        );
        records.set(record.id, record);
        const { decision } = await turn({
            stream: true,
            messages: [{ role: "user", content: `${compactionNote(record.id)}\nGo on.` }],
        });
        const input = inputOf(decision.body);

        expect(calls).toHaveLength(0);
        expect(input.slice(0, 2)).toEqual([
            { type: "compaction", encrypted_content: "A" },
            { role: "user", content: [{ type: "input_text", text: "kept" }] },
        ]);
    });

    it("compacts the saved history again for another login, once, on the primary login, and keeps both items", async () => {
        const { turn, calls, records } = harness((body) =>
            isTrigger(body) ? compactionResponse("ENC-HERE") : textResponse()
        );
        const record = saved(
            { [OTHER]: { type: "compaction", id: "cmp_other", encrypted_content: "ENC-OTHER" } },
            {
                history: [
                    { role: "user", content: [{ type: "input_text", text: "the earlier work" }] },
                    { type: "reasoning", id: "rs_old", encrypted_content: "old-login-reasoning", summary: [] },
                ],
            }
        );
        records.set(record.id, record);
        const body = {
            stream: true,
            messages: [{ role: "user", content: `Summary:\n${compactionNote(record.id)}\n\nGo on.` }],
        };

        const first = await turn(body);
        const second = await turn(body);

        expect(calls).toHaveLength(1);
        expect(calls[0]?.client?.primaryOnly).toBe(true);
        expect(calls[0]?.body.input).toEqual([
            { role: "user", content: [{ type: "input_text", text: "the earlier work" }] },
            { type: "compaction_trigger" },
        ]);
        for (const { decision } of [first, second]) {
            expect(inputOf(decision.body)[0]).toMatchObject({ encrypted_content: "ENC-HERE" });
        }
        expect(Object.keys(records.get(record.id)?.items ?? {}).sort()).toEqual([LOGIN, OTHER]);
        expect(events().map((event) => event.kind)).toEqual(["recompacted"]);
    });

    it("refuses to continue when a record is missing, with no upstream request", async () => {
        const { turn, calls, answered } = harness(textResponse);
        const id = "gtc1.00000000-0000-4000-8000-0000000000bb";
        const { decision } = await turn({
            stream: true,
            messages: [{ role: "user", content: `Summary:\n${compactionNote(id)}\n\nGo on.` }],
        });
        const text = await answered(decision);

        expect(decision.answer?.status).toBe(400);
        expect(text).toContain(`Compaction record ${id} is missing or unreadable`);
        expect(text).toContain("start a new session with a readable handoff");
        expect(calls).toHaveLength(0);
        expect(events().map((event) => event.kind)).toEqual(["blocked"]);
    });

    it("notes the blocked marker on the session record", async () => {
        const { turn } = harness(textResponse);
        const sessionId = crypto.randomUUID();
        createSessionRecord({ id: sessionId });
        const id = "gtc1.00000000-0000-4000-8000-0000000000cc";
        const { decision } = await turn(
            { stream: true, messages: [{ role: "user", content: compactionNote(id) }] },
            { sessionId }
        );

        expect(decision.answer?.status).toBe(400);
        expect(await decision.answer?.text()).toContain(
            `session ${sessionId} compaction-restore --marker ${id} --from`
        );
        expect(readSessionRecord(sessionId)?.blockedCompactions).toContain(id);
    });

    it("uses the readable summary when a record is missing", async () => {
        const { turn } = harness(textResponse);
        const id = "gtc1.00000000-0000-4000-8000-0000000000dd";
        const { decision } = await turn({
            stream: true,
            messages: [{ role: "user", content: compactionNote(id, "Shelf 12 holds the answer.") }],
        });

        expect(decision.answer).toBeUndefined();
        expect(inputText(decision)).toContain("Shelf 12 holds the answer.");
    });

    it("answers 503 when another login cannot recompact the saved history", async () => {
        const { turn, calls, records, answered } = harness(textResponse);
        const record = saved({ [OTHER]: { type: "compaction", encrypted_content: "old" } });
        records.set(record.id, record);
        const { decision } = await turn({
            stream: true,
            messages: [{ role: "user", content: compactionNote(record.id) }],
        });

        expect(decision.answer?.status).toBe(503);
        expect(await answered(decision)).toContain(`Could not restore compaction ${record.id}`);
        expect(calls).toHaveLength(1);
    });

    it("uses the readable summary when cross-login recompaction fails", async () => {
        const { turn, calls, records } = harness(textResponse);
        const record = saved({ [OTHER]: { type: "compaction", encrypted_content: "old" } });
        records.set(record.id, record);
        const { decision } = await turn({
            stream: true,
            messages: [{ role: "user", content: compactionNote(record.id, "Earlier work is on shelf 12.") }],
        });

        expect(calls).toHaveLength(1);
        expect(decision.answer).toBeUndefined();
        expect(inputText(decision)).toContain("Earlier work is on shelf 12.");
    });

    it("answers an upstream failure while restoring with that failure", async () => {
        const { turn, records } = harness(() => new Response('{"error":{"message":"slow down"}}', { status: 429 }));
        const record = saved({ [OTHER]: { type: "compaction", encrypted_content: "old" } });
        records.set(record.id, record);
        const { decision } = await turn({
            stream: true,
            messages: [{ role: "user", content: compactionNote(record.id) }],
        });

        expect(decision.answer?.status).toBe(429);
        expect(await decision.answer?.text()).toContain("slow down");
    });
});

describe("CodexCompactionFlow: the background run", () => {
    const claudeSession = "11111111-2222-4333-8444-555555555555";
    const metadata = { user_id: SafeJSON.stringify({ session_id: claudeSession }) };
    const u1 = { role: "user", content: "The code word is KESTREL." };
    const a1 = { role: "assistant", content: "Noted." };
    const u2 = { role: "user", content: "Also remember shelf 31." };
    const a2 = { role: "assistant", content: "Shelf 31 noted." };
    const compactTurn = (first: Record<string, unknown>) => [
        first,
        a1,
        u2,
        a2,
        { role: "user", content: [{ type: "text", text: `${CLAUDE_CODE_COMPACTION_MARK}\nSummarize.` }] },
    ];
    const base = { stream: true, system: "S", metadata };

    /** A ccx session whose compaction point is 500 tokens: 0.8 of it starts a background run. */
    function session(): string {
        const sessionId = crypto.randomUUID();
        createSessionRecord({ id: sessionId, window: 1000, compactPercent: 50 });
        return sessionId;
    }

    /** One ordinary turn whose answer reports `inputTokens` of context; waits for any run it started. */
    async function usageTurn(
        h: ReturnType<typeof harness>,
        sessionId: string,
        messages: unknown[],
        inputTokens: number
    ): Promise<void> {
        const { decision, compacting } = await h.turn({ ...base, messages }, { sessionId });
        decision.onUsage?.({ input_tokens: inputTokens });

        if (compacting.background) {
            await backgroundInFlight(compacting.background.key);
        }
    }

    const answer = (body: Record<string, unknown>) => (isTrigger(body) ? compactionResponse("ENC-BG") : textResponse());

    it("answers the compaction turn from the run, and keeps the later turns behind its item", async () => {
        const h = harness(answer);
        const sessionId = session();
        await usageTurn(h, sessionId, [u1], 450);

        expect(h.calls.filter((call) => isTrigger(call.body))).toHaveLength(1);
        expect(h.usage).toHaveLength(1);
        expect(h.usage[0]?.path).toBe("/v1/messages#background-compaction");
        const { decision } = await h.turn({ ...base, messages: compactTurn(u1) }, { sessionId });
        const inner = (await h.answered(decision)).match(/<summary>\\n([\s\S]*?)\\n<\/summary>/)?.[1] ?? "";

        expect(h.calls).toHaveLength(1);
        expect(inner).toContain("[codex-compaction gtc1.");
        const next = await h.turn(
            { ...base, messages: [{ role: "user", content: `Summary:\n${inner.replaceAll("\\n", "\n")}\n\nGo on.` }] },
            { sessionId }
        );
        const input = inputOf(next.decision.body);
        expect(input[0]).toEqual({ type: "compaction", id: "cmp_1", encrypted_content: "ENC-BG" });
        expect(inputText(next.decision)).toContain("Also remember shelf 31.");
        expect(inputText(next.decision)).toContain("Shelf 31 noted.");
        expect(inputText(next.decision)).not.toContain("KESTREL");
        expect(events().map((event) => event.kind)).toEqual(
            expect.arrayContaining(["background-start", "background-ready", "background-used", "done"])
        );
    });

    it("sends a kept turn once when Claude Code also keeps it after the summary", async () => {
        const h = harness(answer);
        const sessionId = session();
        await usageTurn(h, sessionId, [u1], 450);
        const { decision } = await h.turn({ ...base, messages: compactTurn(u1) }, { sessionId });
        const inner = (
            (await h.answered(decision)).match(/<summary>\\n([\s\S]*?)\\n<\/summary>/)?.[1] ?? ""
        ).replaceAll("\\n", "\n");
        const next = await h.turn(
            {
                ...base,
                messages: [{ role: "user", content: `Summary:\n${inner}` }, a2, { role: "user", content: "Go on." }],
            },
            { sessionId }
        );

        expect(inputText(next.decision).split("Shelf 31 noted.").length - 1).toBe(1);
        expect(inputText(next.decision)).toContain("Also remember shelf 31.");
    });

    it("records the older ready run as wasted when a newer run replaces it unused", async () => {
        const h = harness(answer);
        const sessionId = session();
        await usageTurn(h, sessionId, [u1], 450);
        // 600 is 33% past the first run's 450: a refresh run starts and replaces the unused first result.
        await usageTurn(h, sessionId, [u1, a1, u2], 600);

        expect(h.calls.filter((call) => isTrigger(call.body))).toHaveLength(2);
        expect(
            events()
                .filter((event) => event.kind === "background-wasted")
                .map((event) => event.reason)
        ).toEqual(["superseded"]);
    });

    it("answers the compaction turn from a run that finished before the proxy restarted", async () => {
        const h = harness(answer);
        const sessionId = session();
        await usageTurn(h, sessionId, [u1], 450);
        forgetBackgroundInMemoryForTests();
        const { decision } = await h.turn({ ...base, messages: compactTurn(u1) }, { sessionId });

        expect(h.calls.filter((call) => isTrigger(call.body))).toHaveLength(1);
        expect(await h.answered(decision)).toContain("[codex-compaction gtc1.");
    });

    it("does not start a second run after a restart while the saved run is still fresh", async () => {
        const h = harness(answer);
        const sessionId = session();
        await usageTurn(h, sessionId, [u1], 450);
        forgetBackgroundInMemoryForTests();
        // 460 is only 2% past the saved run's 450: no refresh is due.
        await usageTurn(h, sessionId, [u1, a1, u2], 460);

        expect(h.calls.filter((call) => isTrigger(call.body))).toHaveLength(1);
    });

    it("compacts again and tells the agent once when the history changed under the run", async () => {
        const h = harness(answer);
        const sessionId = session();
        await usageTurn(h, sessionId, [u1], 450);
        const { decision } = await h.turn(
            { ...base, messages: compactTurn({ role: "user", content: "The code word is FALCON." }) },
            { sessionId }
        );
        const reply = await h.answered(decision);

        expect(h.calls.filter((call) => isTrigger(call.body))).toHaveLength(2);
        expect(reply).toContain("Proxy notice");
        expect(reply).toContain("the conversation before it changed");
        expect(events().find((event) => event.kind === "background-wasted")?.reason).toBe("history_changed");

        const reminded = await h.turn({ ...base, messages: [{ role: "user", content: "Go on." }] }, { sessionId });
        expect(inputText(reminded.decision)).toContain("Start your next reply with one sentence");
        const after = await h.turn({ ...base, messages: [{ role: "user", content: "Go on." }] }, { sessionId });
        expect(inputText(after.decision)).not.toContain("Start your next reply");
    });

    it("does not start a run below the start fraction, and has no usage hook outside a ccx session", async () => {
        const h = harness(answer);
        await usageTurn(h, session(), [u1], 300);
        const plain = crypto.randomUUID();
        createSessionRecord({ id: plain });
        const { decision } = await h.turn({ ...base, messages: [u1] }, { sessionId: plain });

        expect(decision.onUsage).toBeUndefined();
        expect(h.calls).toHaveLength(0);
        expect(isObject(decision.body)).toBe(true);
    });
});
