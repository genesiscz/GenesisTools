import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { Storage } from "@genesiscz/utils/storage/storage";
import {
    languageSettings,
    MEETINGS_CONFIG_VERSION,
    MeetingsConfigStore,
    matchProjects,
    meetingsConfigSchema,
    migrateMeetingsConfig,
    recorderSettings,
    resolveDictionary,
    sourceFolders,
} from "./config";
import { calibrateChannels, channelEnergy, micShare } from "./energy";
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
        expect(config.global.playback.listen.roundCap).toBe(12);
        expect(config.global.suggest.questionCap).toBe(12);
        expect(languageSettings(config).ocr).toEqual(["cs-CZ", "en-US"]);
        expect(languageSettings(config, "sk").render.readAloudLabel).toBe("číta z");
        expect(recorderSettings(config.global.capture)).toEqual({ audio: { sources: [] } });
    });

    test("a version 1 file moves each key to its axis, and the old places still read", () => {
        const v1 = {
            version: 1,
            global: {
                render: { unclearLabel: "unclear" },
                playback: { listen: { budget: 7, padSec: 2 } },
                capture: { retentionDays: 9 },
            },
            projects: { work: { match: { wisprflow: { folders: ["Work"] }, calendar: { titles: ["Wiki"] } } } },
        };
        const raw: Record<string, unknown> = structuredClone(v1);

        expect(migrateMeetingsConfig(raw)).toBe(true);
        expect(raw).toEqual({
            version: MEETINGS_CONFIG_VERSION,
            global: {
                playback: { listen: { padSec: 2, roundCap: 7 } },
                suggest: { questionCap: 7 },
                capture: { retentionDays: 9 },
            },
            projects: { work: { match: { title: { words: ["Wiki"] } } } },
            languages: { cs: { render: { unclearLabel: "unclear" } } },
            sources: { wisprflow: { match: { work: { folders: ["Work"] } } } },
        });
        expect(migrateMeetingsConfig(raw)).toBe(false);

        const config = meetingsConfigSchema.parse(v1);
        expect(languageSettings(config).render).toEqual({
            unclearLabel: "unclear",
            readAloudLabel: "čte z",
            lineLabel: "ř.",
        });
        expect(config.global.suggest.questionCap).toBe(7);
        expect(sourceFolders(config, "work")).toEqual([{ source: "wisprflow", folder: "Work" }]);
    });

    test("a version 2 file moves calendar.titles to title.words; a current file round-trips; a newer one reads", () => {
        const v2 = {
            version: 2,
            projects: {
                work: {
                    match: { calendar: { calendars: ["Work"], titles: ["Wiki", "Sync"] }, title: { words: ["Sync"] } },
                },
                side: { match: { calendar: { titles: ["Side"] } } },
            },
        };
        const raw: Record<string, unknown> = structuredClone(v2);

        expect(migrateMeetingsConfig(raw)).toBe(true);
        expect(raw).toEqual({
            version: 3,
            projects: {
                work: { match: { calendar: { calendars: ["Work"] }, title: { words: ["Sync", "Wiki"] } } },
                side: { match: { title: { words: ["Side"] } } },
            },
        });

        const again = structuredClone(raw);
        expect(migrateMeetingsConfig(again)).toBe(false);
        expect(again).toEqual(raw);

        const config = meetingsConfigSchema.parse(v2);
        expect(config.projects.work?.match?.title?.words).toEqual(["Sync", "Wiki"]);
        expect(config.projects.work?.labels).toEqual([]);
        expect(config.projects.work?.match?.people).toEqual([]);
        expect(config.global.assign).toEqual({ ask: true, lookbackHours: 48, maxProposals: 5, calendarSlackMin: 15 });
        expect(matchProjects(config, { title: "Side quest" })).toEqual(["side"]);
        expect(meetingsConfigSchema.parse({ version: 4, future: { key: 1 } }).version).toBe(4);
    });

    test("labels and people pairings: many projects per person, unpairing an entry keeps other sources", async () => {
        const config = store();
        const entry = (entryId: string) => ({
            kind: "calendar" as const,
            from: "wisprflow",
            entryId,
            title: "Planning",
            at: "2026-11-04T10:00:00.000Z",
        });
        const alice = { name: "Alice Novak", email: "alice@example.com" };
        const bob = { name: "Bob Smith" };

        expect(await config.setProjectLabels("work", { add: ["Offers 2.0", "offers 2.0", "Wiki"] })).toEqual([
            "Offers 2.0",
            "Wiki",
        ]);
        expect(await config.setProjectLabels("work", { remove: ["wiki"] })).toEqual(["Offers 2.0"]);

        await config.pairPeople({ project: "work", people: [alice, bob, { name: "Me", self: true }], by: entry("e1") });
        await config.pairPeople({ project: "work", people: [{ name: "alice.novak" }], by: entry("e2") });
        await config.pairPeople({ project: "side", people: [alice], by: entry("e1") });
        await config.pairPeople({
            project: "side",
            people: [bob],
            by: { kind: "manual", at: "2026-11-04T11:00:00.000Z" },
        });
        let read = await config.read();

        expect(read.projects.work?.match?.people.map((person) => [person.name, person.pairedBy.length])).toEqual([
            ["Alice Novak", 2],
            ["Bob Smith", 1],
        ]);
        expect(read.projects.side?.match?.people.map((person) => person.name)).toEqual(["Alice Novak", "Bob Smith"]);

        const removed = await config.unpairEntry("e1");
        read = await config.read();

        expect(removed).toEqual([
            { project: "work", name: "Alice Novak", email: "alice@example.com", left: false },
            { project: "work", name: "Bob Smith", left: true },
            { project: "side", name: "Alice Novak", email: "alice@example.com", left: true },
        ]);
        expect(read.projects.work?.match?.people.map((person) => person.name)).toEqual(["Alice Novak"]);
        expect(read.projects.side?.match?.people.map((person) => person.name)).toEqual(["Bob Smith"]);
        expect(await config.unpairPerson("side", { name: "Smith Bob" })).toBe(true);
        expect(await config.addSourceFolder("wisprflow", "work", "Work")).toBe(true);
        expect(await config.addSourceFolder("wisprflow", "work", "work")).toBe(false);
        expect(sourceFolders(await config.read(), "work")).toEqual([{ source: "wisprflow", folder: "Work" }]);
    });

    test("a version 1 file on disk is rewritten once, and a later change keeps the new shape", async () => {
        const config = store();
        await config.storage.setConfig({ version: 1, global: { playback: { listen: { budget: 5 } } } });

        expect((await config.read()).global.playback.listen.roundCap).toBe(5);
        expect(await config.storage.getConfig()).toEqual({
            version: MEETINGS_CONFIG_VERSION,
            global: { playback: { listen: { roundCap: 5 } }, suggest: { questionCap: 5 } },
        });
        await config.setListenPad(3);
        expect(await config.storage.getConfig()).toMatchObject({
            global: { playback: { listen: { padSec: 3, roundCap: 5 } } },
        });
    });

    test("a meeting language needs its block in languages", () => {
        expect(() => meetingsConfigSchema.parse({ version: 2, global: { language: "de" } })).toThrow(
            "no block languages.de"
        );
        const config = meetingsConfigSchema.parse({
            version: 2,
            global: { language: "de" },
            languages: {
                de: {
                    ocr: ["de-DE"],
                    render: { unclearLabel: "unklar", readAloudLabel: "liest aus", lineLabel: "Z." },
                },
            },
        });
        expect(languageSettings(config).render.lineLabel).toBe("Z.");
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

    test("projects match by a source's folder, calendar name or a title word", () => {
        const config = meetingsConfigSchema.parse({
            projects: {
                work: { match: { wisprflow: { folders: ["Work"] }, title: { words: ["Wiki"] } } },
                side: { match: { calendar: { calendars: ["Side"] } } },
                bare: {},
            },
        });

        expect(matchProjects(config, { source: { id: "wisprflow", folders: ["work"] } })).toEqual(["work"]);
        expect(matchProjects(config, { title: "Změny ve wiki" })).toEqual(["work"]);
        expect(matchProjects(config, { calendar: "Side" })).toEqual(["side"]);
        expect(matchProjects(config, { title: "Lunch" })).toEqual([]);
    });
});

describe("a GENESIS_TOOLS_HOME one level too deep", () => {
    test("no meeting says where the records are and what to set", async () => {
        const home = join(mkdtempSync(join(tmpdir(), "gt-layout-")), ".genesis-tools");
        mkdirSync(join(home, "meetings", "2026-11-02_15-00-planning"), { recursive: true });
        writeFileSync(join(home, "meetings", "2026-11-02_15-00-planning", "meeting.json"), "{}");

        await env.testing.withOverrides({ GENESIS_TOOLS_HOME: home }, () => {
            const records = new MeetingStore();

            expect(records.layoutHint()).toContain(`set it to ${dirname(home)}`);
            expect(() => records.resolve("last-week")).toThrow(`the records are in ${join(home, "meetings")}`);
        });
    });

    test("the usual layout gives no hint", () => {
        expect(new MeetingStore().layoutHint()).toBeUndefined();
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

describe("calibrateChannels", () => {
    // 30 mic segments (2 s each) then 30 call segments, 10 blocks per second.
    const segments = Array.from({ length: 60 }, (_, index) => ({
        startSec: index * 2,
        endSec: index * 2 + 2,
        channel: index < 30 ? "mic" : "system",
    }));
    const energyOf = (micSide: "left" | "right" | "both") => {
        const left = new Float32Array(1200);
        const right = new Float32Array(1200);

        for (let block = 0; block < 1200; block += 1) {
            const mic = block < 600;
            const loudLeft = micSide === "both" || (micSide === "left") === mic;
            const loudRight = micSide === "both" || (micSide === "right") === mic;
            left[block] = loudLeft ? 500 : 5;
            right[block] = loudRight ? 500 : 5;
        }

        return { left, right };
    };

    test("the side the tagged microphone segments are loud on is the microphone", () => {
        expect(calibrateChannels(energyOf("left"), segments).layout).toBe("left-mic");
        expect(calibrateChannels(energyOf("right"), segments).layout).toBe("right-mic");
        expect(micShare(energyOf("right"), "right-mic", 0, 2)).toBeCloseTo(0.99, 2);
    });

    test("a mono recording, or too few tagged segments, leaves the layout unknown and the share out", () => {
        const mono = calibrateChannels(energyOf("both"), segments);
        expect(mono).toMatchObject({ layout: "unknown", micMedian: 0.5, systemMedian: 0.5 });
        expect(mono.reason).toContain("do not separate");
        expect(calibrateChannels(energyOf("left"), segments.slice(0, 40))).toMatchObject({
            layout: "unknown",
            segments: { mic: 30, system: 10 },
        });
        expect(micShare(energyOf("left"), "unknown", 0, 2)).toBeUndefined();
    });
});

test.skipIf(!Bun.which("ffmpeg"))("concurrent energy builders publish complete stereo caches", async () => {
    const dir = new Storage("energy-concurrent-test").getBaseDir();
    mkdirSync(dir, { recursive: true });
    const audio = join(dir, "stereo.wav");
    const samples = 4000;
    const wav = Buffer.alloc(44 + samples * 4);
    wav.write("RIFF", 0);
    wav.writeUInt32LE(wav.length - 8, 4);
    wav.write("WAVEfmt ", 8);
    wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20);
    wav.writeUInt16LE(2, 22);
    wav.writeUInt32LE(2000, 24);
    wav.writeUInt32LE(8000, 28);
    wav.writeUInt16LE(4, 32);
    wav.writeUInt16LE(16, 34);
    wav.write("data", 36);
    wav.writeUInt32LE(samples * 4, 40);
    for (let i = 0; i < samples; i += 1) {
        wav.writeInt16LE(1000, 44 + i * 4);
        wav.writeInt16LE(100, 46 + i * 4);
    }
    writeFileSync(audio, wav);
    const cache = join(dir, "energy.bin");
    const results = await Promise.all([channelEnergy(audio, cache), channelEnergy(audio, cache)]);
    for (const energy of results) {
        expect(energy?.left.length).toBe(20);
        expect(energy?.left[0]).toBeCloseTo(1000, 0);
        expect(energy?.right[0]).toBeCloseTo(100, 0);
    }
    expect(await channelEnergy(audio, cache)).toEqual(results[0]);
    expect(readdirSync(dir).sort()).toEqual(["energy.bin", "stereo.wav"]);
});
