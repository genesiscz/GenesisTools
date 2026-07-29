import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureAskSession, parseSessionCitations, resolveSessionVideoIds } from "@app/youtube/lib/ask-session";
import { askSessionStore, toAskSessionRecord } from "@app/youtube/lib/ask-session-store";
import { YoutubeDatabase } from "@app/youtube/lib/db";
import { Youtube } from "@app/youtube/lib/youtube";
import { SafeJSON } from "@genesiscz/utils/json";

/**
 * The interop that matters: rows written by the pre-phase code path must read
 * through the shared store, and rows the store writes must read back through
 * youtube's own db methods. Both directions are checked here because the
 * session tables are shared, not migrated.
 */

let dir: string;
let db: YoutubeDatabase;
let yt: Youtube;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "gt-yt-session-"));
    db = new YoutubeDatabase(":memory:");
    yt = new Youtube({ baseDir: dir, db });
});

afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
});

describe("youtube ask sessions on the shared store", () => {
    test("a session written by the old db path reads back whole, citations included", async () => {
        const legacy = db.createAskSession({
            userId: 7,
            title: "probe",
            scopeKind: "channel",
            scopeValue: "@somechannel",
            videoIds: ["vid00000001", "vid00000002"],
            providerSpec: "anthropic/opus",
        });
        db.appendAskSessionMessage({ sessionId: legacy.id, role: "user", content: "q1" });
        db.appendAskSessionMessage({
            sessionId: legacy.id,
            role: "assistant",
            content: "a1",
            citationsJson: SafeJSON.stringify([{ videoId: "vid00000001", start: 12 }], { strict: true }),
        });

        const { session, created } = await ensureAskSession({
            yt,
            userId: 7,
            name: "probe",
            scope: { videoIds: ["ignored-because-it-exists"] },
        });

        expect(created).toBe(false);
        expect(session).toEqual(legacy);

        const store = askSessionStore(yt);
        const history = await store.history(String(legacy.id));
        expect(history.map((m) => `${m.role}:${m.content}`)).toEqual(["user:q1", "assistant:a1"]);
        expect(history[1].meta).toEqual({ citations: [{ videoId: "vid00000001", start: 12 }] });

        // The old reader still sees the same citations in the same column.
        const rows = db.listAskSessionMessages(legacy.id);
        expect(parseSessionCitations(rows[1])).toEqual([{ videoId: "vid00000001", start: 12 }]);
    });

    test("a session created through the store lands in youtube's own columns", async () => {
        const { session, created } = await ensureAskSession({
            yt,
            userId: 3,
            name: "fresh",
            scope: { videoIds: ["vid00000001"] },
            providerSpec: "openai/gpt-5",
        });

        expect(created).toBe(true);
        expect(session.scopeKind).toBe("videos");
        expect(session.videoIds).toEqual(["vid00000001"]);
        expect(session.providerSpec).toBe("openai/gpt-5");
        expect(session.collectionId).toBeNull();

        // Read back through the db layer that predates this phase.
        const fromDb = db.getAskSessionByTitle(3, "fresh");
        expect(fromDb).toEqual(session);
        expect(db.getAskSession(4, session.id)).toBeNull();
    });

    test("turns written through the store are visible to the old message reader", async () => {
        const { session } = await ensureAskSession({
            yt,
            userId: 7,
            name: "turns",
            scope: { videoIds: ["vid00000001"] },
        });
        const store = askSessionStore(yt);

        await store.turn(String(session.id), "q1", async () => ({
            text: "a1",
            meta: { citations: [{ videoId: "vid00000001" }] },
        }));
        await store.turn(String(session.id), "q2", async (history) => `history had ${history.length}`);

        const rows = db.listAskSessionMessages(session.id);
        expect(rows.map((m) => `${m.role}:${m.content}`)).toEqual([
            "user:q1",
            "assistant:a1",
            "user:q2",
            // 2, not 3: `turn` answers over the exchange BEFORE this one, so the
            // current question is not replayed to the responder as its own history.
            "assistant:history had 2",
        ]);
        expect(parseSessionCitations(rows[1])).toEqual([{ videoId: "vid00000001" }]);
        expect(rows[3].citationsJson).toBeNull();
    });

    test("a non-channel session keeps the id list it was created with", async () => {
        const { session } = await ensureAskSession({
            yt,
            userId: 7,
            name: "pinned",
            scope: { videoIds: ["vid00000001", "vid00000002"] },
        });

        expect(await resolveSessionVideoIds(yt, session)).toEqual(["vid00000001", "vid00000002"]);
    });

    test("toAskSessionRecord defaults a row whose meta lost its scope fields", () => {
        const record = toAskSessionRecord({
            id: "12",
            owner: "7",
            title: "bare",
            createdAt: Date.parse("2026-07-01T10:00:00.000Z"),
            updatedAt: Date.parse("2026-07-01T10:00:00.000Z"),
        });

        expect(record).toEqual({
            id: 12,
            userId: 7,
            collectionId: null,
            scopeKind: "collection",
            scopeValue: "",
            videoIds: [],
            providerSpec: null,
            title: "bare",
            createdAt: "2026-07-01T10:00:00.000Z",
            updatedAt: "2026-07-01T10:00:00.000Z",
        });
    });
});
