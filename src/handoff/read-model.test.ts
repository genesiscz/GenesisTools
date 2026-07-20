import { describe, expect, test } from "bun:test";
import { readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { attachmentFilePath } from "./attachments";
import { executeHandoffActions, getHandoff, postHandoff } from "./executor";
import { generateEventUid } from "./ids";
import { appendHandoffEvents, handoffLogDir } from "./log-store";
import {
    applyHandoffBatch,
    catchUpHandoffs,
    getHandoffById,
    listHandoffRows,
    openHandoffModel,
    rebuildHandoffModel,
} from "./read-model";
import { byFor, freshEnv } from "./test-utils";
import type { Handoff, HandoffEvent } from "./types";

const A = byFor("session-a", "poster-a");
const B = byFor("session-b", "worker-b");

function addTasksEvent(id: string, texts: string[], explicitId?: string): HandoffEvent {
    return {
        ev: "add_tasks",
        ts: new Date().toISOString(),
        uid: generateEventUid(),
        id,
        by: A,
        tasks: texts.map((text) => (explicitId !== undefined ? { id: explicitId, text } : { text })),
    };
}

describe("CAS fold idempotency (§8.9a)", () => {
    test("a batch folded by a racing process is skipped by the stale one — no double apply", () => {
        const env = freshEnv();
        const posted = postHandoff({ title: "T", tasks: [{ text: "one" }] }, env.depsFor(A));
        const id = posted.handoff.id;

        // Delta event appended but not yet folded.
        const event = addTasksEvent(id, ["delta task"]);
        const [file] = appendHandoffEvents([event], env.base);
        const size = statSync(file).size;

        const db1 = openHandoffModel(env.dbPath);
        const db2 = openHandoffModel(env.dbPath);

        try {
            const prev = (
                db1.query("SELECT byte_offset FROM handoff_ingest_offsets WHERE file = ?").get(file) as {
                    byte_offset: number;
                }
            ).byte_offset;

            // Process 1 folds the batch first.
            catchUpHandoffs(db1, env.base);
            expect(getHandoffById(db1, id)?.tasks).toHaveLength(2);

            // Process 2 read `prev` OUTSIDE its tx before process 1 committed —
            // the CAS re-read inside the tx must skip the whole batch.
            const applied = applyHandoffBatch({
                db: db2,
                file,
                prevOffset: prev,
                events: [event],
                consumed: size - prev,
                base: env.base,
            });
            expect(applied).toBe(false);
            expect(getHandoffById(db2, id)?.tasks).toHaveLength(2);
        } finally {
            db1.close();
            db2.close();
        }
    });

    test("concurrent auto-id add_tasks fold to distinct ids; explicit collision rejected (§8.9b)", () => {
        const env = freshEnv();
        const posted = postHandoff({ title: "T", tasks: [{ text: "one" }] }, env.depsFor(A));
        const id = posted.handoff.id;

        appendHandoffEvents([addTasksEvent(id, ["from p1"]), addTasksEvent(id, ["from p2"])], env.base);
        const db = openHandoffModel(env.dbPath);

        try {
            catchUpHandoffs(db, env.base);
            const tasks = getHandoffById(db, id)?.tasks ?? [];
            expect(tasks.map((t) => t.id)).toEqual(["t1", "t2", "t3"]);

            appendHandoffEvents(
                [addTasksEvent(id, ["explicit t9"], "t9"), addTasksEvent(id, ["colliding t9"], "t9")],
                env.base
            );
            catchUpHandoffs(db, env.base);
            const after = getHandoffById(db, id)?.tasks ?? [];
            expect(after.map((t) => t.id)).toEqual(["t1", "t2", "t3", "t9"]);
        } finally {
            db.close();
        }
    });
});

describe("rebuild (§8.11)", () => {
    test("drop + re-fold deep-equals the incrementally folded state", () => {
        const env = freshEnv();
        const posted = postHandoff(
            { title: "T", description: "body", tasks: [{ text: "one" }, { text: "two" }], refs: ["src/x.ts"] },
            env.depsFor(A)
        );
        getHandoff({ id: posted.handoff.id, claim: true }, env.depsFor(B));
        executeHandoffActions(
            {
                id: posted.handoff.id,
                actions: [
                    { action: "check_task", taskId: "t1", proof: { answer: "done", commitIds: ["abc"] } },
                    { action: "deny_task", taskId: "t2", reason: "wontfix" },
                    { action: "comment", text: "note" },
                    "finish_handoff",
                ],
            },
            env.depsFor(B)
        );
        postHandoff({ title: "second", tasks: [{ text: "x" }] }, env.depsFor(B));

        const db = openHandoffModel(env.dbPath);

        try {
            catchUpHandoffs(db, env.base);
            const before = normalize(listHandoffRows(db));
            rebuildHandoffModel(db, env.base);
            const after = normalize(listHandoffRows(db));
            expect(after).toEqual(before);
        } finally {
            db.close();
        }
    });
});

function normalize(rows: Handoff[]): unknown {
    return SafeJSON.parse(
        SafeJSON.stringify(
            rows
                .map((h) => ({
                    ...h,
                    claimedBy: [...h.claimedBy].sort((a, b) => a.claimedAt.localeCompare(b.claimedAt)),
                    tasks: [...h.tasks].sort((a, b) => a.id.localeCompare(b.id)),
                }))
                .sort((a, b) => a.id.localeCompare(b.id)),
            { strict: true }
        ),
        { strict: true }
    );
}

describe("duplicate post ids (§6.1 rule 5)", () => {
    test("first wins; second post never clobbers", () => {
        const env = freshEnv();
        const posted = postHandoff({ title: "original", tasks: [{ text: "one" }] }, env.depsFor(A));
        const dupe: HandoffEvent = {
            ev: "post",
            ts: new Date().toISOString(),
            uid: generateEventUid(),
            id: posted.handoff.id,
            editId: "he_stolen00",
            title: "clobber attempt",
            tasks: [{ text: "evil" }],
            by: B,
        };
        appendHandoffEvents([dupe], env.base);

        const db = openHandoffModel(env.dbPath);

        try {
            catchUpHandoffs(db, env.base);
            const h = getHandoffById(db, posted.handoff.id);
            expect(h?.title).toBe("original");
            expect(h?.editId).toBe(posted.editId);
        } finally {
            db.close();
        }
    });
});

describe("attachment resilience (§8.16b rebuild slice)", () => {
    test("deleted file folds with missing: true after rebuild; nothing crashes", () => {
        const env = freshEnv();
        const posted = postHandoff({ title: "T", tasks: [{ text: "one" }] }, env.depsFor(A));
        const shot = join(env.base, "..", "shot.png");
        writeFileSync(shot, new Uint8Array([1, 2, 3]));

        const res = executeHandoffActions(
            { id: posted.handoff.id, actions: [{ action: "attach_file", path: shot }] },
            env.depsFor(A)
        );
        const attachmentId = res.results[0].attachmentId;
        expect(attachmentId).toBeDefined();
        expect(res.handoff.attachments[0].missing).toBeUndefined();

        rmSync(attachmentFilePath(posted.handoff.id, attachmentId as string, "shot.png", env.base));

        const db = openHandoffModel(env.dbPath);

        try {
            rebuildHandoffModel(db, env.base);
            const h = getHandoffById(db, posted.handoff.id);
            expect(h?.attachments[0].missing).toBe(true);
        } finally {
            db.close();
        }
    });
});

describe("log layout", () => {
    test("events land in day-stamped jsonl under the handoff dir", () => {
        const env = freshEnv();
        postHandoff({ title: "T", tasks: [{ text: "one" }] }, env.depsFor(A));
        const files = readdirSync(handoffLogDir(env.base)).filter((f) => f.endsWith(".jsonl"));
        expect(files).toHaveLength(1);
        expect(files[0]).toMatch(/^\d{4}-\d{2}-\d{2}\.jsonl$/);
    });
});
