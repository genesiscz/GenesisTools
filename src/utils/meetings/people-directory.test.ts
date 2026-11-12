import { describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import * as darwinkit from "@genesiscz/utils/macos/darwinkit";
import { Storage } from "@genesiscz/utils/storage/storage";
import { meetingsConfigSchema } from "./config";
import { PEOPLE_FILE, PeopleBook } from "./people-book";
import { ContactsPeopleSource, type ContactsReader, darwinkitContacts } from "./people-contacts";
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
    test("a person's history includes every appearance in date order", async () => {
        const { store, book } = rankedStore();
        const directory = peopleDirectory({ store, config, book });
        const history = await directory.meetings("Erin Example");
        expect(history.person.name).toBe("Erin Example");
        expect(history.meetings.map((appearance) => appearance.meeting)).toEqual(["m2", "m0"]);
        expect(history.meetings.every((appearance) => appearance.as.includes("participant"))).toBe(true);
        const reopened = peopleDirectory({ store: new MeetingStore(store.storage), config, book });
        expect(await reopened.meetings(history.person.id)).toEqual(history);
        await expect(directory.meetings("Nobody Else")).rejects.toMatchObject({ code: "unknown-person" });
    });

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

    test("an equal-size rewrite with the same modification time refreshes the people index", async () => {
        const { store, book } = scratch([
            meeting("m1", "2026-11-08T10:00:00Z", { participants: [{ name: "Kim Example" }] }),
        ]);
        const recordPath = store.path("m1");
        const fixedTime = new Date("2026-11-08T10:00:00Z");
        utimesSync(recordPath, fixedTime, fixedTime);
        const size = statSync(recordPath).size;
        const directory = peopleDirectory({ store, config: meetingsConfigSchema.parse({}), book });
        expect((await directory.known("")).people.map((person) => person.name)).toEqual(["Kim Example"]);
        writeRecord(store, meeting("m1", "2026-11-08T10:00:00Z", { participants: [{ name: "Lee Example" }] }));
        utimesSync(recordPath, fixedTime, fixedTime);
        expect(statSync(recordPath).size).toBe(size);
        expect((await directory.known("")).people.map((person) => person.name)).toEqual(["Lee Example"]);
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
        const shownAgain = await directory.hide("Quinn Example", false);
        expect([shownAgain.changed, shownAgain.person.hidden]).toEqual([true, undefined]);
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

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

function nativeContacts(
    options: {
        authorized?: boolean;
        onAuthorization?: () => Promise<{ authorized: boolean; status: string }>;
        onFetch?: () => Promise<void>;
        onClose?: () => Promise<void>;
    } = {}
) {
    const calls: string[] = [];
    const card = { given_name: "Alex", family_name: "Example", organization_name: "", email_addresses: [] };
    const fetch = async (kind: string, timeout: number) => {
        calls.push(kind);
        expect(timeout).toBe(30_000);
        await options.onFetch?.();
        return { contacts: [card] };
    };
    const client = {
        contacts: {
            authorized: async ({ timeout }: { timeout: number }) => {
                calls.push("authorized");
                expect(timeout).toBe(30_000);
                return (
                    options.onAuthorization?.() ?? {
                        authorized: options.authorized ?? true,
                        status: options.authorized === false ? "denied" : "authorized",
                    }
                );
            },
            list: async (_query: { limit: number }, { timeout }: { timeout: number }) => fetch("list", timeout),
            search: async (_query: { query: string; limit: number }, { timeout }: { timeout: number }) =>
                fetch("search", timeout),
        },
        close: async () => {
            calls.push("close");
            await options.onClose?.();
        },
    };
    return { client, calls };
}

describe("Contacts native generations", () => {
    test("a refused grant recovers on the next query without replacing the source", async () => {
        let allowed = false;
        let created = 0;
        let closed = 0;
        const source = new ContactsPeopleSource(
            darwinkitContacts({
                createClient: () => {
                    created += 1;
                    const authorized = allowed;
                    return {
                        contacts: {
                            authorized: async () => ({ authorized, status: authorized ? "authorized" : "denied" }),
                            list: async () => ({ contacts: [] }),
                            search: async () => ({ contacts: [] }),
                        },
                        close: async () => {
                            closed += 1;
                        },
                    };
                },
            })
        );
        expect((await source.people({ text: "", limit: 5 })).state).toBe("refused");
        allowed = true;
        expect((await source.people({ text: "", limit: 5 })).state).toBe("ok");
        expect(created).toBe(2);
        expect(closed).toBe(2);
    });
});

describe("Contacts generation lifetime", () => {
    test("the same source observes allowed, denied, then allowed across sequential queries", async () => {
        let allowed = true;
        let created = 0;
        let closed = 0;
        const source = new ContactsPeopleSource(
            darwinkitContacts({
                createClient: () => {
                    created += 1;
                    return nativeContacts({
                        authorized: allowed,
                        onClose: async () => {
                            closed += 1;
                        },
                    }).client;
                },
            })
        );
        expect((await source.people({ text: "", limit: 5 })).state).toBe("ok");
        allowed = false;
        expect((await source.people({ text: "", limit: 5 })).state).toBe("refused");
        allowed = true;
        expect((await source.people({ text: "", limit: 5 })).state).toBe("ok");
        expect(created).toBe(3);
        expect(closed).toBe(3);
    });

    test("default directories share the owner, and sequential reads use fresh native generations", async () => {
        expect(darwinkitContacts()).toBe(darwinkitContacts());
        const generations: ReturnType<typeof nativeContacts>[] = [];
        const reader = darwinkitContacts({
            createClient: () => {
                const native = nativeContacts();
                generations.push(native);
                return native.client;
            },
        });
        const source = new ContactsPeopleSource(reader);
        await expect(source.people({ text: "", limit: 5 })).resolves.toMatchObject({
            state: "ok",
            people: [{ name: "Alex Example" }],
        });
        await expect(source.people({ text: "Alex", limit: 5 })).resolves.toMatchObject({ state: "ok" });
        expect(generations).toHaveLength(2);
        expect(generations[0]?.calls).toEqual(["authorized", "list", "close"]);
        expect(generations[1]?.calls).toEqual(["authorized", "search", "close"]);
    });

    test("concurrent acquisition coalesces; retirement waits for the pinned fetch and for close", async () => {
        const fetchEntered = deferred<void>();
        const fetchDone = deferred<void>();
        const closeEntered = deferred<void>();
        const closeDone = deferred<void>();
        let checks = 0;
        const first = nativeContacts({
            onAuthorization: async () => {
                checks += 1;
                return { authorized: checks === 1, status: checks === 1 ? "authorized" : "denied" };
            },
            onFetch: async () => {
                fetchEntered.resolve();
                await fetchDone.promise;
            },
            onClose: async () => {
                closeEntered.resolve();
                await closeDone.promise;
            },
        });
        const second = nativeContacts();
        let created = 0;
        const source = new ContactsPeopleSource(
            darwinkitContacts({
                createClient: () => {
                    created += 1;
                    return created === 1 ? first.client : second.client;
                },
            })
        );
        const heldRead = source.people({ text: "", limit: 5 });
        await fetchEntered.promise;
        expect((await source.people({ text: "Alex", limit: 5 })).state).toBe("refused");
        const nextReads = Array.from({ length: 8 }, () => source.people({ text: "Alex", limit: 5 }));
        expect(created).toBe(1);
        expect(first.calls).not.toContain("close");
        fetchDone.resolve();
        expect((await heldRead).state).toBe("ok");
        await closeEntered.promise;
        expect(created).toBe(1);
        expect(first.calls).toEqual(["authorized", "list", "authorized", "close"]);
        closeDone.resolve();
        expect((await Promise.all(nextReads)).every((result) => result.state === "ok")).toBe(true);
        expect(created).toBe(2);
        expect(first.calls.filter((call) => call === "close")).toHaveLength(1);
        expect(second.calls.filter((call) => call === "authorized")).toHaveLength(8);
        expect(second.calls.filter((call) => call === "search")).toHaveLength(8);
        expect(second.calls.filter((call) => call === "close")).toHaveLength(1);
    });

    test("concurrent denials close once, and later denials never overlap unfinished close", async () => {
        const authEntered = deferred<void>();
        const authDone = deferred<void>();
        const closeEntered = deferred<void>();
        const closeDone = deferred<void>();
        let created = 0;
        const first = nativeContacts({
            onAuthorization: async () => {
                authEntered.resolve();
                await authDone.promise;
                return { authorized: false, status: "denied" };
            },
            onClose: async () => {
                closeEntered.resolve();
                await closeDone.promise;
            },
        });
        const second = nativeContacts({ authorized: false });
        const source = new ContactsPeopleSource(
            darwinkitContacts({
                createClient: () => {
                    created += 1;
                    return created === 1 ? first.client : second.client;
                },
            })
        );
        const denied = Array.from({ length: 12 }, () => source.people({ text: "", limit: 5 }));
        await authEntered.promise;
        expect(created).toBe(1);
        authDone.resolve();
        expect((await Promise.all(denied)).every((result) => result.state === "refused")).toBe(true);
        await closeEntered.promise;
        const later = Array.from({ length: 12 }, () => source.people({ text: "", limit: 5 }));
        expect(created).toBe(1);
        closeDone.resolve();
        expect((await Promise.all(later)).every((result) => result.state === "refused")).toBe(true);
        expect(created).toBe(2);
        expect(first.calls.filter((call) => call === "close")).toHaveLength(1);
        expect(first.calls.filter((call) => call === "authorized")).toHaveLength(12);
        expect(second.calls.filter((call) => call === "authorized")).toHaveLength(12);
        expect(second.calls).not.toContain("list");
    });

    test("permission and other fetch failures remain unchanged while their completed generation closes", async () => {
        for (const error of [
            new darwinkit.DarwinKitError(-32002, "Contacts refused"),
            new Error("timed out"),
            new DOMException("Cancelled", "AbortError"),
        ]) {
            const first = nativeContacts({
                onFetch: async () => {
                    throw error;
                },
            });
            const second = nativeContacts();
            let created = 0;
            const source = new ContactsPeopleSource(
                darwinkitContacts({
                    createClient: () => {
                        created += 1;
                        return created === 1 ? first.client : second.client;
                    },
                })
            );
            await expect(source.people({ text: "Alex", limit: 5 })).rejects.toBe(error);
            const next = source.people({ text: "", limit: 5 });

            await expect(next).resolves.toMatchObject({ state: "ok" });
            expect(created).toBe(2);
            expect(first.calls).toEqual(["authorized", "search", "close"]);
        }
    });

    test("a factory failure can be retried, while a close failure cannot accumulate helpers", async () => {
        let created = 0;
        const source = new ContactsPeopleSource(
            darwinkitContacts({
                createClient: () => {
                    created += 1;

                    if (created === 1) {
                        throw new Error("could not start");
                    }

                    return nativeContacts().client;
                },
            })
        );
        await expect(source.people({ text: "", limit: 5 })).rejects.toThrow("could not start");
        await expect(source.people({ text: "", limit: 5 })).resolves.toMatchObject({ state: "ok" });
        expect(created).toBe(2);

        let deniedCreated = 0;
        const closeError = new Error("could not close");
        const denied = new ContactsPeopleSource(
            darwinkitContacts({
                createClient: () => {
                    deniedCreated += 1;
                    return nativeContacts({
                        authorized: false,
                        onClose: async () => {
                            throw closeError;
                        },
                    }).client;
                },
            })
        );
        expect((await denied.people({ text: "", limit: 5 })).state).toBe("refused");
        await expect(denied.people({ text: "", limit: 5 })).rejects.toBe(closeError);
        await expect(denied.people({ text: "", limit: 5 })).rejects.toBe(closeError);
        expect(deniedCreated).toBe(1);
    });

    test("disabled Contacts creates no helper; recovery never touches the unrelated shared client", async () => {
        const getShared = spyOn(darwinkit, "getDarwinKit");
        const closeShared = spyOn(darwinkit, "closeDarwinKit");
        const retireShared = spyOn(darwinkit, "closeDarwinKitWhenIdle");
        try {
            const unrelated = deferred<string>();
            let created = 0;
            const source = new ContactsPeopleSource(
                darwinkitContacts({
                    createClient: () => {
                        created += 1;
                        return nativeContacts({ authorized: created > 1 }).client;
                    },
                })
            );
            const { store, book } = scratch([]);
            const directory = peopleDirectory({
                store,
                book,
                config: meetingsConfigSchema.parse({ global: { people: { sources: { contacts: false } } } }),
                contacts: source,
            });
            expect((await directory.known("")).sources).toContainEqual({
                kind: "contacts",
                state: "off",
                reason: "turned off (global.people.sources.contacts)",
            });
            expect(created).toBe(0);
            expect((await source.people({ text: "", limit: 5 })).state).toBe("refused");
            expect((await source.people({ text: "", limit: 5 })).state).toBe("ok");
            unrelated.resolve("shared request completed");
            expect(await unrelated.promise).toBe("shared request completed");
            expect(getShared).not.toHaveBeenCalled();
            expect(closeShared).not.toHaveBeenCalled();
            expect(retireShared).not.toHaveBeenCalled();
        } finally {
            getShared.mockRestore();
            closeShared.mockRestore();
            retireShared.mockRestore();
        }
    });
});

test("completed successful Contacts reads do not close another reader's native lease", async () => {
    const firstEntered = deferred<void>();
    const secondEntered = deferred<void>();
    const finishFirst = deferred<void>();
    const finishSecond = deferred<void>();
    let calls = 0;
    const first = nativeContacts({
        onFetch: async () => {
            calls += 1;
            if (calls === 1) {
                firstEntered.resolve();
                await finishFirst.promise;
            } else {
                secondEntered.resolve();
                await finishSecond.promise;
            }
        },
    });
    const next = nativeContacts();
    let created = 0;
    const source = new ContactsPeopleSource(
        darwinkitContacts({
            createClient: () => {
                created += 1;
                return created === 1 ? first.client : next.client;
            },
        })
    );
    const one = source.people({ text: "", limit: 5 });
    const two = source.people({ text: "Alex", limit: 5 });
    await Promise.all([firstEntered.promise, secondEntered.promise]);
    finishFirst.resolve();
    expect((await one).state).toBe("ok");
    expect(first.calls).not.toContain("close");
    const after = source.people({ text: "", limit: 5 });
    expect(created).toBe(1);
    finishSecond.resolve();
    expect((await two).state).toBe("ok");
    expect((await after).state).toBe("ok");
    expect(created).toBe(2);
    expect(first.calls.filter((call) => call === "close")).toHaveLength(1);
});
