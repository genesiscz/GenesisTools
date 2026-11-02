import { describe, expect, test } from "bun:test";
import { Storage } from "@genesiscz/utils/storage/storage";
import { MeetingsConfigStore, matchProjects, meetingsConfigSchema, resolveDictionary } from "./config";
import { MeetingStore, nextId, titleSlug } from "./record";

let stores = 0;

/** Each test gets its own config file: a tool name of its own inside the sandboxed home. */
function store(): MeetingsConfigStore {
    stores += 1;
    return new MeetingsConfigStore(new Storage(`meetings-test-${stores}`));
}

describe("meetings config", () => {
    test("an empty file is every default, with autoRecord off", () => {
        const config = meetingsConfigSchema.parse({});

        expect(config.global.dictionary).toEqual({ entries: [] });
        expect(config.global.capture).toMatchObject({ activeFps: 1, idleFps: 0.1, retentionDays: 30 });
        expect(config.sources.wisprflow.autoRecord).toEqual({
            enabled: false,
            liveWithinSec: 30,
            stopAfterSilenceSec: 120,
            notify: true,
        });
        expect(config.projects).toEqual({});
    });

    test("a change that would break the config is refused and nothing is written", async () => {
        const config = store();
        await config.putDictionaryEntry({ kind: "global" }, { type: "fix", value: "UVČ", substitution: "UIčko" });

        await expect(
            config.putDictionaryEntry({ kind: "global" }, { type: "abbr", value: "MOO", substitution: "Moje Oddělení" })
        ).rejects.toThrow('the substitution must contain "MOO" itself');
        expect((await config.read()).global.dictionary.entries).toEqual([
            { type: "fix", value: "UVČ", substitution: "UIčko" },
        ]);
    });

    test("a project gets its dictionary and its expansion; the merged dictionary takes the project's", async () => {
        const config = store();
        expect(await config.addProject("work")).toBe(true);
        expect(await config.addProject("work")).toBe(false);
        await config.putDictionaryEntry(
            { kind: "project", project: "work" },
            {
                type: "abbr",
                value: "MOP",
                substitution: "MOP (Obchodní partner podnikatel)",
            }
        );
        const read = await config.setAbbrExpansion({ kind: "project", project: "work" }, "first");

        expect(resolveDictionary(read, { project: "work" }).abbrExpansion).toBe("first");
        expect(resolveDictionary(read).abbrExpansion).toBe("every");
        expect(
            resolveDictionary(read, { project: "work", meeting: { abbrExpansion: "off", entries: [] } }).abbrExpansion
        ).toBe("off");
    });

    test("projects match by Wispr folder, calendar name or a title word", () => {
        const config = meetingsConfigSchema.parse({
            projects: {
                work: { match: { wisprflow: { folders: ["Work"] }, calendar: { titles: ["Wiki"] } } },
                side: { match: { calendar: { calendars: ["Side"] } } },
                bare: {},
            },
        });

        expect(matchProjects(config, { wisprflowFolders: ["work"] })).toEqual(["work"]);
        expect(matchProjects(config, { title: "Změny ve wiki" })).toEqual(["work"]);
        expect(matchProjects(config, { calendar: "Side" })).toEqual(["side"]);
        expect(matchProjects(config, { title: "Lunch" })).toEqual([]);
    });
});

describe("meeting records", () => {
    function records(): MeetingStore {
        stores += 1;
        return new MeetingStore(new Storage(`meetings-test-${stores}`));
    }

    test("the id is the local start and a whole-word title slug; a second one gets -2", async () => {
        const store = records();
        const start = new Date(2026, 10, 2, 15, 0).toISOString();
        const first = await store.create(
            { title: "Změny ve wiki", start, createdBy: "new" },
            { command: "new", change: "x" }
        );
        const second = await store.create(
            { title: "Změny ve wiki", start, createdBy: "new" },
            { command: "new", change: "x" }
        );

        expect(first.id).toBe("2026-11-02_15-00-zmeny-ve-wiki");
        expect(second.id).toBe("2026-11-02_15-00-zmeny-ve-wiki-2");
        expect(titleSlug("Změny ve wiki a zadání - konzultace nad změnani")).toBe(
            "zmeny-ve-wiki-a-zadani-konzultace-nad"
        );
    });

    test("a meeting is found by id, prefix, last or source reference; an ambiguous prefix throws", async () => {
        const store = records();
        const older = await store.create(
            {
                title: "Planning",
                start: "2026-11-01T09:00:00.000Z",
                createdBy: "new",
                sources: { wisprflow: { meetingId: "1a2b3c4d-aaaa" } },
            },
            { command: "new", change: "x" }
        );
        const newer = await store.create(
            { title: "Planning", start: "2026-11-02T09:00:00.000Z", createdBy: "new" },
            { command: "new", change: "x" }
        );

        expect(store.resolve("last")?.id).toBe(newer.id);
        expect(store.resolve(older.id)?.id).toBe(older.id);
        expect(store.resolve("wisprflow:1a2b3c4d")?.id).toBe(older.id);
        expect(store.resolve("wisprflow:ffff")).toBeUndefined();
        expect(() => store.resolve("2026-11")).toThrow("fits 2 meetings");
    });

    test("an update appends one history line, and an invalid change writes nothing", async () => {
        const store = records();
        const record = await store.create(
            { title: "Review", start: "2026-11-02T09:00:00.000Z", createdBy: "new" },
            { command: "new", change: "created" }
        );
        await store.update(record.id, { command: "context add", change: "note" }, (current) => {
            current.context.push({
                id: nextId("c", current.context),
                kind: "note",
                ref: "Agreed",
                addedAt: "2026-11-02T10:00:00.000Z",
                addedBy: "user",
            });
        });

        await expect(
            store.update(record.id, { command: "set", change: "bad" }, (current) => {
                current.project = "not a name!";
            })
        ).rejects.toThrow();

        const read = store.read(record.id)!;
        expect(read.context.map((entry) => entry.id)).toEqual(["c1"]);
        expect(read.project).toBeUndefined();
        expect(read.history.map((entry) => entry.command)).toEqual(["new", "context add"]);
    });
});
