import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { isObject } from "@genesiscz/utils/object";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/atomic-file";
import { Storage } from "@genesiscz/utils/storage/storage";
import { z } from "zod";
import { samePerson } from "./people";

const { log } = logger.scoped("meetings-people");

/**
 * The people directory's own data (WaveB-Plan "Candidate 6"): the people a person added by hand, the merges of two
 * people into one, and the people hidden from the lists. It lives in `~/.genesis-tools/meetings/people.json`, apart
 * from the config, because it grows with use and `config set` and the config's migrations rewrite the config file. No
 * meeting record changes for any of it: a merge is an alias that every reader of the directory applies, so removing
 * the alias undoes it.
 */
export const PEOPLE_FILE = "people.json";
export const PEOPLE_BOOK_VERSION = 1;

const isoTime = z.string().min(1);

/** A person as the book names one: a name, and the email when it is known. */
export const personRefSchema = z.object({
    name: z.string().trim().min(1),
    email: z.string().trim().min(1).optional(),
});
export type PersonRefValue = z.infer<typeof personRefSchema>;

/** A person added by hand (`people add`, the picker's "Add 'X' as new speaker"). */
export const ownEntrySchema = personRefSchema
    .extend({ note: z.string().trim().min(1).optional(), addedAt: isoTime })
    .loose();
export type OwnEntry = z.infer<typeof ownEntrySchema>;

/** Two people shown as one: `name` is the name the merged person shows; `token` undoes it (`people unmerge`). */
export const peopleMergeSchema = z
    .object({
        token: z.string().min(1),
        people: z.tuple([personRefSchema, personRefSchema]),
        name: z.string().trim().min(1),
        at: isoTime,
    })
    .loose();
export type PeopleMerge = z.infer<typeof peopleMergeSchema>;

/** A person left out of every list until shown again. */
export const hiddenPersonSchema = personRefSchema.extend({ at: isoTime }).loose();
export type HiddenPerson = z.infer<typeof hiddenPersonSchema>;

/** What the book holds, after its loader read it. */
export interface PeopleBookData {
    version: number;
    entries: OwnEntry[];
    merges: PeopleMerge[];
    hidden: HiddenPerson[];
}

type ListName = "entries" | "merges" | "hidden";

/** The file as it was read: the parsed lists, and every value this build could not read, kept for the next write. */
interface ReadBook {
    data: PeopleBookData;
    /** Top-level keys and list elements of a newer build (or a hand edit) this build does not know. */
    kept: { top: Record<string, unknown>; lists: Record<ListName, unknown[]> };
    /** Why the file did not read as JSON: the next write moves it aside instead of losing it. */
    broken?: string;
}

function emptyBook(): ReadBook {
    return {
        data: { version: PEOPLE_BOOK_VERSION, entries: [], merges: [], hidden: [] },
        kept: { top: {}, lists: { entries: [], merges: [], hidden: [] } },
    };
}

/**
 * Reads the book's text. A list element that does not parse (a newer build's shape, a hand edit) is kept as it is and
 * written back, never dropped; text that is not JSON (a torn write, a hand edit) reads as an empty book with `broken`.
 */
export function parsePeopleBook(text: string, path = PEOPLE_FILE): ReadBook {
    const book = emptyBook();
    let raw: unknown;

    try {
        raw = SafeJSON.parse(text, { strict: true });
    } catch (error) {
        log.warn({ path, error }, "people book is not JSON; it reads as empty and the next write moves it aside");
        return { ...book, broken: error instanceof Error ? error.message : String(error) };
    }

    if (!isObject(raw)) {
        log.warn({ path }, "people book is not an object; it reads as empty and the next write moves it aside");
        return { ...book, broken: "the file is not a JSON object" };
    }

    const { version, entries, merges, hidden, ...top } = raw;
    book.kept.top = top;
    book.data.version = typeof version === "number" && version > PEOPLE_BOOK_VERSION ? version : PEOPLE_BOOK_VERSION;
    const read = { path, kept: book.kept.lists };
    book.data.entries = readList(ownEntrySchema, entries, "entries", read);
    book.data.merges = readList(peopleMergeSchema, merges, "merges", read);
    book.data.hidden = readList(hiddenPersonSchema, hidden, "hidden", read);
    return book;
}

/** The values of one list that parse; each one that does not is kept for the next write. */
function readList<T>(
    schema: z.ZodType<T>,
    value: unknown,
    name: ListName,
    read: { path: string; kept: Record<ListName, unknown[]> }
): T[] {
    const parsed: T[] = [];

    for (const one of Array.isArray(value) ? value : []) {
        const result = schema.safeParse(one);

        if (result.success) {
            parsed.push(result.data);
        } else {
            log.warn(
                { path: read.path, list: name, error: result.error.message },
                "people book value does not parse; kept"
            );
            read.kept[name].push(one);
        }
    }

    return parsed;
}

/** The book's text for a write: what this build read and changed, plus everything it kept unread. */
function bookText(book: ReadBook): string {
    const value = {
        ...book.kept.top,
        version: book.data.version,
        entries: [...book.data.entries, ...book.kept.lists.entries],
        merges: [...book.data.merges, ...book.kept.lists.merges],
        hidden: [...book.data.hidden, ...book.kept.lists.hidden],
    };
    return `${SafeJSON.stringify(value, null, 4)}\n`;
}

/** What `add` did: the entry as it is now, and whether it is new. */
export interface AddedPerson {
    entry: OwnEntry;
    added: boolean;
    /** True when the person was hidden and adding showed them again. */
    shown: boolean;
}

/**
 * The people book file: read without a lock (a read never writes), and changed under the file's lock with an atomic
 * write, so two processes never lose each other's change and a crash never leaves half a file.
 */
export class PeopleBook {
    readonly path: string;
    private readonly storage: Storage;
    private readonly now: () => Date;

    constructor(options: { storage?: Storage; path?: string; now?: () => Date } = {}) {
        this.storage = options.storage ?? new Storage("meetings");
        this.path = options.path ?? join(this.storage.getBaseDir(), PEOPLE_FILE);
        this.now = options.now ?? (() => new Date());
    }

    read(): PeopleBookData {
        return this.load().data;
    }

    /** Adds a person by hand; one the book knows (same email, or same name tokens) gains the email and note instead. */
    async add(person: { name: string; email?: string; note?: string }): Promise<AddedPerson> {
        const ref = personRefSchema.parse(person);
        const note = person.note?.trim() || undefined;
        return this.change((data) => {
            const hiddenBefore = data.hidden.length;
            data.hidden = data.hidden.filter((hidden) => !samePerson(hidden, ref));
            const shown = data.hidden.length < hiddenBefore;
            const known = data.entries.find((entry) => samePerson(entry, ref));

            if (known) {
                known.email ??= ref.email;
                known.note = note ?? known.note;
                return { entry: known, added: false, shown };
            }

            const entry: OwnEntry = { ...ref, ...(note ? { note } : {}), addedAt: this.now().toISOString() };
            data.entries.push(entry);
            return { entry, added: true, shown };
        });
    }

    /** Hides a person from the lists (`hidden: false` shows them again). Answers whether anything changed. */
    async hide(person: PersonRefValue, hidden = true): Promise<boolean> {
        const ref = personRefSchema.parse(person);
        return this.change((data) => {
            const before = data.hidden.length;

            if (!hidden) {
                data.hidden = data.hidden.filter((one) => !samePerson(one, ref));
                return data.hidden.length < before;
            }

            if (data.hidden.some((one) => samePerson(one, ref))) {
                return false;
            }

            data.hidden.push({ ...ref, at: this.now().toISOString() });
            return true;
        });
    }

    /** Writes a merge of two people under a new undo token. */
    async merge(merge: { people: [PersonRefValue, PersonRefValue]; name: string }): Promise<PeopleMerge> {
        const saved: PeopleMerge = {
            token: randomUUID(),
            people: [personRefSchema.parse(merge.people[0]), personRefSchema.parse(merge.people[1])],
            name: merge.name.trim(),
            at: this.now().toISOString(),
        };
        return this.change((data) => {
            data.merges.push(saved);
            return saved;
        });
    }

    /** Removes the merge `token` names; undefined when the book has no such merge. */
    async unmerge(token: string): Promise<PeopleMerge | undefined> {
        return this.change((data) => {
            const found = data.merges.find((merge) => merge.token === token);
            data.merges = data.merges.filter((merge) => merge.token !== token);
            return found;
        });
    }

    private load(): ReadBook {
        if (!existsSync(this.path)) {
            return emptyBook();
        }

        return parsePeopleBook(readFileSync(this.path, "utf8"), this.path);
    }

    private async change<T>(mutate: (data: PeopleBookData) => T): Promise<T> {
        return this.storage.withFileLock({
            file: this.path,
            fn: async () => {
                const book = this.load();

                if (book.broken) {
                    // Kept beside the new file, so a hand edit with a typo is never lost.
                    const aside = `${this.path}.broken-${this.now().toISOString().replace(/[:.]/g, "-")}`;
                    renameSync(this.path, aside);
                    log.warn({ path: this.path, aside, reason: book.broken }, "people book moved aside before a write");
                }

                const result = mutate(book.data);
                atomicWriteFileSync(this.path, bookText(book), { mode: 0o600 });
                log.debug({ path: this.path }, "people book written");
                return result;
            },
        });
    }
}
