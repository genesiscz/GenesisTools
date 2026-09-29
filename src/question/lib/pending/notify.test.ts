import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface DispatchedEvent {
    app: string;
    title?: string;
    message: string;
    open?: string;
    id?: string;
    actions?: { id: string; title: string; open?: string; execute?: string }[];
}

const dispatched: DispatchedEvent[] = [];
const removed: { ids?: string[] }[] = [];

mock.module("@genesiscz/utils/notifications", () => ({
    dispatchNotification: async (e: DispatchedEvent) => {
        if (e.message.includes("BOOM")) {
            throw new Error("notify channel is down");
        }

        dispatched.push(e);
    },
}));

mock.module("@genesiscz/utils/macos/notifications", () => ({
    removeNotifications: async (target: { ids?: string[] }) => {
        removed.push(target);

        return target.ids ?? "all";
    },
}));

mock.module("@app/dev-dashboard/lib/qa-deep-link", () => ({
    buildQaDeepLink: async (id: string) => `http://myhost.example.com/qa?id=${encodeURIComponent(id)}`,
}));

import { type Migration, runMigrations } from "@genesiscz/utils/database/migrations";
import { type AskDeps, answerAskForm, cancelAskForm, postAskForm } from "./ask";
import { qaNotificationId } from "./notify";
import { PENDING_MIGRATIONS } from "./store";

let deps: AskDeps;
let db: Database;

beforeEach(() => {
    dispatched.length = 0;
    removed.length = 0;
    db = new Database(":memory:");
    runMigrations(db, PENDING_MIGRATIONS as Migration[], { tableName: "qa_pending" });
    const scratch = mkdtempSync(join(tmpdir(), "gt-ask-notify-"));
    deps = { db, eventBase: join(scratch, "events"), logBase: join(scratch, "log"), notify: true };
});

afterEach(() => {
    db.close();
});

describe("pending-form notification", () => {
    test("a new form raises one banner that deep-links to /qa?id=<formId>", async () => {
        const form = await postAskForm(
            { projectPath: "/tmp/gt-notify-fixture", items: [{ promptMarkdown: "Ship the PR?" }] },
            deps
        );

        expect(dispatched).toHaveLength(1);
        expect(dispatched[0].app).toBe("question");
        expect(dispatched[0].title).toContain("waiting for you");
        expect(dispatched[0].message).toContain("Ship the PR?");
        expect(dispatched[0].open).toBe(`http://myhost.example.com/qa?id=${encodeURIComponent(form.id)}`);
    });

    test("a multi-item form says how many more questions there are", async () => {
        await postAskForm(
            {
                projectPath: "/tmp/gt-notify-fixture",
                items: [{ promptMarkdown: "Target?" }, { promptMarkdown: "Notes?" }, { promptMarkdown: "When?" }],
            },
            deps
        );

        expect(dispatched[0].message).toContain("(+2 more)");
    });

    test("notify: false posts the form and raises nothing", async () => {
        await postAskForm(
            { projectPath: "/tmp/gt-notify-fixture", items: [{ promptMarkdown: "Quiet?" }] },
            { ...deps, notify: false }
        );

        expect(dispatched).toHaveLength(0);
    });

    test("a notify channel that throws never loses the form", async () => {
        const form = await postAskForm(
            { projectPath: "/tmp/gt-notify-fixture", items: [{ promptMarkdown: "BOOM please fail the banner" }] },
            deps
        );

        expect(form.status).toBe("pending");
        expect(dispatched).toHaveLength(0);
    });

    test("the banner carries a stable id, and a plain form gets no action buttons", async () => {
        const form = await postAskForm(
            { projectPath: "/tmp/gt-notify-fixture", items: [{ promptMarkdown: "Ship the PR?" }] },
            deps
        );

        expect(dispatched[0].id).toBe(qaNotificationId(form.id));
        expect(dispatched[0].actions).toEqual([]);
    });

    test("a binary yes/no form gets one action button per choice", async () => {
        const form = await postAskForm(
            { projectPath: "/tmp/gt-notify-fixture", items: [{ promptMarkdown: "Deploy?", choices: ["Yes", "No"] }] },
            deps
        );
        const actions = dispatched[0].actions ?? [];

        expect(actions.map((a) => a.id)).toEqual(["answer-Yes", "answer-No"]);
        const yes = actions.find((a) => a.id === "answer-Yes");
        expect(yes?.execute).toBe(`tools question answer ${form.id} --choice Yes`);
    });

    test("a staging/production form does NOT get binary buttons: neither label has a polarity", async () => {
        await postAskForm(
            {
                projectPath: "/tmp/gt-notify-fixture",
                items: [{ promptMarkdown: "Which target?", choices: ["staging", "production"] }],
            },
            deps
        );

        expect(dispatched[0].actions).toEqual([]);
    });
});

describe("banner retraction", () => {
    test("answering a form retracts its banner by the same stable id", async () => {
        const form = await postAskForm(
            { projectPath: "/tmp/gt-notify-fixture", items: [{ promptMarkdown: "Ship the PR?" }] },
            deps
        );

        expect(removed).toHaveLength(0);
        await answerAskForm(form.id, [{ itemId: "q1", freeText: "yes" }], deps);

        expect(removed).toHaveLength(1);
        expect(removed[0].ids).toEqual([qaNotificationId(form.id)]);
    });

    test("cancelling a form retracts its banner too", async () => {
        const form = await postAskForm(
            { projectPath: "/tmp/gt-notify-fixture", items: [{ promptMarkdown: "Ship the PR?" }] },
            deps
        );
        cancelAskForm(form.id, deps);
        // `cancelAskForm` retracts fire-and-forget so its own synchronous callers are unaffected;
        // give the already-started promise one microtask turn to reach the mock.
        await Bun.sleep(0);

        expect(removed).toHaveLength(1);
        expect(removed[0].ids).toEqual([qaNotificationId(form.id)]);
    });
});
