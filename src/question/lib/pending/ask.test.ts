import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Migration, runMigrations } from "@genesiscz/utils/database/migrations";
import { SafeJSON } from "@genesiscz/utils/json";
import { openReadModel, queryEntries } from "../read-model";
import type { QaEntry } from "../types";
import {
    type AskDeps,
    answerAskForm,
    cancelAskForm,
    explainCancelRefusal,
    getAskForm,
    listPendingForms,
    pollAskForms,
    postAskForm,
    waitForAskForm,
} from "./ask";
import { claimForm, PENDING_MIGRATIONS, releaseClaim } from "./store";
import { ANSWER_CLAIM_TTL_MS, type AskAnswer, MAX_WAIT_BUDGET_MS } from "./types";

let deps: AskDeps;
let db: Database;
let scratch = "";
let logBase = "";

beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db, PENDING_MIGRATIONS as Migration[], { tableName: "qa_pending" });
    scratch = mkdtempSync(join(tmpdir(), "gt-ask-"));
    logBase = join(scratch, "log");
    deps = { db, eventBase: join(scratch, "events"), logBase, notify: false };
});

afterEach(() => {
    db.close();
});

const PROJECT = "/tmp/gt-ask-fixture";

describe("postAskForm", () => {
    test("normalizes string choices and defaults every item flag", async () => {
        const form = await postAskForm(
            { projectPath: PROJECT, items: [{ promptMarkdown: "Ship?", choices: ["yes", "no"] }] },
            deps
        );

        expect(form.status).toBe("pending");
        expect(form.items[0].id).toBe("q1");
        expect(form.items[0].choices).toEqual([
            { id: "yes", label: "yes" },
            { id: "no", label: "no" },
        ]);
        expect(form.items[0].required).toBe(true);
        expect(form.items[0].allowFreeText).toBe(true);
    });

    test("a created form is readable back and listed as pending", async () => {
        const form = await postAskForm({ projectPath: PROJECT, items: [{ promptMarkdown: "Ship?" }] }, deps);

        expect(getAskForm(form.id, deps)?.id).toBe(form.id);
        expect(listPendingForms(deps).map((f) => f.id)).toContain(form.id);
    });

    test("an omitted session hint is the harness that posted the question", async () => {
        const form = await postAskForm(
            { projectPath: PROJECT, items: [{ promptMarkdown: "Ship?" }] },
            { ...deps, env: { CLAUDE_CODE_SESSION_ID: "sess-9", CLAUDECODE: "1" } }
        );

        expect(form.sessionHint).toBe("sess-9");
    });

    test("a typed session hint is kept when this process is a test", async () => {
        const form = await postAskForm(
            { projectPath: PROJECT, sessionHint: "typed", items: [{ promptMarkdown: "Ship?" }] },
            { ...deps, env: { CLAUDE_CODE_SESSION_ID: "sess-9", CLAUDECODE: "1" } }
        );

        expect(form.sessionHint).toBe("typed");
    });

    test("a server posting for a remote caller stamps none of its own context", async () => {
        const server = { ...deps, ambient: false, env: { CLAUDE_CODE_SESSION_ID: "server-sess", CLAUDECODE: "1" } };
        const form = await postAskForm({ projectPath: PROJECT, items: [{ promptMarkdown: "Ship?" }] }, server);

        expect(form.sessionHint).toBeUndefined();
        await expect(postAskForm({ items: [{ promptMarkdown: "Ship?" }] }, server)).rejects.toThrow(
            /projectPath is required/
        );
    });

    test("a form with no items is refused", async () => {
        await expect(postAskForm({ projectPath: PROJECT, items: [] }, deps)).rejects.toThrow("at least one item");
    });
});

describe("answerAskForm", () => {
    test("answering writes a QaEntry and links it to the form", async () => {
        const form = await postAskForm(
            { projectPath: PROJECT, items: [{ promptMarkdown: "Ship?", choices: ["yes", "no"] }] },
            deps
        );
        const outcome = await answerAskForm(form.id, [{ itemId: "q1", selectedChoices: ["yes"] }], deps);

        expect(outcome.ok).toBe(true);
        expect(outcome.ok && outcome.entryId.length).toBeGreaterThan(0);
        expect(outcome.ok && outcome.form.status).toBe("answered");
        expect(outcome.ok && outcome.form.entryId).toBe(outcome.ok ? outcome.entryId : "");
    });

    test("a missing required item is refused with the item ids, and the form stays pending", async () => {
        const form = await postAskForm(
            { projectPath: PROJECT, items: [{ promptMarkdown: "One?" }, { promptMarkdown: "Two?" }] },
            deps
        );
        const outcome = await answerAskForm(form.id, [{ itemId: "q1", freeText: "a" }], deps);

        expect(outcome.ok).toBe(false);
        expect(outcome.ok === false && outcome.code).toBe("incomplete");
        expect(outcome.ok === false && outcome.missing).toEqual(["q2"]);
        expect(getAskForm(form.id, deps)?.status).toBe("pending");
    });

    test("an optional item may be left blank", async () => {
        const form = await postAskForm(
            {
                projectPath: PROJECT,
                items: [{ promptMarkdown: "One?" }, { promptMarkdown: "Notes?", required: false }],
            },
            deps
        );
        const outcome = await answerAskForm(form.id, [{ itemId: "q1", freeText: "a" }], deps);

        expect(outcome.ok).toBe(true);
    });

    test("a choice the item never offered is dropped rather than stored", async () => {
        const form = await postAskForm(
            { projectPath: PROJECT, items: [{ promptMarkdown: "Ship?", choices: ["yes", "no"] }] },
            deps
        );
        const outcome = await answerAskForm(
            form.id,
            [{ itemId: "q1", selectedChoices: ["rm -rf"], freeText: "keep me" }],
            deps
        );

        expect(outcome.ok).toBe(true);
        expect(outcome.ok && outcome.form.answers?.q1.selectedChoices).toBeUndefined();
        expect(outcome.ok && outcome.form.answers?.q1.freeText).toBe("keep me");
    });

    test("an item that offered NO choices cannot be closed with a smuggled choice", async () => {
        const form = await postAskForm({ projectPath: PROJECT, items: [{ promptMarkdown: "Why?" }] }, deps);
        const outcome = await answerAskForm(form.id, [{ itemId: "q1", selectedChoices: ["looks answered"] }], deps);

        expect(outcome.ok).toBe(false);
        expect(!outcome.ok && outcome.code).toBe("incomplete");
        expect(getAskForm(form.id, deps)?.status).toBe("pending");
    });

    test("a choice-only item cannot be closed with free text it never offered", async () => {
        const form = await postAskForm(
            {
                projectPath: PROJECT,
                items: [{ promptMarkdown: "Ship?", choices: ["yes", "no"], allowFreeText: false }],
            },
            deps
        );
        const outcome = await answerAskForm(form.id, [{ itemId: "q1", freeText: "whatever" }], deps);

        expect(outcome.ok).toBe(false);
        expect(!outcome.ok && outcome.code).toBe("incomplete");
        expect(getAskForm(form.id, deps)?.status).toBe("pending");
    });

    test("a duplicate item id is refused, so one answer cannot satisfy two questions", async () => {
        await expect(
            postAskForm(
                {
                    projectPath: PROJECT,
                    items: [
                        { id: "q1", promptMarkdown: "A?" },
                        { id: "q1", promptMarkdown: "B?" },
                    ],
                },
                deps
            )
        ).rejects.toThrow(/duplicate item id/);
    });

    test("a duplicate choice id is refused, because an answer could not name either one", async () => {
        await expect(
            postAskForm({ projectPath: PROJECT, items: [{ promptMarkdown: "Ship?", choices: ["yes", "yes"] }] }, deps)
        ).rejects.toThrow(/duplicate choice id/);
    });

    test("@file tags are dropped when the item did not allow them", async () => {
        const form = await postAskForm({ projectPath: PROJECT, items: [{ promptMarkdown: "Which file?" }] }, deps);
        const outcome = await answerAskForm(
            form.id,
            [{ itemId: "q1", freeText: "x", fileTags: ["src/index.ts"] }],
            deps
        );

        expect(outcome.ok && outcome.form.answers?.q1.fileTags).toBeUndefined();
    });

    test("a second submit cannot overwrite a recorded answer", async () => {
        const form = await postAskForm({ projectPath: PROJECT, items: [{ promptMarkdown: "Ship?" }] }, deps);
        await answerAskForm(form.id, [{ itemId: "q1", freeText: "first" }], deps);
        const second = await answerAskForm(form.id, [{ itemId: "q1", freeText: "second" }], deps);

        expect(second.ok).toBe(false);
        expect(second.ok === false && second.code).toBe("not_pending");
        expect(getAskForm(form.id, deps)?.answers?.q1.freeText).toBe("first");
    });

    test("an unknown form id is a not_found, never a throw", async () => {
        const outcome = await answerAskForm("ask_nope", [{ itemId: "q1", freeText: "x" }], deps);

        expect(outcome.ok === false && outcome.code).toBe("not_found");
    });
});

describe("cancelAskForm", () => {
    test("cancelling flips the status and a later answer is refused", async () => {
        const form = await postAskForm({ projectPath: PROJECT, items: [{ promptMarkdown: "Ship?" }] }, deps);

        expect(cancelAskForm(form.id, deps)?.status).toBe("cancelled");

        const outcome = await answerAskForm(form.id, [{ itemId: "q1", freeText: "x" }], deps);
        expect(outcome.ok === false && outcome.code).toBe("not_pending");
    });

    test("cancelling an already-resolved form returns null", async () => {
        const form = await postAskForm({ projectPath: PROJECT, items: [{ promptMarkdown: "Ship?" }] }, deps);
        cancelAskForm(form.id, deps);

        expect(cancelAskForm(form.id, deps)).toBeNull();
    });
});

describe("a timeout the store cannot arithmetic on", () => {
    // `expireDueForms` compares `created_at + timeout_ms`, and the HTTP door takes this value
    // straight from a request body, so a junk timeout used to retire the form the instant it
    // was posted (negative) or poison the comparison (NaN, a string).
    test.each([
        ["negative", -1],
        ["zero", 0],
        ["NaN", Number.NaN],
        ["infinite", Number.POSITIVE_INFINITY],
        ["a string", "60000"],
        // Floors to 0, and a stored 0 retires the form on the first sweep.
        ["under a millisecond", 0.5],
    ])("a %s timeout is dropped rather than stored", async (_label, timeoutMs) => {
        const form = await postAskForm(
            {
                projectPath: PROJECT,
                items: [{ promptMarkdown: "Ship?" }],
                timeoutMs: timeoutMs as number,
            },
            deps
        );

        expect(form.timeoutMs).toBeUndefined();
        // The decisive part: it must still be waiting, not retired on arrival.
        expect(getAskForm(form.id, deps)?.status).toBe("pending");
    });

    test("a fractional timeout is floored, so the stored value stays an integer", async () => {
        const form = await postAskForm(
            { projectPath: PROJECT, items: [{ promptMarkdown: "Ship?" }], timeoutMs: 1500.7 },
            deps
        );

        expect(form.timeoutMs).toBe(1500);
    });

    test("a timeout past the supported ceiling is clamped to it", async () => {
        const form = await postAskForm(
            { projectPath: PROJECT, items: [{ promptMarkdown: "Ship?" }], timeoutMs: Number.MAX_SAFE_INTEGER },
            deps
        );

        expect(form.timeoutMs).toBe(MAX_WAIT_BUDGET_MS);
    });
});

describe("a malformed submit", () => {
    test("an answers value that is not an array is incomplete, never a throw", async () => {
        const form = await postAskForm({ projectPath: PROJECT, items: [{ promptMarkdown: "Ship?" }] }, deps);
        // The HTTP door passes the parsed body straight through, so this really does arrive.
        const outcome = await answerAskForm(form.id, {} as unknown as AskAnswer[], deps);

        expect(outcome.ok).toBe(false);
        expect(outcome.ok === false && outcome.code).toBe("incomplete");
        expect(getAskForm(form.id, deps)?.status).toBe("pending");
    });

    test("a null entry is skipped rather than read for its itemId", async () => {
        const form = await postAskForm({ projectPath: PROJECT, items: [{ promptMarkdown: "Ship?" }] }, deps);
        const outcome = await answerAskForm(
            form.id,
            [null, { itemId: "q1", freeText: "go" }] as unknown as AskAnswer[],
            deps
        );

        expect(outcome.ok).toBe(true);
        expect(getAskForm(form.id, deps)?.status).toBe("answered");
    });

    test("a refused submit never costs the claim, so the next one still lands", async () => {
        const form = await postAskForm({ projectPath: PROJECT, items: [{ promptMarkdown: "Ship?" }] }, deps);

        await answerAskForm(form.id, {} as unknown as AskAnswer[], deps);

        // Validation is a pure read, so the refused submit must not have taken the lease.
        expect(claimForm(db, form.id)).not.toBeNull();
    });
});

describe("explainCancelRefusal", () => {
    test("an id no form carries is not_found", async () => {
        expect(explainCancelRefusal("ask_nope", deps)).toEqual({
            code: "not_found",
            message: "unknown form: ask_nope",
        });
    });

    test("a form an answer holds is named as being answered, not as already resolved", async () => {
        const form = await postAskForm({ projectPath: PROJECT, items: [{ promptMarkdown: "Ship?" }] }, deps);

        expect(claimForm(db, form.id)).not.toBeNull();
        // The cancel is refused while the claim is live, and the form is STILL pending — the
        // state a door cannot tell apart from an unknown id without this.
        expect(cancelAskForm(form.id, deps)).toBeNull();

        const refusal = explainCancelRefusal(form.id, deps);

        expect(refusal.code).toBe("being_answered");
        expect(refusal.message).toContain("is being answered right now");
    });

    test("a resolved form reports the status it actually reached", async () => {
        const form = await postAskForm({ projectPath: PROJECT, items: [{ promptMarkdown: "Ship?" }] }, deps);
        cancelAskForm(form.id, deps);

        expect(explainCancelRefusal(form.id, deps)).toEqual({
            code: "already_resolved",
            message: `form ${form.id} is already cancelled`,
            form: getAskForm(form.id, deps) as NonNullable<ReturnType<typeof getAskForm>>,
        });
    });
});

describe("waitForAskForm", () => {
    test("returns answered as soon as the answer lands", async () => {
        const form = await postAskForm({ projectPath: PROJECT, items: [{ promptMarkdown: "Ship?" }] }, deps);
        const waiting = waitForAskForm(form.id, 5_000, deps);
        await answerAskForm(form.id, [{ itemId: "q1", freeText: "go" }], deps);
        const result = await waiting;

        expect(result.waiter).toBe("answered");
        expect(result.form?.answers?.q1.freeText).toBe("go");
    });

    test("returns cancelled when the form is withdrawn", async () => {
        const form = await postAskForm({ projectPath: PROJECT, items: [{ promptMarkdown: "Ship?" }] }, deps);
        const waiting = waitForAskForm(form.id, 5_000, deps);
        cancelAskForm(form.id, deps);

        expect((await waiting).waiter).toBe("cancelled");
    });

    test("a spent budget reports budget_exhausted and leaves the form pending", async () => {
        const form = await postAskForm({ projectPath: PROJECT, items: [{ promptMarkdown: "Ship?" }] }, deps);
        const result = await waitForAskForm(form.id, 10, deps);

        expect(result.waiter).toBe("budget_exhausted");
        expect(result.form?.status).toBe("pending");
    });

    test("an id no form carries is not_found, never a spent budget", async () => {
        const result = await waitForAskForm("ask_nobody_has_this", 5_000, deps);

        expect(result.waiter).toBe("not_found");
        expect(result.form).toBeNull();
    });

    test("a non-finite budget falls back to the default rather than spinning", async () => {
        const form = await postAskForm({ projectPath: PROJECT, items: [{ promptMarkdown: "Ship?" }] }, deps);
        const waiting = waitForAskForm(form.id, Number.NaN, deps);
        cancelAskForm(form.id, deps);

        expect((await waiting).waiter).toBe("cancelled");
    });

    test("an elapsed form timeout reports timeout, which a spent budget never does", async () => {
        const form = await postAskForm(
            { projectPath: PROJECT, items: [{ promptMarkdown: "Ship?" }], timeoutMs: 20 },
            deps
        );
        const result = await waitForAskForm(form.id, 5_000, deps);

        expect(result.waiter).toBe("timeout");
        expect(getAskForm(form.id, deps)?.status).toBe("timeout");
    });
});

describe("lifecycle events are best effort", () => {
    // `appendPendingEvent` is synchronous filesystem I/O that runs AFTER the row is committed.
    // A form that exists must never be reported as a failure because its event could not be
    // written; every client reconciles from the REST snapshot, so a dropped frame costs a
    // refresh. `eventBase` points at a FILE here, so mkdirSync throws.
    test("a form still posts when its event log cannot be written", async () => {
        const blocked = join(mkdtempSync(join(tmpdir(), "gt-ask-blocked-")), "not-a-dir");
        writeFileSync(blocked, "");
        const brokenDeps = { ...deps, eventBase: blocked };

        const form = await postAskForm({ projectPath: PROJECT, items: [{ promptMarkdown: "Ship?" }] }, brokenDeps);

        expect(form.status).toBe("pending");
        expect(getAskForm(form.id, brokenDeps)?.id).toBe(form.id);
    });

    test("an answer still lands when its event log cannot be written", async () => {
        const blocked = join(mkdtempSync(join(tmpdir(), "gt-ask-blocked2-")), "not-a-dir");
        writeFileSync(blocked, "");
        const brokenDeps = { ...deps, eventBase: blocked };
        const form = await postAskForm({ projectPath: PROJECT, items: [{ promptMarkdown: "Ship?" }] }, brokenDeps);
        const outcome = await answerAskForm(form.id, [{ itemId: "q1", freeText: "yes" }], brokenDeps);

        expect(outcome.ok).toBe(true);
        expect(getAskForm(form.id, brokenDeps)?.status).toBe("answered");
    });
});

describe("pollAskForms", () => {
    test("a batch poll maps every id, with null for the unknown ones", async () => {
        const form = await postAskForm({ projectPath: PROJECT, items: [{ promptMarkdown: "Ship?" }] }, deps);
        const map = pollAskForms([form.id, "ask_missing"], deps);

        expect(map[form.id]?.status).toBe("pending");
        expect(map.ask_missing).toBeNull();
    });
});

/**
 * A race duplicates the DURABLE write, so these assert on history itself rather than on the
 * outcome object. `recordAnswer` appends one JSONL line per call under `logBase`, and the read
 * model ingests those lines into `entries`; an outcome that says `not_pending` proves nothing
 * about what its caller already wrote on the way there.
 */
function historyLines(): QaEntry[] {
    if (!existsSync(logBase)) {
        return [];
    }

    return readdirSync(logBase)
        .filter((name) => name.endsWith(".jsonl"))
        .flatMap((name) =>
            readFileSync(join(logBase, name), "utf8")
                .split("\n")
                .filter((line) => line.trim().length > 0)
                .map((line) => SafeJSON.parse(line, { strict: true }) as QaEntry)
        );
}

/**
 * Rows as the read model actually stores them, with NO `superseded_by` filter. The dedupe pass
 * keys on `sessionId|ts|question`, so it would hide a duplicate behind `superseded_by` and make
 * `queryEntries` report one row while two were written. The orphan is the row, not the view.
 */
function historyRows(): { id: string; question: string }[] {
    const model = openReadModel(join(scratch, "read.db"));
    queryEntries(model, { logBase });
    const rows = model.query("SELECT id, question FROM entries ORDER BY rowid").all() as {
        id: string;
        question: string;
    }[];
    model.close();

    return rows;
}

describe("one history entry per form, whoever loses the race", () => {
    test("a concurrent second answer writes NO second history entry", async () => {
        const form = await postAskForm({ projectPath: PROJECT, items: [{ promptMarkdown: "Ship?" }] }, deps);

        // Both calls run synchronously past the pending read and into their own history write
        // before either yields, which is exactly what two dashboard tabs produce.
        const [first, second] = await Promise.all([
            answerAskForm(form.id, [{ itemId: "q1", freeText: "first" }], deps),
            answerAskForm(form.id, [{ itemId: "q1", freeText: "second" }], deps),
        ]);
        const winners = [first, second].filter((outcome) => outcome.ok);
        const losers = [first, second].filter((outcome) => !outcome.ok);

        expect(winners).toHaveLength(1);
        expect(losers).toHaveLength(1);
        expect(losers[0]?.ok === false && losers[0].code).toBe("not_pending");

        expect(historyLines()).toHaveLength(1);
        expect(historyRows()).toHaveLength(1);

        const stored = getAskForm(form.id, deps);

        expect(stored?.status).toBe("answered");
        expect(stored?.entryId).toBe(winners[0]?.ok ? winners[0].entryId : "");
        // The one entry that exists is the WINNER's, so the loser lost the history write too.
        const entryId = stored?.entryId ?? "";

        expect(entryId).not.toBe("");
        expect(historyLines().map((entry) => entry.id)).toEqual([entryId]);
    });

    test("a cancel that lands mid-answer cannot orphan a history entry", async () => {
        const form = await postAskForm({ projectPath: PROJECT, items: [{ promptMarkdown: "Ship?" }] }, deps);

        // Deliberately not awaited: the answer is now parked inside its own history write, which
        // is the window a cancel used to walk into.
        const answering = answerAskForm(form.id, [{ itemId: "q1", freeText: "go" }], deps);
        const cancelled = cancelAskForm(form.id, deps);
        const outcome = await answering;

        // The answer holds the form, so the cancel finds nothing left to cancel.
        expect(cancelled).toBeNull();
        expect(outcome.ok).toBe(true);
        expect(getAskForm(form.id, deps)?.status).toBe("answered");
        expect(historyLines()).toHaveLength(1);
        expect(historyRows()).toHaveLength(1);
    });

    test("a claim another process holds refuses the answer BEFORE it writes any history", async () => {
        const form = await postAskForm({ projectPath: PROJECT, items: [{ promptMarkdown: "Ship?" }] }, deps);

        expect(claimForm(db, form.id)).not.toBeNull();

        const outcome = await answerAskForm(form.id, [{ itemId: "q1", freeText: "mine" }], deps);

        expect(outcome.ok).toBe(false);
        expect(outcome.ok === false && outcome.code).toBe("not_pending");
        expect(historyLines()).toEqual([]);
        expect(getAskForm(form.id, deps)?.status).toBe("pending");
    });
});

describe("a claim its owner never finished", () => {
    test("an expired lease is stolen, so a dead answerer cannot wedge the form", async () => {
        const form = await postAskForm({ projectPath: PROJECT, items: [{ promptMarkdown: "Ship?" }] }, deps);

        // A process that claimed the form and then died: the row keeps a stamp nobody will
        // ever finalize.
        expect(claimForm(db, form.id, Date.now() - ANSWER_CLAIM_TTL_MS - 1)).not.toBeNull();

        const outcome = await answerAskForm(form.id, [{ itemId: "q1", freeText: "go" }], deps);

        expect(outcome.ok).toBe(true);
        expect(getAskForm(form.id, deps)?.status).toBe("answered");
        expect(historyLines()).toHaveLength(1);
    });

    test("an expired lease no longer blocks a cancel either", async () => {
        const form = await postAskForm({ projectPath: PROJECT, items: [{ promptMarkdown: "Ship?" }] }, deps);
        claimForm(db, form.id, Date.now() - ANSWER_CLAIM_TTL_MS - 1);

        expect(cancelAskForm(form.id, deps)?.status).toBe("cancelled");
    });

    test("a history write that throws releases the claim at once, without waiting out the lease", async () => {
        const form = await postAskForm({ projectPath: PROJECT, items: [{ promptMarkdown: "Ship?" }] }, deps);
        // `logBase` points at a FILE, so the append inside `recordAnswer` cannot create its dir.
        const blocked = join(mkdtempSync(join(tmpdir(), "gt-ask-logfail-")), "not-a-dir");
        writeFileSync(blocked, "");

        await expect(
            answerAskForm(form.id, [{ itemId: "q1", freeText: "x" }], { ...deps, logBase: blocked })
        ).rejects.toThrow();

        // Same millisecond, no lease expiry involved: the failed answer handed the form back.
        const retry = await answerAskForm(form.id, [{ itemId: "q1", freeText: "second try" }], deps);

        expect(retry.ok).toBe(true);
        expect(historyLines()).toHaveLength(1);
    });

    test("a form whose timeout elapses while an answer holds it is not retired underneath it", async () => {
        const form = await postAskForm(
            { projectPath: PROJECT, items: [{ promptMarkdown: "Ship?" }], timeoutMs: 1 },
            deps
        );
        await Bun.sleep(5);
        const claim = claimForm(db, form.id);

        expect(claim).not.toBeNull();
        // `getAskForm` sweeps first, and the sweep is what used to retire the form out from
        // under an answer that had already written its history entry.
        expect(getAskForm(form.id, deps)?.status).toBe("pending");

        releaseClaim(db, form.id, claim?.claimedAt ?? 0);

        expect(getAskForm(form.id, deps)?.status).toBe("timeout");
    });
});
