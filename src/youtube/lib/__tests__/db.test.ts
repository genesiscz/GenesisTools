import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { YoutubeDatabase } from "@app/youtube/lib/db";

let db: YoutubeDatabase;

beforeEach(() => {
    db = new YoutubeDatabase(":memory:");
});

afterEach(() => {
    db.close();
});

describe("YoutubeDatabase schema", () => {
    it("creates all tables on first open", () => {
        const tables = db
            .getDb()
            .query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
            .all() as Array<{ name: string }>;
        const names = tables.map((table) => table.name);

        expect(names).toContain("channels");
        expect(names).toContain("videos");
        expect(names).toContain("transcripts");
        expect(names).toContain("jobs");
        expect(names).toContain("qa_chunks");
        expect(names).toContain("schema_version");
    });

    it("creates the FTS5 virtual table and triggers", () => {
        const tables = db
            .getDb()
            .query("SELECT name FROM sqlite_master WHERE name='transcripts_fts'")
            .all() as Array<{ name: string }>;
        const triggers = db
            .getDb()
            .query("SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name")
            .all() as Array<{ name: string }>;
        const triggerNames = triggers.map((trigger) => trigger.name);

        expect(tables.length).toBe(1);
        expect(triggerNames).toContain("transcripts_ai");
        expect(triggerNames).toContain("transcripts_ad");
        expect(triggerNames).toContain("transcripts_au");
    });

    it("records schema version 1 once", () => {
        const rows = db.getDb().query("SELECT * FROM schema_version").all() as Array<{ version: number }>;

        expect(rows.length).toBe(1);
        expect(rows[0].version).toBe(1);
    });

    it("is idempotent when initSchema is called again", () => {
        db.initSchemaForTest();
        const rows = db.getDb().query("SELECT * FROM schema_version").all() as Array<{ version: number }>;

        expect(rows.length).toBe(1);
        expect(rows[0].version).toBe(1);
    });
});

describe("YoutubeDatabase channels", () => {
    it("upserts and gets a channel", () => {
        db.upsertChannel({
            handle: "@mkbhd",
            channelId: "UCBJycsmduvYEL83R_U4JriQ",
            title: "Marques Brownlee",
            description: null,
            subscriberCount: 19_000_000,
            thumbUrl: null,
        });
        const channel = db.getChannel("@mkbhd");

        expect(channel?.title).toBe("Marques Brownlee");
        expect(channel?.subscriberCount).toBe(19_000_000);
    });

    it("lists channels in alphabetical order", () => {
        db.upsertChannel({ handle: "@b", title: "B" });
        db.upsertChannel({ handle: "@a", title: "A" });
        const list = db.listChannels();

        expect(list.map((channel) => channel.handle)).toEqual(["@a", "@b"]);
    });

    it("removes a channel", () => {
        db.upsertChannel({ handle: "@x", title: "X" });
        db.removeChannel("@x");

        expect(db.getChannel("@x")).toBeNull();
    });

    it("sets last synced timestamp", () => {
        db.upsertChannel({ handle: "@sync", title: "Sync" });
        db.setChannelSynced("@sync");
        const channel = db.getChannel("@sync");

        expect(channel?.lastSyncedAt).toBeString();
    });
});
