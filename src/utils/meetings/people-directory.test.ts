import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { Storage } from "@genesiscz/utils/storage/storage";
import { meetingsConfigSchema } from "./config";
import { PEOPLE_FILE, PeopleBook } from "./people-book";
import { ContactsPeopleSource, type ContactsReader } from "./people-contacts";
import { foldText, PeopleDirectory, PeopleError, type PeopleSource, peopleDirectory } from "./people-directory";
import { MEETING_FILE, MeetingStore } from "./record";

let stores = 0;

/** A scratch store under the test home with the given records, written as files. */
function scratch(records: Array<Record<string, unknown>>): { store: MeetingStore; book: PeopleBook } {
    stores += 1;
    const store = new MeetingStore(new Storage(`people-directory-${process.pid}-${stores}`));

    for (const record of records) {
        writeRecord(store, record);
    }

    return { store, book: new PeopleBook({ storage: store.storage, now: () => new Date("2026-11-09T12:00:00Z") }) };
}

function writeRecord(store: MeetingStore, record: Record<string, unknown>): void {
    const id = String(record.id);
    mkdirSync(store.folder(id), { recursive: true });
    writeFileSync(join(store.folder(id), MEETING_FILE), SafeJSON.stringify(record, null, 2));
}

function meeting(id: string, start: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return { id, title: id, start, createdAt: start, createdBy: "new", ...extra };
}

const config = meetingsConfigSchema.parse({
    projects: {
        Atlas: {
            match: { people: [{ name: "Ivo Example", pairedBy: [{ kind: "manual", at: "2026-11-01T00:00:00Z" }] }] },
        },
    },
});

function contacts(cards: Array<{ given: string; family: string; email?: string }>, authorized = true): ContactsReader {
    const all = cards.map((card) => ({
        given_name: card.given,
        family_name: card.family,
        organization_name: "",
        email_addresses: card.email ? [{ value: card.email }] : [],
    }));
    return {
        authorized: async () => ({ status: authorized ? "authorized" : "denied", authorized }),
        search: async (query) =>
            all.filter((card) => foldText(`${card.given_name} ${card.family_name}`).includes(foldText(query))),
        list: async (limit) => all.slice(0, limit),
    };
}

/** One meeting with each way a meeting names people, and two older meetings with people of their own. */
function rankedStore() {
    return scratch([
        meeting("m1", "2026-11-08T10:00:00Z", {
            participants: [{ name: "Casey Example" }],
            attendance: {
                from: "teams",
                people: [
                    { name: "Alex Example", fromSec: 0, toSec: 60 },
                    { name: "Blake Example", fromSec: 100, toSec: 200 },
                ],
            },
            calendar: { from: "apple-calendar", attendees: ["Drew Example"] },
        }),
        meeting("m0", "2026-11-01T10:00:00Z", { participants: [{ name: "Erin Example" }] }),
        meeting("m2", "2026-11-05T10:00:00Z", {
            participants: [{ name: "Erin Example" }, { name: "Finn Example" }],
        }),
    ]);
}

describe("PeopleDirectory.known", () => {
    test("ranks the people present at the moment, then the meeting's, then other meetings, Contacts, own entries", async () => {
        const { store, book } = rankedStore();
        await book.add({ name: "Hana Example" });
        const directory = peopleDirectory({
            store,
            config,
            book,
            contacts: new ContactsPeopleSource(contacts([{ given: "Gale", family: "Example" }])),
        });

        const known = await directory.known("", { meeting: "m1", atSec: 30, limit: 50 });

        expect(known.people.map((person) => [person.name, person.rank])).toEqual([
            ["Alex Example", "present"],
            ["Blake Example", "meeting"],
            ["Casey Example", "meeting"],
            ["Drew Example", "meeting"],
            ["Erin Example", "meetings"],
            ["Finn Example", "meetings"],
            ["Ivo Example", "meetings"],
            ["Gale Example", "contacts"],
            ["Hana Example", "own"],
        ]);
        expect(known.people.find((person) => person.name === "Erin Example")?.meetings).toBe(2);
        // Nothing is preselected: a person carries no choice of its own.
        expect(known.people.every((person) => !("selected" in person))).toBe(true);
        expect(known.sources.map((source) => [source.kind, source.state])).toEqual([
            ["meetings", "ok"],
            ["projects", "ok"],
            ["own", "ok"],
            ["contacts", "ok"],
        ]);
    });

    test("folds case and accents, NFC or NFD, and groups two spellings of one name as one person (Dana Exámple)", async () => {
        const { store, book } = scratch([
            meeting("m1", "2026-11-08T10:00:00Z", { participants: [{ name: "Dana Exámple" }] }),
            meeting("m2", "2026-11-09T10:00:00Z", { participants: [{ name: "Dana Example".normalize("NFD") }] }),
            meeting("m3", "2026-11-09T11:00:00Z", { participants: [{ name: "Dana Exámple".normalize("NFD") }] }),
        ]);
        const directory = peopleDirectory({ store, config: meetingsConfigSchema.parse({}), book });

        for (const query of ["exam", "EXAMPLE", "Exámple", "Exámple".normalize("NFD"), "dana ex"]) {
            const known = await directory.known(query);
            expect({ query, names: known.people.map((person) => person.name) }).toEqual({
                query,
                names: ["Dana Exámple"],
            });
        }

        const [dana] = (await directory.known("dana")).people;
        expect(dana?.meetings).toBe(3);
        expect(dana?.aliases).toEqual(["Dana Example"]);
    });

    test("a refused Contacts grant is a reason, never an empty list, and the other sources still answer", async () => {
        const { store, book } = rankedStore();
        const directory = peopleDirectory({
            store,
            config,
            book,
            contacts: new ContactsPeopleSource(contacts([{ given: "Gale", family: "Example" }], false)),
        });

        const known = await directory.known("example", { limit: 50 });
        const status = known.sources.find((source) => source.kind === "contacts");

        expect(status?.state).toBe("refused");
        expect(status?.reason).toContain("System Settings > Privacy & Security > Contacts");
        expect(known.people.map((person) => person.name)).toContain("Erin Example");
        expect(known.people.map((person) => person.name)).not.toContain("Gale Example");
    });

    test("the settings turn Contacts and the calendar attendees off", async () => {
        const { store, book } = rankedStore();
        const off = meetingsConfigSchema.parse({
            global: { people: { sources: { contacts: false, calendar: false } } },
        });
        const directory = peopleDirectory({
            store,
            config: off,
            book,
            contacts: new ContactsPeopleSource(contacts([{ given: "Gale", family: "Example" }])),
        });

        const known = await directory.known("", { limit: 50 });

        expect(known.people.map((person) => person.name)).not.toContain("Drew Example");
        expect(known.people.map((person) => person.name)).not.toContain("Gale Example");
        expect(known.sources.find((source) => source.kind === "contacts")).toEqual({
            kind: "contacts",
            state: "off",
            reason: "turned off (global.people.sources.contacts)",
        });
    });

    test("a changed meeting record is read again: the index follows the meetings folder", async () => {
        const { store, book } = scratch([
            meeting("m1", "2026-11-08T10:00:00Z", { participants: [{ name: "Kim Example" }] }),
        ]);
        const directory = peopleDirectory({ store, config: meetingsConfigSchema.parse({}), book });

        expect((await directory.known("")).people.map((person) => person.name)).toEqual(["Kim Example"]);

        writeRecord(
            store,
            meeting("m1", "2026-11-08T10:00:00Z", { participants: [{ name: "Kim Example" }, { name: "Lee Example" }] })
        );
        writeRecord(store, meeting("m2", "2026-11-09T10:00:00Z", { participants: [{ name: "Mo Example" }] }));

        expect((await directory.known("")).people.map((person) => person.name).sort()).toEqual([
            "Kim Example",
            "Lee Example",
            "Mo Example",
        ]);
    });

    test("a source that throws is failed with its message, and the rest still answer", async () => {
        const { store, book } = rankedStore();
        const broken: PeopleSource = {
            kind: "contacts",
            people: async () => {
                throw new Error("darwinkit is not running");
            },
        };
        const directory = new PeopleDirectory({ sources: [broken], book });

        const known = await directory.known("");

        expect(known.sources).toEqual([{ kind: "contacts", state: "failed", reason: "darwinkit is not running" }]);
        expect(known.people).toEqual([]);
        expect(store.list()).toHaveLength(3);
    });
});

describe("the people book and its merges", () => {
    test("a merge names the meetings and renamed labels it links, shows one person, and its token undoes it", async () => {
        const { store, book } = scratch([
            meeting("m1", "2026-11-08T10:00:00Z", {
                participants: [{ name: "Nora Example" }],
                speakers: { labels: { "Speaker 2": "Nora Example" } },
            }),
            meeting("m2", "2026-11-09T10:00:00Z", { participants: [{ name: "N. Example" }, { name: "Nora Example" }] }),
        ]);
        const directory = peopleDirectory({ store, config: meetingsConfigSchema.parse({}), book });
        const records = readFileSync(store.path("m1"), "utf8");

        const plan = await directory.planMerge("Nora Example", "N. Example");

        expect(plan.name).toBe("Nora Example");
        expect(plan.meetings.map((one) => [one.id, one.people])).toEqual([
            ["m2", [0, 1]],
            ["m1", [0]],
        ]);
        expect(plan.labels).toEqual([{ meeting: "m1", label: "Speaker 2", name: "Nora Example" }]);
        expect(existsSync(book.path)).toBe(false);

        const { merge } = await directory.merge("Nora Example", "N. Example");
        const merged = (await directory.known("example")).people;

        expect(merged.map((person) => [person.name, person.merge, person.aliases])).toEqual([
            ["Nora Example", merge.token, ["N. Example"]],
        ]);
        // No meeting record changes.
        expect(readFileSync(store.path("m1"), "utf8")).toBe(records);

        await directory.unmerge(merge.token);
        expect((await directory.known("example")).people.map((person) => person.name).sort()).toEqual([
            "N. Example",
            "Nora Example",
        ]);
        await expect(directory.unmerge(merge.token)).rejects.toMatchObject({ code: "unknown-merge" });
    });

    test("add, hide and show again; an unknown or shared name is refused with its code", async () => {
        const { store, book } = scratch([
            meeting("m1", "2026-11-08T10:00:00Z", {
                calendar: {
                    from: "apple-calendar",
                    attendees: [],
                    people: [
                        { name: "Pat Example", email: "pat@example.com" },
                        { name: "Pat Example", email: "pat.e@example.org" },
                    ],
                },
            }),
        ]);
        const directory = peopleDirectory({ store, config: meetingsConfigSchema.parse({}), book });

        const added = await directory.add({ name: "Quinn Example", note: "from the board" });
        expect([added.added, added.person.name, added.person.rank, added.person.note]).toEqual([
            true,
            "Quinn Example",
            "own",
            "from the board",
        ]);
        expect((await directory.add({ name: "quinn example", email: "quinn@example.com" })).added).toBe(false);
        expect((await directory.find("quinn@example.com")).name).toBe("Quinn Example");

        expect((await directory.hide("Quinn Example")).changed).toBe(true);
        expect((await directory.known("quinn")).people).toEqual([]);
        expect((await directory.known("quinn", { includeHidden: true })).people[0]?.hidden).toBe(true);
        expect((await directory.hide("Quinn Example", false)).changed).toBe(true);
        expect((await directory.known("quinn")).people).toHaveLength(1);

        await expect(directory.find("Nobody Example")).rejects.toMatchObject({ code: "unknown-person" });
        const shared = await directory.find("Pat Example").catch((error: unknown) => error);
        expect(shared).toBeInstanceOf(PeopleError);
        expect(shared).toMatchObject({ code: "ambiguous-person" });
        expect((shared as PeopleError).candidates.map((one) => one.email).sort()).toEqual([
            "pat.e@example.org",
            "pat@example.com",
        ]);
        expect((await directory.find("email:pat@example.com")).email).toBe("pat@example.com");
    });

    test("a torn book reads empty and its next write moves it aside; a value of a newer build survives a write", async () => {
        const { book } = scratch([]);
        mkdirSync(join(book.path, ".."), { recursive: true });
        writeFileSync(book.path, '{ "version": 1, "entries": [{ "name": "Rae Exa');

        expect(book.read().entries).toEqual([]);

        await book.add({ name: "Sam Example" });
        const folder = join(book.path, "..");
        expect(readdirSync(folder).filter((name) => name.startsWith(`${PEOPLE_FILE}.broken-`))).toHaveLength(1);
        expect(book.read().entries.map((entry) => entry.name)).toEqual(["Sam Example"]);

        const newer = {
            version: 2,
            future: { on: true },
            entries: [{ kind: "group", members: [] }],
            merges: [],
            hidden: [],
        };
        writeFileSync(book.path, SafeJSON.stringify(newer));
        await book.add({ name: "Tia Example" });
        const written = SafeJSON.parse(readFileSync(book.path, "utf8"), { strict: true });

        expect(written).toMatchObject({ version: 2, future: { on: true } });
        expect(written).toHaveProperty("entries", [
            { name: "Tia Example", addedAt: "2026-11-09T12:00:00.000Z" },
            { kind: "group", members: [] },
        ]);
    });
});
