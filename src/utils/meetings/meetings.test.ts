import { describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { DEFAULT_OCR_TILE_PX } from "@genesiscz/utils/macos/ocr";
import { FILLER_WORDS } from "@genesiscz/utils/recording-editor/transcript-cuts";
import * as atomicFile from "@genesiscz/utils/storage/atomic-file";
import { Storage } from "@genesiscz/utils/storage/storage";
import { z } from "zod";
import {
    fillerListsOf,
    languageSettings,
    listenPads,
    MEETINGS_CONFIG_VERSION,
    MeetingsConfigStore,
    matchProjects,
    meetingsConfigSchema,
    migrateMeetingsConfig,
    recorderSettings,
    resolveDictionary,
    sourceFolders,
    TONE_PRESETS,
} from "./config";
import { collectEcho, correlateEcho, echoForRange, readEchoCache } from "./echo";
import { calibrateChannels, channelEnergy, micShare } from "./energy";
import { MEETING_UNCHANGED, MeetingStore, meetingRecordSchema, nextId, titleSlug } from "./record";
import { readVoiceSamples, saveVoiceSample, scoreVoice } from "./voice";

let stores = 0;

/** Each test gets its own config file: a tool name of its own inside the sandboxed home. */
function store(): MeetingsConfigStore {
    stores += 1;
    return new MeetingsConfigStore(new Storage(`meetings-test-${stores}`));
}

describe("meetings config", () => {
    test("reading legacy settings migrates in memory without rewriting the config file", async () => {
        const config = store();
        mkdirSync(dirname(config.path), { recursive: true });
        const original =
            '{ "version": 5, "global": { "playback": { "listen": { "repeat": false, "repeatGapSec": 2.5 } } } }\n';
        writeFileSync(config.path, original);
        const before = fs.statSync(config.path).mtimeMs;
        const read = await new MeetingsConfigStore(config.storage).read();
        expect(read.version).toBe(MEETINGS_CONFIG_VERSION);
        expect(read.global.playback.listen.repeat).toEqual({ enabled: false, gapSec: 2.5 });
        expect(fs.readFileSync(config.path, "utf8")).toBe(original);
        expect(fs.statSync(config.path).mtimeMs).toBe(before);
        await config.update((raw) => {
            raw.futureKey = { keep: true };
        });
        const reopened = await config.storage.getConfig();
        expect(reopened).toMatchObject({
            version: MEETINGS_CONFIG_VERSION,
            global: { playback: { listen: { repeat: false, repeatGapSec: 2.5 } } },
            futureKey: { keep: true },
        });
    });
    test("invalid legacy migration preserves the original bytes", async () => {
        const config = store();
        mkdirSync(dirname(config.path), { recursive: true });
        const original = '{"version":1,"global":{"playback":{"listen":{"budget":-1}}}}\n';
        writeFileSync(config.path, original);
        await expect(config.read()).rejects.toThrow();
        expect(fs.readFileSync(config.path, "utf8")).toBe(original);
    });

    test("tone fallback defaults to beep and an explicit strict choice survives reopening", async () => {
        const config = store();
        expect((await config.read()).global.playback.listen.tone.onMissing).toBe("beep");
        await config.update((value) => {
            value.global = { playback: { listen: { tone: { onMissing: "error" } } } };
        });
        const reopened = new MeetingsConfigStore(new Storage(`meetings-test-${stores}`));
        expect((await reopened.read()).global.playback.listen.tone.onMissing).toBe("error");
    });

    test("an empty file is every default, with autoRecord off", () => {
        const config = meetingsConfigSchema.parse({});

        expect(config.global.dictionary).toEqual({ entries: [] });
        expect(config.global.capture).toMatchObject({ activeFps: 1, idleFps: 0.1, retentionDays: 30 });
        expect(config.sources.wisprflow.autoRecord).toEqual({
            enabled: false,
            liveWithinSec: 30,
            notify: true,
        });
        expect(config.projects).toEqual({});
        expect(config.global.playback.listen.roundCap).toBe(12);
        expect(config.global.suggest.questionCap).toBe(12);
        expect(languageSettings(config).ocr).toEqual(["cs-CZ", "en-US"]);
        expect(languageSettings(config, "sk").render.readAloudLabel).toBe("číta z");
        expect(recorderSettings(config.global.capture)).toEqual({ audio: { sources: [] } });
    });

    test("capture.ocr: an old file gains the tile default; explicit read choices are kept", () => {
        const old = meetingsConfigSchema.parse({ version: 3, global: { capture: { threshold: 0.05 } } });
        expect(old.global.capture.threshold).toBe(0.05);
        expect(old.global.capture.ocr).toEqual({
            threshold: 0,
            skipTextless: false,
            region: "frame",
            read: "tiles",
            tilePx: DEFAULT_OCR_TILE_PX,
        });

        const set = meetingsConfigSchema.parse({
            global: { capture: { ocr: { threshold: 0.1, skipTextless: true, region: "changed" } } },
        });
        expect(set.global.capture.ocr).toEqual({
            threshold: 0.1,
            skipTextless: true,
            region: "changed",
            read: "tiles",
            tilePx: DEFAULT_OCR_TILE_PX,
        });
        expect(
            meetingsConfigSchema.parse({ global: { capture: { ocr: { read: "tiles" } } } }).global.capture.ocr.read
        ).toBe("tiles");
        expect(
            meetingsConfigSchema.parse({ global: { capture: { ocr: { read: "frame" } } } }).global.capture.ocr.read
        ).toBe("frame");
        expect(() => meetingsConfigSchema.parse({ global: { capture: { ocr: { read: true } } } })).toThrow();
        expect(() => meetingsConfigSchema.parse({ global: { capture: { ocr: { region: "crop" } } } })).toThrow();
    });

    const shipped = (code: string) => ({
        sounds: [...FILLER_WORDS[code].sounds],
        words: [...FILLER_WORDS[code].words],
    });

    test("fillers per language: an old file without the key keeps the shipped lists, a changed one replaces its own language", () => {
        const old = meetingsConfigSchema.parse({ version: 3, languages: { cs: { ocr: ["cs-CZ"] } } });
        expect(languageSettings(old, "cs").fillers).toEqual(shipped("cs"));
        expect(languageSettings(old, "sk").fillers).toEqual(shipped("sk"));
        expect(fillerListsOf(old.languages)).toEqual(FILLER_WORDS);

        const changed = meetingsConfigSchema.parse({
            languages: {
                cs: { fillers: { sounds: ["ehm", "ach"] } },
                de: {
                    ocr: ["de-DE"],
                    render: { unclearLabel: "unklar", readAloudLabel: "liest aus", lineLabel: "Z." },
                    fillers: { sounds: ["äh"], words: ["also"] },
                },
            },
        });
        const lists = fillerListsOf(changed.languages);

        expect(lists.cs).toEqual({ sounds: ["ehm", "ach"], words: [...FILLER_WORDS.cs.words] });
        expect(lists.de).toEqual({ sounds: ["äh"], words: ["also"] });
        expect(lists.sk).toEqual(FILLER_WORDS.sk);
        expect(lists.en).toEqual(FILLER_WORDS.en);

        const withoutKey = meetingsConfigSchema.parse({
            languages: {
                en: {
                    ocr: ["en-US"],
                    render: { unclearLabel: "unclear", readAloudLabel: "reads from", lineLabel: "l." },
                },
            },
        });
        expect(fillerListsOf(withoutKey.languages).en).toEqual(FILLER_WORDS.en);
        expect(withoutKey.languages.en.fillers).toEqual(shipped("en"));

        const oneLevel = meetingsConfigSchema.parse({
            languages: {
                en: {
                    ocr: ["en-US"],
                    render: { unclearLabel: "unclear", readAloudLabel: "reads from", lineLabel: "l." },
                    fillers: { sounds: ["um"] },
                },
                de: {
                    ocr: ["de-DE"],
                    render: { unclearLabel: "unklar", readAloudLabel: "liest aus", lineLabel: "Z." },
                    fillers: { sounds: ["äh"] },
                },
            },
        });
        expect(oneLevel.languages.en.fillers).toEqual({ sounds: ["um"], words: [...FILLER_WORDS.en.words] });
        expect(oneLevel.languages.de.fillers).toEqual({ sounds: ["äh"], words: [] });
    });

    test("an empty file has the three assign timings of today, and a changed one is read", () => {
        const defaults = meetingsConfigSchema.parse({}).global.assign;
        expect(defaults).toMatchObject({ calendarLookbehindHours: 3, folderWaitDays: 14, retryFailedMin: 10 });

        const changed = meetingsConfigSchema.parse({
            global: { assign: { calendarLookbehindHours: 6, folderWaitDays: 30, retryFailedMin: 20 } },
        }).global.assign;
        expect(changed).toMatchObject({ calendarLookbehindHours: 6, folderWaitDays: 30, retryFailedMin: 20 });
        expect(() => meetingsConfigSchema.parse({ global: { assign: { folderWaitDays: 0 } } })).toThrow();
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
                playback: { listen: { padBeforeSec: 2, padAfterSec: 2, roundCap: 7 } },
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
            version: MEETINGS_CONFIG_VERSION,
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
        expect(config.global.assign).toEqual({
            ask: true,
            lookbackHours: 48,
            maxProposals: 5,
            calendarSlackMin: 15,
            calendarLookbehindHours: 3,
            folderWaitDays: 14,
            retryFailedMin: 10,
        });
        expect(matchProjects(config, { title: "Side quest" })).toEqual(["side"]);
        expect(meetingsConfigSchema.parse({ version: 99, future: { key: 1 } }).version).toBe(99);
    });

    test("pairing receipts and Undo preserve existing and later independent sources on disk", async () => {
        const config = store();
        const existing = { name: "Alice Example", email: "alice@example.com" };
        const fresh = { name: "Bob Example", email: "bob@example.com" };
        const first = { kind: "manual" as const, at: "2026-11-04T10:00:00.000Z", note: "first" };
        const added = { kind: "calendar" as const, from: "calendar", entryId: "new", at: "2026-11-04T11:00:00.000Z" };
        const later = { kind: "calendar" as const, from: "calendar", entryId: "later", at: "2026-11-04T12:00:00.000Z" };
        await config.addProject("work");
        await config.pairPeople({ project: "work", people: [existing], by: first });
        const receipt = await config.pairUnpairedPeople({
            project: "work",
            people: [
                { person: existing, by: added },
                { person: fresh, by: added },
                { person: { name: "Owner", self: true }, by: added },
            ],
        });
        expect(receipt).toEqual([{ ...fresh, by: added }]);
        await config.pairPeople({ project: "work", people: [fresh], by: later });
        expect(await config.unpairSource("work", fresh, added)).toEqual([{ ...fresh, left: false }]);
        expect(await config.unpairSource("work", fresh, added)).toEqual([]);
        const reopened = new MeetingsConfigStore(config.storage);
        expect((await reopened.read()).projects.work?.match?.people).toEqual([
            { ...existing, pairedBy: [first] },
            { ...fresh, pairedBy: [later] },
        ]);
        const changed = { ...added, title: "Changed after pairing" };
        await config.pairPeople({ project: "work", people: [fresh], by: changed });
        await expect(config.unpairSource("work", fresh, added)).rejects.toThrow("changed after it was added");
        expect((await reopened.read()).projects.work?.match?.people[1]?.pairedBy).toEqual([later, changed]);
    });

    test("concurrent first-time pairings return one committed receipt", async () => {
        const config = store();
        await config.addProject("work");
        const person = { name: "Alice Example" };
        const receipts = await Promise.all(
            ["first", "second"].map((note) =>
                config.pairUnpairedPeople({
                    project: "work",
                    people: [{ person, by: { kind: "manual", note, at: "2026-11-04T10:00:00.000Z" } }],
                })
            )
        );
        expect(receipts.flat()).toHaveLength(1);
        const reopened = new MeetingsConfigStore(config.storage);
        const saved = (await reopened.read()).projects.work?.match?.people;
        expect(saved).toHaveLength(1);
        expect(saved?.[0]?.pairedBy).toEqual([receipts.flat()[0]?.by]);
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

    test("saved repeat settings still parse in an older build after migration and edits", async () => {
        const config = store();
        const legacyListen = z.object({
            repeat: z.boolean().default(true),
            repeatGapSec: z.number().min(0).max(10).default(1),
        });
        const legacyConfig = z.object({ global: z.object({ playback: z.object({ listen: legacyListen }) }) });
        await config.storage.setConfig({
            version: 6,
            global: { playback: { listen: { repeat: { enabled: false, gapSec: 2.5 } } } },
            futureKey: { keep: true },
        });
        const original = fs.readFileSync(config.path, "utf8");
        expect((await config.read()).global.playback.listen.repeat).toEqual({ enabled: false, gapSec: 2.5 });
        expect(fs.readFileSync(config.path, "utf8")).toBe(original);
        await config.setListenPads({ beforeSec: 3, afterSec: 4 });
        const saved = await config.storage.getConfig();
        expect(legacyConfig.parse(saved).global.playback.listen).toEqual({ repeat: false, repeatGapSec: 2.5 });
        const bytes = fs.readFileSync(config.path, "utf8");
        await new MeetingsConfigStore(config.storage).read();
        expect(fs.readFileSync(config.path, "utf8")).toBe(bytes);
        await config.update((raw) => {
            raw.global = { playback: { listen: { repeat: { enabled: true, gapSec: 0.5 } } } };
        });
        const edited = await config.storage.getConfig();
        expect(legacyConfig.parse(edited).global.playback.listen).toEqual({ repeat: true, repeatGapSec: 0.5 });
        expect(edited).toHaveProperty("futureKey.keep", true);
        expect((await new MeetingsConfigStore(config.storage).read()).global.playback.listen.repeat).toEqual({
            enabled: true,
            gapSec: 0.5,
        });
    });

    test("version 7 preserves repeat and its gap in the API and the older saved shape", async () => {
        const config = store();
        await config.storage.setConfig({
            version: 5,
            global: { playback: { listen: { repeat: false, repeatGapSec: 2.5 } } },
        });
        const read = await config.read();
        expect(read.global.playback.listen.repeat).toEqual({ enabled: false, gapSec: 2.5 });
        expect(await config.storage.getConfig()).toMatchObject({ version: 5 });
        await config.setListenPads({ beforeSec: 3, afterSec: 4 });
        const reopened = await config.storage.getConfig();
        expect(reopened).toMatchObject({
            version: MEETINGS_CONFIG_VERSION,
            global: { playback: { listen: { repeat: false, repeatGapSec: 2.5 } } },
        });
        const nested = meetingsConfigSchema.parse({
            version: 5,
            global: { playback: { listen: { repeat: { enabled: true, gapSec: 3 }, repeatGapSec: 9 } } },
        });
        expect(nested.global.playback.listen.repeat).toEqual({ enabled: true, gapSec: 3 });
    });

    test("a version 3 file nests the tone under listen.tone, and a key already there wins", async () => {
        const v3 = { version: 3, global: { playback: { listen: { beep: false, beepLeadSec: 0.8, repeat: false } } } };
        const raw: Record<string, unknown> = structuredClone(v3);

        expect(migrateMeetingsConfig(raw)).toBe(true);
        expect(raw).toEqual({
            version: MEETINGS_CONFIG_VERSION,
            global: { playback: { listen: { tone: { enabled: false, leadSec: 0.8 }, repeat: false } } },
        });
        expect(migrateMeetingsConfig(raw)).toBe(false);
        expect(meetingsConfigSchema.parse(v3).global.playback.listen.tone).toEqual({
            enabled: false,
            leadSec: 0.8,
            sound: { hz: 880, sec: 0.15, volume: 0.6 },
            onMissing: "beep",
        });

        const both = { version: 3, global: { playback: { listen: { beep: false, tone: { enabled: true } } } } };
        expect(meetingsConfigSchema.parse(both).global.playback.listen.tone.enabled).toBe(true);

        const config = store();
        await config.storage.setConfig(v3);
        expect((await config.read()).global.playback.listen.tone.leadSec).toBe(0.8);
        expect(await config.storage.getConfig()).toEqual(v3);
        await config.update(() => {});
        expect(await config.storage.getConfig()).toEqual({
            version: MEETINGS_CONFIG_VERSION,
            global: { playback: { listen: { tone: { enabled: false, leadSec: 0.8 }, repeat: false } } },
        });
    });

    test("a version 1 file stays unchanged on read and an explicit edit saves the new shape", async () => {
        const config = store();
        await config.storage.setConfig({ version: 1, global: { playback: { listen: { budget: 5 } } } });

        expect((await config.read()).global.playback.listen.roundCap).toBe(5);
        expect(await config.storage.getConfig()).toEqual({
            version: 1,
            global: { playback: { listen: { budget: 5 } } },
        });
        await config.setListenPads({ beforeSec: 3, afterSec: 4 });
        expect(await config.storage.getConfig()).toEqual({
            version: MEETINGS_CONFIG_VERSION,
            global: {
                playback: { listen: { padBeforeSec: 3, padAfterSec: 4, roundCap: 5 } },
                suggest: { questionCap: 5 },
            },
        });
    });

    test("a version 4 file splits listen.padSec into padBeforeSec and padAfterSec, and a key already there wins", async () => {
        const v4 = { version: 4, global: { playback: { listen: { padSec: 7, tone: { sound: { hz: 440 } } } } } };
        const raw: Record<string, unknown> = structuredClone(v4);

        expect(migrateMeetingsConfig(raw)).toBe(true);
        expect(raw).toEqual({
            version: MEETINGS_CONFIG_VERSION,
            global: { playback: { listen: { padBeforeSec: 7, padAfterSec: 7, tone: { sound: { hz: 440 } } } } },
        });
        expect(migrateMeetingsConfig(raw)).toBe(false);
        // The version 4 sine reads as it is.
        expect(meetingsConfigSchema.parse(v4).global.playback.listen.tone.sound).toEqual({
            hz: 440,
            sec: 0.15,
            volume: 0.6,
        });

        const both = { version: 4, global: { playback: { listen: { padSec: 7, padAfterSec: 2 } } } };
        expect(listenPads(meetingsConfigSchema.parse(both).global.playback.listen)).toEqual({
            beforeSec: 7,
            afterSec: 2,
        });

        const config = store();
        await config.storage.setConfig(v4);
        expect(listenPads((await config.read()).global.playback.listen)).toEqual({ beforeSec: 7, afterSec: 7 });
        expect(await config.storage.getConfig()).toEqual(v4);
        await config.update(() => {});
        expect(await config.storage.getConfig()).toEqual({
            version: MEETINGS_CONFIG_VERSION,
            global: { playback: { listen: { padBeforeSec: 7, padAfterSec: 7, tone: { sound: { hz: 440 } } } } },
        });
    });

    test("the pads: none saved until the first listen, one side set stands for both", () => {
        const listen = (settings: Record<string, unknown>) =>
            meetingsConfigSchema.parse({ version: 5, global: { playback: { listen: settings } } }).global.playback
                .listen;

        expect(listenPads(listen({}))).toBeUndefined();
        expect(listenPads(listen({ padAfterSec: 4 }))).toEqual({ beforeSec: 4, afterSec: 4 });
        expect(listenPads(listen({ padBeforeSec: 1, padAfterSec: 9 }))).toEqual({ beforeSec: 1, afterSec: 9 });
        expect(() => listen({ padBeforeSec: 61 })).toThrow();
    });

    test("the tone's sound is a sine, a preset or a sound file; each reads with its volume", () => {
        const sound = (value: unknown) =>
            meetingsConfigSchema.parse({ version: 5, global: { playback: { listen: { tone: { sound: value } } } } })
                .global.playback.listen.tone.sound;

        expect(sound(undefined)).toEqual({ hz: 880, sec: 0.15, volume: 0.6 });
        // A preset without a volume plays at its own (resolveToneSound reads TONE_PRESETS).
        expect(sound({ preset: "tink" })).toEqual({ preset: "tink" });
        expect(sound({ preset: "soft", volume: 0.1 })).toEqual({ preset: "soft", volume: 0.1 });
        expect(() => sound({ file: "sounds/chime.wav" })).toThrow("absolute path");
        expect(sound({ file: "/sounds/chime.wav", volume: 0.2 })).toEqual({ file: "/sounds/chime.wav", volume: 0.2 });
        expect(sound({ hz: 440, sec: 0.2 })).toEqual({ hz: 440, sec: 0.2, volume: 0.6 });
        // A misspelt preset names the presets, not an unknown key.
        expect(() => sound({ preset: "gong" })).toThrow("with a preset of beep, soft, click, tink");
        expect(() => sound({ hz: 440, sec: 3 })).toThrow();
        expect(Object.keys(TONE_PRESETS).slice(0, 3)).toEqual(["beep", "soft", "click"]);
        // The sines are the Meetings window's presets (SidePanelSections.swift TonePreset).
        expect(TONE_PRESETS.soft).toMatchObject({ volume: 0.35, sound: { hz: 523, sec: 0.3 } });
        expect(TONE_PRESETS.click).toMatchObject({ volume: 0.7, sound: { hz: 2000, sec: 0.03 } });
    });

    test("tone files accept POSIX, Windows drive and UNC absolute paths without rewriting them", () => {
        for (const file of [
            "/sounds/chime.wav",
            "C:\\Sounds\\chime.wav",
            "D:/Sounds/chime.wav",
            "\\\\fileserver\\sounds\\chime.wav",
        ]) {
            const config = meetingsConfigSchema.parse({
                global: { playback: { listen: { tone: { sound: { file } } } } },
            });
            expect(config.global.playback.listen.tone.sound).toEqual({ file, volume: 0.6 });
        }
        for (const file of ["sounds/chime.wav", "sounds\\chime.wav", "C:chime.wav", ".\\chime.wav"]) {
            expect(() =>
                meetingsConfigSchema.parse({ global: { playback: { listen: { tone: { sound: { file } } } } } })
            ).toThrow("absolute path");
        }
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
        await expect(
            config.putDictionaryEntry({ kind: "global" }, { type: "abbr", value: "MOO", substitution: "Moje Oddělení" })
        ).rejects.toThrow("The change would make the meetings config invalid, so nothing was written");
        expect((await config.read()).global.dictionary.entries).toEqual([
            { type: "fix", value: "UVČ", substitution: "UIčko" },
        ]);
    });

    test("a renamed dictionary entry replaces the old one in one write, and a refused one keeps the old", async () => {
        const config = store();
        const scope = { kind: "project", project: "work" } as const;
        await config.addProject("work");
        await config.putDictionaryEntries(scope, [
            { type: "fix", value: "Viky", substitution: "wiki" },
            { type: "abbr", value: "NWD", substitution: "NWD (Northwind)" },
        ]);

        await expect(
            config.replaceDictionaryEntry(scope, "NWD", { type: "abbr", value: "MOP", substitution: "MOPsuffix" })
        ).rejects.toThrow('the substitution must contain "MOP" itself');
        expect((await config.read()).projects.work?.dictionary?.entries.map((entry) => entry.value)).toEqual([
            "Viky",
            "NWD",
        ]);

        const read = await config.replaceDictionaryEntry(scope, "NWD", {
            type: "abbr",
            value: "HBR",
            substitution: "HBR (Harbor)",
        });
        expect(read.projects.work?.dictionary?.entries).toEqual([
            { type: "fix", value: "Viky", substitution: "wiki" },
            { type: "abbr", value: "HBR", substitution: "HBR (Harbor)" },
        ]);
    });

    test("an Undo's restore puts the entry back only while nobody made it again in that level", async () => {
        const config = store();
        const scope = { kind: "project", project: "work" } as const;
        await config.addProject("work");

        await config.putDictionaryEntry(
            scope,
            { type: "fix", value: "Viky", substitution: "wiki" },
            { ifAbsent: true }
        );
        await expect(
            config.putDictionaryEntry(scope, { type: "fix", value: "Viky", substitution: "Wiki" }, { ifAbsent: true })
        ).rejects.toMatchObject({ code: "dictionary-exists" });
        const read = await config.read();
        expect(read.projects.work?.dictionary?.entries).toEqual([{ type: "fix", value: "Viky", substitution: "wiki" }]);
        expect(read.global.dictionary.entries).toEqual([]);
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
    test("preserved source-audio metadata survives creation, reopening and unrelated edits", async () => {
        stores += 1;
        const store = new MeetingStore(new Storage(`meetings-source-audio-${stores}`));
        const audio = {
            sources: {
                wisprflow: {
                    sourceMeetingId: "source-one",
                    path: "/private/fixture/source-audio/one.ogg",
                    sha256: "a".repeat(64),
                    bytes: 18,
                    savedAt: "2026-11-13T00:00:00.000Z",
                },
            },
        };
        const fields = {
            title: "Planning",
            start: "2026-11-12T14:00:00.000Z",
            createdBy: "new" as const,
            sources: { wisprflow: { meetingId: "source-one" } },
            audio,
        };
        const created = await store.create(fields, { command: "test", change: "preserved audio" });
        const reopened = new MeetingStore(store.storage);
        expect(reopened.read(created.id)).toHaveProperty("audio", audio);
        expect(SafeJSON.parse(fs.readFileSync(store.path(created.id), "utf8"))).toHaveProperty("audio", audio);
        await reopened.update(created.id, { command: "test", change: "rename" }, (record) => {
            record.title = "Planning again";
        });
        expect(new MeetingStore(store.storage).read(created.id)).toHaveProperty("audio", audio);
        expect(new MeetingStore(store.storage).read(created.id)?.sources).toEqual(fields.sources);
    });

    test("preserved source-audio metadata validates its source identity, digest and size", () => {
        const base = {
            id: "fixture",
            title: "Planning",
            start: "2026-11-12T14:00:00.000Z",
            createdAt: "2026-11-12T14:00:00.000Z",
            createdBy: "new",
        };
        expect(meetingRecordSchema.parse(base)).not.toHaveProperty("audio");
        const held = {
            sourceMeetingId: "source-one",
            path: "/private/fixture/source-audio/one.ogg",
            sha256: "a".repeat(64),
            bytes: 18,
            savedAt: "2026-11-13T00:00:00.000Z",
        };
        for (const invalid of [{ sha256: "not-a-digest" }, { bytes: -1 }, { sourceMeetingId: "" }]) {
            expect(
                meetingRecordSchema.safeParse({ ...base, audio: { sources: { wisprflow: { ...held, ...invalid } } } })
                    .success
            ).toBe(false);
        }
    });

    test("creation publishes its record only after companion files are prepared", async () => {
        const meetings = records();
        const order: string[] = [];
        let folder = "";
        const created = await meetings.createWithFiles({
            fields: { title: "Planning", start: "2026-11-05T11:00:00.000Z", createdBy: "new" },
            change: { command: "test", change: "prepared creation" },
            beside: {
                write(record) {
                    folder = meetings.folder(record.id);
                    expect(new MeetingStore(meetings.storage).read(record.id)).toBeUndefined();
                    expect(new MeetingStore(meetings.storage).list()).toEqual([]);
                    writeFileSync(join(folder, "capture.txt"), "prepared bytes");
                    order.push("files");
                },
                undo() {
                    throw new Error("A successful create must not roll back");
                },
                saved(record) {
                    expect(new MeetingStore(meetings.storage).read(record.id)?.title).toBe("Planning");
                    order.push("published");
                },
            },
        });
        expect(order).toEqual(["files", "published"]);
        expect(fs.readFileSync(join(folder, "capture.txt"), "utf8")).toBe("prepared bytes");
        expect(new MeetingStore(meetings.storage).read(created.id)?.history).toEqual(created.history);
        expect(created.history).toHaveLength(1);
        expect(created.history[0]?.change).toBe("prepared creation");
    });

    test("a speaker renamed back to its own label loses the rename", async () => {
        const meetings = new MeetingStore(new Storage(`meetings-rename-${process.pid}`));
        const created = await meetings.create(
            { title: "Harbor sync", start: "2026-11-05T11:00:00.000Z", createdBy: "new" },
            { command: "test", change: "fixture" }
        );

        await meetings.renameSpeaker(created.id, "S1", "Alice Example");
        expect(meetings.read(created.id)?.speakers.labels).toEqual({ S1: "Alice Example" });
        const reset = await meetings.renameSpeaker(created.id, "S1", " S1 ");
        expect(reset.speakers.labels).toEqual({});
    });

    function records(): MeetingStore {
        stores += 1;
        return new MeetingStore(new Storage(`meetings-test-${stores}`));
    }

    test("a saved edit makes legacy interrupted spans readable by older builds", async () => {
        const store = records();
        const created = await store.create(
            { title: "Recovered recorder", start: "2026-11-05T11:00:00.000Z", createdBy: "new" },
            { command: "test", change: "fixture" }
        );
        const span = { from: created.start, to: created.start, stopReason: "interrupted" };
        fs.writeFileSync(
            store.path(created.id),
            SafeJSON.stringify({
                ...created,
                recording: {
                    stopReason: "interrupted",
                    spans: [span],
                    displaySpans: [{ ...span, displayId: 1 }],
                },
            })
        );
        await store.update(created.id, { command: "set", change: "title" }, (record) => {
            record.title = "Recovered meeting";
        });
        const legacyReason = z.enum(["requested", "paused", "failed", "error"]);
        const legacy = z.object({
            recording: z.object({
                stopReason: legacyReason,
                spans: z.array(z.object({ stopReason: legacyReason })),
                displaySpans: z.array(z.object({ stopReason: legacyReason, displayId: z.number() })),
            }),
        });
        expect(legacy.parse(SafeJSON.parse(fs.readFileSync(store.path(created.id), "utf8"))).recording).toEqual({
            stopReason: "error",
            spans: [{ stopReason: "error" }],
            displaySpans: [{ stopReason: "error", displayId: 1 }],
        });
        const saved = new MeetingStore(store.storage).read(created.id)!;
        expect(saved.recording?.interrupted).toBe(true);
        expect(saved.recording?.spans?.[0]).toMatchObject({ stopReason: "error", interrupted: true });
        expect(saved.recording?.displaySpans?.[0]).toMatchObject({ stopReason: "error", interrupted: true });
    });

    test("future recording stop reasons stay readable and survive a saved edit", async () => {
        const store = records();
        const created = await store.create(
            { title: "Future recorder", start: "2026-11-05T11:00:00.000Z", createdBy: "new" },
            { command: "test", change: "fixture" }
        );
        const recording = {
            stopReason: "future-stop",
            spans: [
                { from: created.start, to: created.start, stopReason: "future-span", futureDetail: { keep: true } },
            ],
        };
        fs.writeFileSync(store.path(created.id), SafeJSON.stringify({ ...created, recording }));
        expect(new MeetingStore(store.storage).read(created.id)?.recording).toMatchObject(recording);
        await store.update(created.id, { command: "set", change: "title" }, (record) => {
            record.title = "Edited future recorder";
        });
        expect(new MeetingStore(store.storage).read(created.id)?.recording).toMatchObject(recording);
    });

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

    test("resolve reads an exact id alone, and lists the store for anything else", async () => {
        const store = records();
        const created = await store.create(
            { title: "Planning", start: "2026-11-01T09:00:00.000Z", createdBy: "new" },
            { command: "new", change: "x" }
        );
        const listed = spyOn(store, "listBounded");

        expect(store.resolve(created.id)?.id).toBe(created.id);
        expect(listed).not.toHaveBeenCalled();
        expect(store.resolve(created.id.slice(0, 10))?.id).toBe(created.id);
        expect(store.resolve(`../${basename(store.root)}/${created.id}`)).toBeUndefined();
        expect(listed).toHaveBeenCalledTimes(2);
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

    test("only MEETING_UNCHANGED skips a change: a mutate whose expression is false still saves", async () => {
        const store = records();
        const record = await store.create(
            {
                title: "Review",
                start: "2026-11-02T09:00:00.000Z",
                createdBy: "new",
                participants: [{ name: "Dana Example", self: true, from: ["user"] }],
            },
            { command: "new", change: "created" }
        );

        // An arrow body that is an assignment returns the assigned value: `false` here, which is no answer.
        await store.update(
            record.id,
            { command: "set", change: "not me" },
            (current) => (current.participants[0]!.self = false)
        );
        expect(store.read(record.id)?.participants[0]?.self).toBe(false);

        const unchanged = await store.update(record.id, { command: "set", change: "nothing" }, () => MEETING_UNCHANGED);
        expect(unchanged.history.map((entry) => entry.command)).toEqual(["new", "set"]);
        expect(store.read(record.id)?.history.map((entry) => entry.command)).toEqual(["new", "set"]);
    });

    test("files beside a record are taken back when the record is not saved, and written after it when it is", async () => {
        const store = records();
        const record = await store.create(
            { title: "Review", start: "2026-11-02T09:00:00.000Z", createdBy: "new" },
            { command: "new", change: "created" }
        );
        const calls: string[] = [];
        const beside = {
            write: () => calls.push("write"),
            undo: () => calls.push("undo"),
            saved: () => calls.push("saved"),
        };
        const write = spyOn(atomicFile, "atomicWriteFileSync").mockImplementationOnce(() => {
            throw new Error("ENOSPC: no space left on device");
        });

        try {
            await expect(
                store.update(
                    record.id,
                    { command: "set", change: "labels" },
                    (current) => {
                        current.labels = ["demo"];
                    },
                    beside
                )
            ).rejects.toThrow("ENOSPC");
            expect(calls).toEqual(["write", "undo"]);
            expect(store.read(record.id)?.labels).toEqual([]);

            calls.length = 0;
            await store.update(
                record.id,
                { command: "set", change: "labels" },
                (current) => {
                    current.labels = ["demo"];
                },
                beside
            );
            expect(calls).toEqual(["write", "saved"]);
            expect(store.read(record.id)?.labels).toEqual(["demo"]);
        } finally {
            write.mockRestore();
        }
    });

    test("a decision a newer build wrote, with an actor kind and an action this build does not know, still loads", async () => {
        const store = records();
        const record = await store.create(
            { title: "Review", start: "2026-11-02T09:00:00.000Z", createdBy: "new" },
            { command: "new", change: "created" }
        );
        const raw = SafeJSON.parse(fs.readFileSync(store.path(record.id), "utf8"), { strict: true });
        raw.items = [
            {
                id: "i1",
                kind: "term",
                heard: "dana",
                proposed: "Dana",
                status: "confirmed",
                suggestedAt: "2026-11-02T09:10:00.000Z",
                decidedAt: "2026-11-02T09:20:00.000Z",
                decision: {
                    token: "t-future",
                    previous: { status: "suggested" },
                    actor: { kind: "person", name: "Dana Example" },
                    entry: { action: "regroup", reason: "her voice" },
                },
            },
        ];
        writeFileSync(store.path(record.id), SafeJSON.stringify(raw, null, 2));

        const decision = store.read(record.id)?.items[0]?.decision;
        expect(decision?.actor).toEqual({ kind: "unknown" });
        expect(decision?.entry).toEqual({ action: "unknown", reason: "her voice" });
        expect(decision?.token).toBe("t-future");
    });
});

describe("calibrateChannels", () => {
    // 30 mic segments (2 s each) then 30 call segments, 10 blocks per second.
    const segments = Array.from({ length: 60 }, (_, index) => ({
        startSec: index * 2,
        endSec: index * 2 + 2,
        channel: index < 30 ? "mic" : "system",
    }));
    const energyOf = (micSide: "left" | "right" | "both", bleed = 5) => {
        const left = new Float32Array(1200);
        const right = new Float32Array(1200);

        for (let block = 0; block < 1200; block += 1) {
            const mic = block < 600;
            const loudLeft = micSide === "both" || (micSide === "left") === mic;
            const loudRight = micSide === "both" || (micSide === "right") === mic;
            left[block] = loudLeft ? 500 : mic ? 5 : bleed;
            right[block] = loudRight ? 500 : mic ? 5 : bleed;
        }

        return { left, right };
    };

    test("the side the tagged microphone segments are loud on is the microphone", () => {
        expect(calibrateChannels(energyOf("left"), segments).layout).toBe("left-mic");
        expect(calibrateChannels(energyOf("right"), segments).layout).toBe("right-mic");
        expect(micShare(energyOf("right"), "right-mic", 0, 2)).toBeCloseTo(0.99, 2);
    });

    test("a microphone that hears the call through loudspeakers still names its side; one that hears it as loud does not", () => {
        // The call at a third of its loudness on the microphone's side: the call segments' left share is 0.25.
        expect(calibrateChannels(energyOf("left", 167), segments)).toMatchObject({
            layout: "left-mic",
            systemMedian: 0.25,
        });
        expect(calibrateChannels(energyOf("right", 167), segments).layout).toBe("right-mic");
        expect(calibrateChannels(energyOf("left", 400), segments).layout).toBe("unknown");
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

test("meeting allocation retries when another process reserves the selected directory", async () => {
    const store = new MeetingStore(new Storage("meeting-allocation-race"));
    const mkdir = fs.mkdirSync;
    let collided = false;
    const spy = spyOn(fs, "mkdirSync").mockImplementation((target, options) => {
        if (!collided && String(target).startsWith(`${store.root}/`)) {
            collided = true;
            mkdir(target, { recursive: true });
            writeFileSync(join(String(target), "meeting.json"), "other-process-record");
        }

        return mkdir(target, options);
    });

    try {
        const record = await store.create(
            { title: "Race", start: "2026-11-02T15:00:00Z", createdBy: "new" },
            { command: "test", change: "fixture" }
        );
        expect(collided).toBe(true);
        expect(record.id.endsWith("-2")).toBe(true);
        expect(fs.readFileSync(store.path(record.id.slice(0, -2)), "utf8")).toBe("other-process-record");
    } finally {
        spy.mockRestore();
    }
});

test("bounded meeting discovery skips old JSON and applies limits before read", () => {
    const records = new MeetingStore(new Storage(`bounded-meetings-${++stores}`));
    for (const id of ["2026-01-01_10-00-old", "2026-11-03_10-00-margin", "2026-11-05_10-00-new", "undated"]) {
        mkdirSync(records.folder(id), { recursive: true });
        writeFileSync(records.path(id), "{}");
    }
    const read = spyOn(records, "read").mockReturnValue(undefined);
    try {
        const result = records.listBounded({ since: new Date("2026-11-04T00:00:00Z") });
        expect(result.olderMeetings).toBe(1);
        expect(read.mock.calls.map(([id]) => id).sort()).toEqual([
            "2026-11-03_10-00-margin",
            "2026-11-05_10-00-new",
            "undated",
        ]);
        read.mockClear();
        records.listBounded({ limit: 0 });
        expect(read).not.toHaveBeenCalled();
    } finally {
        read.mockRestore();
    }
});
test("a positive discovery limit parses only that many recent records", async () => {
    const records = new MeetingStore(new Storage(`bounded-positive-${++stores}`));
    for (const day of [1, 2, 3]) {
        await records.create(
            { title: "Planning", start: `2026-11-0${day}T09:00:00.000Z`, createdBy: "new" },
            { command: "new", change: "fixture" }
        );
    }
    const read = spyOn(records, "read");
    try {
        const result = records.listBounded({ limit: 1 });
        expect(read).toHaveBeenCalledTimes(1);
        expect(result.records.map((record) => record.start)).toEqual(["2026-11-03T09:00:00.000Z"]);
    } finally {
        read.mockRestore();
    }
});

describe("isolated playback echo and speaker enrolment", () => {
    function noise(n: number, seed: number): Float32Array {
        let state = seed;
        return Float32Array.from({ length: n }, () => {
            state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
            return (state / 4294967296 - 0.5) * 0.5;
        });
    }
    test("recovers a delayed call and preserves independent near-end speech", () => {
        const call = noise(4000, 11),
            local = noise(4000, 72);
        const echo = Float32Array.from(call, (_, i) => (call[i - 84] ?? 0) * 0.7);
        const measured = correlateEcho({ mic: echo, call, rate: 2000 });
        expect(measured.echoOfCall).toBeGreaterThan(0.99);
        expect(measured.lagMs).toBe(42);
        const captureOffset = correlateEcho({
            mic: Float32Array.from(call, (_, i) => (call[i + 84] ?? 0) * 0.7),
            call,
            rate: 2000,
        });
        expect(captureOffset.lagMs).toBe(-42);
        expect(captureOffset.echoOfCall).toBeGreaterThan(0.99);
        expect(measured.cleanMicShare).toBeLessThan(0.01);
        const mixed = correlateEcho({ mic: Float32Array.from(echo, (n, i) => n + local[i]!), call, rate: 2000 });
        expect(mixed.cleanMicRms).toBeGreaterThan(measured.cleanMicRms + 0.05);
        expect(correlateEcho({ mic: local, call, rate: 2000 }).echoOfCall).toBeLessThan(0.03);
        expect(
            correlateEcho({ mic: new Float32Array(4000), call: new Float32Array(4000), rate: 2000 }).cleanMicShare
        ).toBeUndefined();
    });
    test("reopens a collected echo cache and rejects changed audio provenance", async () => {
        const root = mkdtempSync(join(tmpdir(), "echo-contract-"));
        const input = join(root, "stereo.wav"),
            cachePath = join(root, "echo.json");
        const call = noise(4000, 11),
            pcm = Buffer.alloc(4000 * 4),
            wav = Buffer.alloc(44);
        wav.write("RIFF");
        wav.writeUInt32LE(36 + pcm.length, 4);
        wav.write("WAVEfmt ", 8);
        wav.writeUInt32LE(16, 16);
        wav.writeUInt16LE(1, 20);
        wav.writeUInt16LE(2, 22);
        wav.writeUInt32LE(2000, 24);
        wav.writeUInt32LE(8000, 28);
        wav.writeUInt16LE(4, 32);
        wav.writeUInt16LE(16, 34);
        wav.write("data", 36);
        wav.writeUInt32LE(pcm.length, 40);
        for (let i = 0; i < call.length; i++) {
            pcm.writeInt16LE(Math.round((call[i - 84] ?? 0) * 0.7 * 32767), i * 4);
            pcm.writeInt16LE(Math.round(call[i]! * 32767), i * 4 + 2);
        }
        writeFileSync(input, Buffer.concat([wav, pcm]));
        const before = fs.readFileSync(input);
        await collectEcho({ audioPath: input, cachePath, layout: "left-mic" });
        const reopened = await readEchoCache({ audioPath: input, cachePath, layout: "left-mic" });
        expect(echoForRange(reopened!, 0, 2)?.echoOfCall).toBeGreaterThan(0.99);
        expect(fs.readFileSync(input)).toEqual(before);
        expect(await readEchoCache({ audioPath: input, cachePath, layout: "right-mic" })).toBeUndefined();
        fs.utimesSync(input, new Date(), new Date(Date.now() + 3000));
        expect(await readEchoCache({ audioPath: input, cachePath, layout: "left-mic" })).toBeUndefined();
    });
    test("reopens confirmed enrolments and keeps ambiguous or incompatible voices unknown", () => {
        const file = join(mkdtempSync(join(tmpdir(), "voice-contract-")), "voices.json");
        saveVoiceSample(file, {
            person: "Alice",
            model: "fixture:v1",
            source: "fixture",
            channel: 1,
            fromSec: 1,
            toSec: 5,
            embedding: [1, 0],
            confirmed: true,
        });
        const reopened = readVoiceSamples(file);
        expect(reopened[0]?.confirmed).toBe(true);
        expect(scoreVoice({ model: "fixture:v1", embedding: [1, 0], samples: reopened }).person).toBe("Alice");
        expect(scoreVoice({ model: "fixture:v2", embedding: [1, 0], samples: reopened }).quality).toBe("unknown");
        expect(scoreVoice({ model: "fixture:v1", embedding: [0, 0], samples: reopened }).quality).toBe("unknown");
        expect(
            scoreVoice({
                model: "fixture:v1",
                embedding: [1, 0],
                samples: [...reopened, { ...reopened[0]!, person: "Bob" }],
            }).quality
        ).toBe("unknown");
    });
});

test("project person details are additive and survive a reopened config without inventing legacy roles", async () => {
    const config = store();
    await config.pairPeople({
        project: "shop",
        people: [{ name: "Alice" }],
        by: { kind: "manual", at: "2026-01-01T00:00:00Z", note: "a note is not a role" },
    });
    const before = await new MeetingsConfigStore(config.storage).read();
    expect(before.projects.shop?.match?.people[0]?.role).toBeUndefined();
    await config.setPersonDetails({ project: "shop", name: "Alice", role: "Engineer", aliases: ["Al"] });
    const read = await new MeetingsConfigStore(config.storage).read();
    expect(read.projects.shop?.match?.people[0]).toMatchObject({ name: "Alice", role: "Engineer", aliases: ["Al"] });
    const bytes = fs.readFileSync(config.path, "utf8");
    await new MeetingsConfigStore(config.storage).read();
    expect(fs.readFileSync(config.path, "utf8")).toBe(bytes);
});
