import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dispatched: { app: string; title?: string; message: string; open?: string }[] = [];

mock.module("@genesiscz/utils/notifications", () => ({
    dispatchNotification: async (e: { app: string; title?: string; message: string; open?: string }) => {
        if (e.message.includes("BOOM")) {
            throw new Error("notify channel is down");
        }

        dispatched.push(e);
    },
}));

mock.module("@app/dev-dashboard/lib/qa-deep-link", () => ({
    buildQaDeepLink: async (id: string) => `http://myhost.example.com/qa?id=${encodeURIComponent(id)}`,
}));

import { type Migration, runMigrations } from "@genesiscz/utils/database/migrations";
import { type AskDeps, postAskForm } from "./ask";
import { PENDING_MIGRATIONS } from "./store";

let deps: AskDeps;
let db: Database;

beforeEach(() => {
    dispatched.length = 0;
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
});
