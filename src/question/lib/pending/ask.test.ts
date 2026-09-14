import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Migration, runMigrations } from "@genesiscz/utils/database/migrations";
import {
    type AskDeps,
    answerAskForm,
    cancelAskForm,
    getAskForm,
    listPendingForms,
    pollAskForms,
    postAskForm,
    waitForAskForm,
} from "./ask";
import { PENDING_MIGRATIONS } from "./store";

let deps: AskDeps;
let db: Database;

beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db, PENDING_MIGRATIONS as Migration[], { tableName: "qa_pending" });
    const scratch = mkdtempSync(join(tmpdir(), "gt-ask-"));
    deps = { db, eventBase: join(scratch, "events"), logBase: join(scratch, "log"), notify: false };
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

describe("pollAskForms", () => {
    test("a batch poll maps every id, with null for the unknown ones", async () => {
        const form = await postAskForm({ projectPath: PROJECT, items: [{ promptMarkdown: "Ship?" }] }, deps);
        const map = pollAskForms([form.id, "ask_missing"], deps);

        expect(map[form.id]?.status).toBe("pending");
        expect(map.ask_missing).toBeNull();
    });
});
