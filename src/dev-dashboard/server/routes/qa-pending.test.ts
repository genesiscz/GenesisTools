import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RouteContext, RouteDef, RouteResult } from "@app/dev-dashboard/server/types";
import { claimForm, defaultPendingDbPath, openPendingStore } from "@app/question/lib/pending/store";
import type { AskForm } from "@app/question/lib/pending/types";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { qaRoutes } from "./qa";

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
