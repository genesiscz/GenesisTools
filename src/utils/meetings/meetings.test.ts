import { describe, expect, test } from "bun:test";
import { Storage } from "@genesiscz/utils/storage/storage";
import { MeetingsConfigStore, matchProjects, meetingsConfigSchema, resolveDictionary } from "./config";

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
