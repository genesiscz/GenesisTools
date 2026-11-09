import { existsSync, readdirSync, statSync } from "node:fs";
import { logger } from "@genesiscz/utils/logger";
import type { MeetingsConfig } from "./config";
import { nameKey, type PersonRef } from "./people";
import { type AddedPerson, PeopleBook, type PeopleMerge, type PersonRefValue } from "./people-book";
import type { MeetingRecord, MeetingStore } from "./record";

const { log } = logger.scoped("meetings-people");

/**
 * The people directory (WaveB-Plan "Candidate 6", R23, R24, R44): one answer to "who do we know", from every place a
 * person is named. A meeting names people in its participants, its attendance, its calendar entry and its speaker
 * renames; a project pairs people (the config); Contacts knows the address book; the people book (`people.json`) keeps
 * the people added by hand, the merges and the hidden people. Each place is one `PeopleSource`; the directory groups
 * their people into one person per identity (`samePerson`: the same email, else the same name tokens), applies the
 * book's merges and hides, and ranks them for a meeting and a moment. Nothing is preselected.
 */

/** Where a person comes from. */
export const PERSON_SOURCE_KINDS = ["meetings", "projects", "contacts", "own"] as const;
export type PersonSourceKind = (typeof PERSON_SOURCE_KINDS)[number];

/** How a meeting names a person. */
export const MEETING_ROLES = ["participant", "attendance", "calendar", "speaker"] as const;
export type MeetingRole = (typeof MEETING_ROLES)[number];

/** One meeting a person is in, and how it names them. */
export interface MeetingAppearance {
    meeting: string;
    title: string;
    start: string;
    as: MeetingRole[];
    /** When they were in the call, on the transcript clock (the attendance). */
    present: Array<{ fromSec: number; toSec: number }>;
    /** The speaker labels renamed to them in this meeting. */
    labels: string[];
}

/** A person as one source names them. */
export interface SourcePerson extends PersonRef {
    meetings?: MeetingAppearance[];
    projects?: string[];
    note?: string;
    organization?: string;
}

/** What one source answered: its people, or why it has none (turned off, access refused, failed). */
export type SourceAnswer =
    | { state: "ok"; people: SourcePerson[] }
    | { state: "off" | "refused" | "failed"; reason: string };

export interface PeopleQuery {
    /** What was typed; empty lists everyone. */
    text: string;
    /** A source that searches (Contacts) answers at most this many. */
    limit: number;
}

/** One place that names people. A source that cannot read says why; it never answers an empty list for a refusal. */
export interface PeopleSource {
    readonly kind: PersonSourceKind;
    people(query: PeopleQuery): Promise<SourceAnswer>;
}

/**
 * Why a person is where they are in a ranked list, best first (G-PPL-3): in the call at that moment, in that meeting
 * (participants, attendance, calendar, renames), in other meetings or a project, in Contacts, added by hand.
 */
export const PERSON_RANKS = ["present", "meeting", "meetings", "contacts", "own"] as const;
export type PersonRank = (typeof PERSON_RANKS)[number];

/** One person of the directory. */
export interface KnownPerson {
    /** A stable reference: `email:<address>` when an email is known, else `name:<name tokens>`. */
    id: string;
    name: string;
    email?: string;
    /** The owner (the meetings' "you"). */
    self?: true;
    /** Other names the same person goes by (spellings, a merged person's names). */
    aliases: string[];
    sources: PersonSourceKind[];
    rank: PersonRank;
    /** The meetings that name them. */
    meetings: number;
    /** The start of the newest of those meetings. */
    lastSeen?: string;
    projects: string[];
    organization?: string;
    note?: string;
    /** The merge this person is made of: `people unmerge <token>` splits it again. */
    merge?: string;
    /** Hidden from the lists (only listed when hidden people are asked for). */
    hidden?: true;
}

export interface SourceStatus {
    kind: PersonSourceKind;
    state: SourceAnswer["state"];
    /** Why it has no people: off by a setting, access refused (with the fix), or the error. */
    reason?: string;
}

/** A ranked answer: the people, how many matched before the limit, and how each source answered. */
export interface KnownPeople {
    query: string;
    people: KnownPerson[];
    total: number;
    sources: SourceStatus[];
}

export interface KnownOptions {
    /** Rank for this meeting (an exact id): its people first. */
    meeting?: string;
    /** And for this moment of it (transcript seconds): the people in the call then come first of all. */
    atSec?: number;
    /** At most this many people (20 by default). */
    limit?: number;
    /** Only these sources (all by default). */
    kinds?: PersonSourceKind[];
    /** List hidden people too, marked `hidden`. */
    includeHidden?: boolean;
}

/** One meeting a merge links, and which of the two people it names. */
export interface MergeMeeting {
    id: string;
    title: string;
    start: string;
    /** Which of the two people the meeting names: 0 the first, 1 the second. */
    people: Array<0 | 1>;
    as: MeetingRole[];
}

/**
 * What a merge of two people would do, before it is made (R24: "a merge first asks, naming the meetings it changes").
 * No meeting record changes: every reader of the directory shows the two as one person named `name`.
 */
export interface MergePlan {
    people: [KnownPerson, KnownPerson];
    name: string;
    meetings: MergeMeeting[];
    /** The speaker labels renamed to either person: the directory shows them as the merged person. */
    labels: Array<{ meeting: string; label: string; name: string }>;
}

export const PEOPLE_ERROR_CODES = ["unknown-person", "ambiguous-person", "unknown-merge"] as const;
export type PeopleErrorCode = (typeof PEOPLE_ERROR_CODES)[number];

/** A person reference that names no one or several people, or an unmerge token the book does not have. */
export class PeopleError extends Error {
    constructor(
        readonly code: PeopleErrorCode,
        message: string,
        readonly candidates: KnownPerson[] = []
    ) {
        super(message);
        this.name = "PeopleError";
    }
}

const DEFAULT_LIMIT = 20;

/** Text without accents or case, NFC or NFD alike: "Dana Exámple" and "dana example" read the same (G-PPL-2). */
export function foldText(text: string): string {
    return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim();
}

/** One person while the sources are grouped: every name, email and sighting that is the same person. */
interface Identity {
    names: Map<string, { name: string; count: number; order: number }>;
    keys: Set<string>;
    emails: Set<string>;
    self: boolean;
    sources: Set<PersonSourceKind>;
    appearances: Map<string, MeetingAppearance>;
    projects: Set<string>;
    organization?: string;
    note?: string;
    merge?: PeopleMerge;
    hidden: boolean;
}

function newIdentity(): Identity {
    return {
        names: new Map(),
        keys: new Set(),
        emails: new Set(),
        self: false,
        sources: new Set(),
        appearances: new Map(),
        projects: new Set(),
        hidden: false,
    };
}

/** The identity a reference is: its email, or (when either side has no email) its name tokens, as `samePerson` reads. */
function matches(identity: Identity, ref: PersonRef): boolean {
    const email = ref.email?.toLowerCase();

    if (email && identity.emails.has(email)) {
        return true;
    }

    const key = nameKey(ref.name);

    if (!key || !identity.keys.has(key)) {
        return false;
    }

    return !email || identity.emails.size === 0;
}

function mergeAppearance(into: Map<string, MeetingAppearance>, appearance: MeetingAppearance): void {
    const known = into.get(appearance.meeting);

    if (!known) {
        into.set(appearance.meeting, {
            ...appearance,
            as: [...appearance.as],
            present: [...appearance.present],
            labels: [...appearance.labels],
        });
        return;
    }

    known.as = MEETING_ROLES.filter((role) => known.as.includes(role) || appearance.as.includes(role));
    known.present.push(...appearance.present);
    known.labels = [...new Set([...known.labels, ...appearance.labels])];
}

let sightings = 0;

function absorb(identity: Identity, kind: PersonSourceKind, person: SourcePerson): void {
    const key = nameKey(person.name);
    const name = person.name.trim().normalize("NFC");
    const seen = identity.names.get(name);
    identity.names.set(name, { name, count: (seen?.count ?? 0) + 1, order: seen?.order ?? sightings++ });

    if (key) {
        identity.keys.add(key);
    }

    if (person.email) {
        identity.emails.add(person.email.toLowerCase());
    }

    identity.self ||= person.self === true;
    identity.sources.add(kind);

    for (const appearance of person.meetings ?? []) {
        mergeAppearance(identity.appearances, appearance);
    }

    for (const project of person.projects ?? []) {
        identity.projects.add(project);
    }

    identity.organization ??= person.organization;
    identity.note ??= person.note;
}

/** Everything `from` knows goes into `into`. */
function unite(into: Identity, from: Identity): void {
    for (const [name, seen] of from.names) {
        const known = into.names.get(name);
        into.names.set(name, {
            name,
            count: (known?.count ?? 0) + seen.count,
            order: Math.min(known?.order ?? seen.order, seen.order),
        });
    }

    for (const key of from.keys) {
        into.keys.add(key);
    }

    for (const email of from.emails) {
        into.emails.add(email);
    }

    into.self ||= from.self;

    for (const kind of from.sources) {
        into.sources.add(kind);
    }

    for (const appearance of from.appearances.values()) {
        mergeAppearance(into.appearances, appearance);
    }

    for (const project of from.projects) {
        into.projects.add(project);
    }

    into.organization ??= from.organization;
    into.note ??= from.note;
    into.hidden ||= from.hidden;
}

/** The name a person shows: a merge's name, else the one seen most often (then the longer, then the first seen). */
function shownName(identity: Identity): string {
    if (identity.merge) {
        return identity.merge.name;
    }

    const names = [...identity.names.values()].sort(
        (a, b) => b.count - a.count || b.name.length - a.name.length || a.order - b.order
    );
    return names[0]?.name ?? "";
}

/** The identity's email: the first one seen, in a stable order. */
function firstEmail(identity: Identity): string | undefined {
    return [...identity.emails].sort()[0];
}

function idOf(identity: Identity): string {
    const email = firstEmail(identity);
    return email ? `email:${email}` : `name:${nameKey(shownName(identity))}`;
}

function textMatches(identity: Identity, query: string): boolean {
    if (!query) {
        return true;
    }

    return (
        [...identity.names.keys()].some((name) => foldText(name).includes(query)) ||
        [...identity.emails].some((email) => email.includes(query))
    );
}

function rankOf(identity: Identity, options: KnownOptions): PersonRank {
    const here = options.meeting ? identity.appearances.get(options.meeting) : undefined;

    if (here && options.atSec !== undefined) {
        const at = options.atSec;

        if (here.present.some((span) => span.fromSec <= at && at <= span.toSec)) {
            return "present";
        }
    }

    if (here) {
        return "meeting";
    }

    if (identity.appearances.size > 0 || identity.sources.has("meetings") || identity.sources.has("projects")) {
        return "meetings";
    }

    return identity.sources.has("contacts") ? "contacts" : "own";
}

function lastSeenOf(identity: Identity): string | undefined {
    return [...identity.appearances.values()]
        .map((appearance) => appearance.start)
        .sort((a, b) => b.localeCompare(a))[0];
}

function personOf(identity: Identity, options: KnownOptions): KnownPerson {
    const name = shownName(identity);
    const email = firstEmail(identity);
    const lastSeen = lastSeenOf(identity);
    return {
        id: idOf(identity),
        name,
        ...(email ? { email } : {}),
        ...(identity.self ? { self: true as const } : {}),
        aliases: [...identity.names.keys()].filter((alias) => alias !== name).sort(),
        sources: PERSON_SOURCE_KINDS.filter((kind) => identity.sources.has(kind)),
        rank: rankOf(identity, options),
        meetings: identity.appearances.size,
        ...(lastSeen ? { lastSeen } : {}),
        projects: [...identity.projects].sort(),
        ...(identity.organization ? { organization: identity.organization } : {}),
        ...(identity.note ? { note: identity.note } : {}),
        ...(identity.merge ? { merge: identity.merge.token } : {}),
        ...(identity.hidden ? { hidden: true as const } : {}),
    };
}

function byRank(a: KnownPerson, b: KnownPerson): number {
    return (
        PERSON_RANKS.indexOf(a.rank) - PERSON_RANKS.indexOf(b.rank) ||
        b.meetings - a.meetings ||
        (b.lastSeen ?? "").localeCompare(a.lastSeen ?? "") ||
        a.name.localeCompare(b.name)
    );
}

/** The people one meeting record names, one per person (participants, attendance, calendar, renames, assignments). */
export function peopleOfMeeting(record: MeetingRecord, options: { calendar: boolean }): SourcePerson[] {
    const people: Array<SourcePerson & { appearance: MeetingAppearance }> = [];
    const sighting = (ref: PersonRef, role: MeetingRole, extra: Partial<MeetingAppearance> = {}) => {
        const name = ref.name.trim();

        if (!name) {
            return;
        }

        const appearance: MeetingAppearance = {
            meeting: record.id,
            title: record.title,
            start: record.start,
            as: [role],
            present: extra.present ?? [],
            labels: extra.labels ?? [],
        };
        const known = people.find((person) => {
            const identity = newIdentity();
            absorb(identity, "meetings", person);
            return matches(identity, ref);
        });

        if (!known) {
            people.push({
                name,
                ...(ref.email ? { email: ref.email } : {}),
                ...(ref.self ? { self: true } : {}),
                appearance,
            });
            return;
        }

        known.email ??= ref.email;
        known.self ||= ref.self;
        const merged = new Map([[record.id, known.appearance]]);
        mergeAppearance(merged, appearance);
        known.appearance = merged.get(record.id) ?? known.appearance;
    };

    for (const person of record.participants) {
        sighting({ name: person.name, ...(person.self ? { self: true } : {}) }, "participant");
    }

    for (const person of record.attendance?.people ?? []) {
        sighting({ name: person.name, ...(person.self ? { self: true } : {}) }, "attendance", {
            present: [{ fromSec: person.fromSec, toSec: person.toSec }],
        });
    }

    if (options.calendar && record.calendar) {
        const withEmails = record.calendar.people ?? [];

        for (const person of withEmails) {
            sighting(person, "calendar");
        }

        for (const name of record.calendar.attendees) {
            sighting({ name }, "calendar");
        }
    }

    for (const [label, name] of Object.entries(record.speakers.labels)) {
        sighting({ name }, "speaker", { labels: [label] });
    }

    for (const assignment of record.speakers.assignments ?? []) {
        sighting({ name: assignment.person, ...(assignment.email ? { email: assignment.email } : {}) }, "speaker");
    }

    return people.map(({ appearance, ...person }) => ({ ...person, meetings: [appearance] }));
}

/**
 * The people of every meeting record. It reads a record again only when its file changed (time and size), so the
 * index follows the meetings folder (G-PPL-9) without reading every record on each keystroke of a picker.
 */
export class MeetingsPeopleSource implements PeopleSource {
    readonly kind = "meetings" as const;
    private readonly cache = new Map<string, { stamp: string; people: SourcePerson[] }>();

    constructor(private readonly options: { store: MeetingStore; calendar: boolean }) {}

    async people(): Promise<SourceAnswer> {
        const { store } = this.options;

        if (!existsSync(store.root)) {
            return { state: "ok", people: [] };
        }

        const seen = new Set<string>();
        const people: SourcePerson[] = [];

        for (const entry of readdirSync(store.root, { withFileTypes: true })) {
            if (!entry.isDirectory() || entry.name.startsWith(".")) {
                continue;
            }

            const path = store.path(entry.name);
            let stamp: string;

            try {
                const stat = statSync(path);
                stamp = `${stat.mtimeMs}:${stat.size}`;
            } catch (error) {
                log.debug({ path, error }, "meeting folder without a record; no people");
                continue;
            }

            seen.add(entry.name);
            const cached = this.cache.get(entry.name);

            if (cached?.stamp === stamp) {
                people.push(...cached.people);
                continue;
            }

            const record = store.read(entry.name);
            const found = record ? peopleOfMeeting(record, { calendar: this.options.calendar }) : [];
            this.cache.set(entry.name, { stamp, people: found });
            people.push(...found);
        }

        for (const id of [...this.cache.keys()]) {
            if (!seen.has(id)) {
                this.cache.delete(id);
            }
        }

        return { state: "ok", people };
    }
}

/** The people the projects pair (`projects.<p>.match.people` in the config). */
export class ProjectsPeopleSource implements PeopleSource {
    readonly kind = "projects" as const;

    constructor(private readonly config: MeetingsConfig) {}

    async people(): Promise<SourceAnswer> {
        const people = Object.entries(this.config.projects).flatMap(([project, settings]) =>
            (settings.match?.people ?? []).map(
                (person): SourcePerson => ({
                    name: person.name,
                    ...(person.email ? { email: person.email } : {}),
                    projects: [project],
                })
            )
        );
        return { state: "ok", people };
    }
}

/** The people added by hand, from the people book. */
export class OwnPeopleSource implements PeopleSource {
    readonly kind = "own" as const;

    constructor(private readonly book: PeopleBook) {}

    async people(): Promise<SourceAnswer> {
        const people = this.book.read().entries.map(
            (entry): SourcePerson => ({
                name: entry.name,
                ...(entry.email ? { email: entry.email } : {}),
                ...(entry.note ? { note: entry.note } : {}),
            })
        );
        return { state: "ok", people };
    }
}

export interface PeopleDirectoryOptions {
    sources: PeopleSource[];
    book: PeopleBook;
    /** Sources a setting turned off, each with the reason a list shows. */
    off?: Array<{ kind: PersonSourceKind; reason: string }>;
}

/** The directory itself: grouping, merges, hides, ranking, and the book's writes. */
export class PeopleDirectory {
    constructor(private readonly options: PeopleDirectoryOptions) {}

    get book(): PeopleBook {
        return this.options.book;
    }

    /** The people that match `query` (folded: case and accents ignored), ranked for the meeting and moment given. */
    async known(query: string, options: KnownOptions = {}): Promise<KnownPeople> {
        const { identities, sources } = await this.identities(query, options);
        const text = foldText(query);
        const matched = identities
            .filter((identity) => textMatches(identity, text) && (options.includeHidden || !identity.hidden))
            .map((identity) => personOf(identity, options))
            .sort(byRank);
        return {
            query,
            people: matched.slice(0, Math.max(0, options.limit ?? DEFAULT_LIMIT)),
            total: matched.length,
            sources,
        };
    }

    /**
     * The one person a reference names: an id (`email:…`, `name:…`), an email, or a name (case and accents ignored).
     * Refused with `unknown-person` or `ambiguous-person` (with the candidates).
     */
    async find(ref: string): Promise<KnownPerson> {
        return (await this.resolve(ref)).person;
    }

    /** What merging two people would do: their meetings and renamed labels; nothing is written. */
    async planMerge(a: string, b: string, name?: string): Promise<MergePlan> {
        const first = await this.resolve(a);
        const second = await this.resolve(b);

        if (first.person.id === second.person.id) {
            throw new Error(`"${a}" and "${b}" are one person already: ${first.person.name}`);
        }

        const meetings = new Map<string, MergeMeeting>();
        const labels: MergePlan["labels"] = [];

        for (const [index, identity] of [first.identity, second.identity].entries()) {
            const which: 0 | 1 = index === 0 ? 0 : 1;

            for (const appearance of identity.appearances.values()) {
                const known = meetings.get(appearance.meeting);

                if (known) {
                    known.people = [...new Set<0 | 1>([...known.people, which])];
                    known.as = MEETING_ROLES.filter((role) => known.as.includes(role) || appearance.as.includes(role));
                } else {
                    meetings.set(appearance.meeting, {
                        id: appearance.meeting,
                        title: appearance.title,
                        start: appearance.start,
                        people: [which],
                        as: [...appearance.as],
                    });
                }

                for (const label of appearance.labels) {
                    labels.push({ meeting: appearance.meeting, label, name: shownName(identity) });
                }
            }
        }

        return {
            people: [first.person, second.person],
            name: name?.trim() || first.person.name,
            meetings: [...meetings.values()].sort((x, y) => y.start.localeCompare(x.start)),
            labels,
        };
    }

    /** Merges two people under a new undo token, after the same plan `planMerge` answers. */
    async merge(a: string, b: string, name?: string): Promise<{ merge: PeopleMerge; plan: MergePlan }> {
        const plan = await this.planMerge(a, b, name);
        const refOf = (person: KnownPerson): PersonRefValue => ({
            name: person.name,
            ...(person.email ? { email: person.email } : {}),
        });
        const merge = await this.options.book.merge({
            people: [refOf(plan.people[0]), refOf(plan.people[1])],
            name: plan.name,
        });
        return { merge, plan };
    }

    /** Splits a merge again; refused with `unknown-merge` for a token the book does not have. */
    async unmerge(token: string): Promise<PeopleMerge> {
        const removed = await this.options.book.unmerge(token);

        if (!removed) {
            throw new PeopleError(
                "unknown-merge",
                `No merge has the token ${token}. See them: tools meetings people --json`
            );
        }

        return removed;
    }

    /** Adds a person by hand (or completes the one the book has), and answers them as the directory now knows them. */
    async add(person: { name: string; email?: string; note?: string }): Promise<AddedPerson & { person: KnownPerson }> {
        const added = await this.options.book.add(person);
        const found = await this.find(added.entry.email ?? added.entry.name).catch((error: unknown) => {
            // Two people share the name now (another one has an email): the new entry is the one meant.
            if (error instanceof PeopleError && error.code === "ambiguous-person") {
                return error.candidates.find((candidate) => candidate.sources.includes("own")) ?? error.candidates[0];
            }

            throw error;
        });

        if (!found) {
            throw new Error(`${added.entry.name} was added but does not read back from the people book`);
        }

        return { ...added, person: found };
    }

    /** Hides a person from the lists, or shows them again; answers whether that changed anything. */
    async hide(ref: string, hidden = true): Promise<{ person: KnownPerson; changed: boolean }> {
        const { person } = await this.resolve(ref);
        const changed = await this.options.book.hide(
            { name: person.name, ...(person.email ? { email: person.email } : {}) },
            hidden
        );
        return { person: { ...person, ...(hidden ? { hidden: true as const } : {}) }, changed };
    }

    private async resolve(ref: string): Promise<{ person: KnownPerson; identity: Identity }> {
        const wanted = ref.trim();
        const { identities } = await this.identities(wanted.startsWith("email:") ? wanted.slice(6) : wanted, {});
        const email = (wanted.startsWith("email:") ? wanted.slice(6) : wanted).toLowerCase();
        const key = wanted.startsWith("name:") ? wanted.slice(5) : nameKey(wanted);
        const found = identities.filter(
            (identity) =>
                idOf(identity) === wanted ||
                identity.emails.has(email) ||
                (key !== "" && identity.keys.has(key)) ||
                foldText(shownName(identity)) === foldText(wanted)
        );

        if (found.length === 1 && found[0]) {
            return { person: personOf(found[0], {}), identity: found[0] };
        }

        const candidates = found.map((identity) => personOf(identity, {}));

        if (candidates.length === 0) {
            throw new PeopleError("unknown-person", `Nobody known is "${ref}". Search: tools meetings people <text>`);
        }

        throw new PeopleError(
            "ambiguous-person",
            `"${ref}" names ${candidates.length} people: ${candidates.map((one) => (one.email ? `${one.name} <${one.email}>` : one.name)).join(", ")}. Name one by email or id.`,
            candidates
        );
    }

    private async identities(
        query: string,
        options: KnownOptions
    ): Promise<{ identities: Identity[]; sources: SourceStatus[] }> {
        const wanted = options.kinds;
        const limit = Math.max(options.limit ?? DEFAULT_LIMIT, DEFAULT_LIMIT);
        const asked = this.options.sources.filter((source) => !wanted || wanted.includes(source.kind));
        const answers = await Promise.all(
            asked.map(async (source) => {
                try {
                    return { source, answer: await source.people({ text: query.trim(), limit }) };
                } catch (error) {
                    log.warn({ kind: source.kind, error }, "a people source failed");
                    const reason = error instanceof Error ? error.message : String(error);
                    return { source, answer: { state: "failed" as const, reason } };
                }
            })
        );
        const identities: Identity[] = [];

        for (const { source, answer } of answers) {
            if (answer.state !== "ok") {
                continue;
            }

            for (const person of answer.people) {
                let identity = identities.find((one) => matches(one, person));

                if (!identity) {
                    identity = newIdentity();
                    identities.push(identity);
                }

                absorb(identity, source.kind, person);
            }
        }

        const book = this.options.book.read();
        const grouped = applyMerges(identities, book.merges);

        for (const identity of grouped) {
            identity.hidden ||= book.hidden.some((hidden) => matches(identity, hidden));
        }

        const sources: SourceStatus[] = [
            ...answers.map(({ source, answer }) =>
                answer.state === "ok"
                    ? { kind: source.kind, state: answer.state }
                    : { kind: source.kind, state: answer.state, reason: answer.reason }
            ),
            ...(this.options.off ?? [])
                .filter((off) => !wanted || wanted.includes(off.kind))
                .map((off) => ({ kind: off.kind, state: "off" as const, reason: off.reason })),
        ];
        return { identities: grouped, sources };
    }
}

/** Each merge joins the identities of its two people into one; a merge whose people are unknown changes nothing. */
function applyMerges(identities: Identity[], merges: PeopleMerge[]): Identity[] {
    let groups = [...identities];

    for (const merge of merges) {
        const first = groups.find((identity) => matches(identity, merge.people[0]));
        const second = groups.find((identity) => identity !== first && matches(identity, merge.people[1]));

        if (!first) {
            continue;
        }

        if (second) {
            unite(first, second);
            groups = groups.filter((identity) => identity !== second);
        }

        first.merge = merge;
    }

    return groups;
}

/** The meetings source for a store and calendar switch, kept per store so its index survives between calls. */
const meetingSources = new Map<string, MeetingsPeopleSource>();

/**
 * The directory as the settings say (`global.people.sources`): the meetings (with or without calendar attendees),
 * the projects, the people book, and Contacts when it is on and the caller can reach it (`contacts`: the source the
 * caller built, since only a process with the app's Contacts grant can read it).
 */
export function peopleDirectory(options: {
    store: MeetingStore;
    config: MeetingsConfig;
    book?: PeopleBook;
    contacts?: PeopleSource;
}): PeopleDirectory {
    const switches = options.config.global.people.sources;
    const key = `${options.store.root}\n${switches.calendar}`;
    let meetings = meetingSources.get(key);

    if (!meetings) {
        meetings = new MeetingsPeopleSource({ store: options.store, calendar: switches.calendar });
        meetingSources.set(key, meetings);
    }

    const book = options.book ?? new PeopleBook({ storage: options.store.storage });
    const sources: PeopleSource[] = [meetings, new ProjectsPeopleSource(options.config), new OwnPeopleSource(book)];
    const off: Array<{ kind: PersonSourceKind; reason: string }> = [];

    if (!switches.contacts) {
        off.push({ kind: "contacts", reason: "turned off (global.people.sources.contacts)" });
    } else if (options.contacts) {
        sources.push(options.contacts);
    }

    return new PeopleDirectory({ sources, book, off });
}

/**
 * The names the directory knows, ranked for one meeting (its people first), from the meetings, the projects and the
 * people book: the terminal's typed answers complete from them (R10). Contacts stays out, so `listen` never raises
 * the Contacts dialog. A directory that cannot read answers no names and the reason in the log.
 */
export async function meetingPeopleNames(options: {
    store: MeetingStore;
    config: MeetingsConfig;
    meeting: string;
    limit?: number;
}): Promise<string[]> {
    try {
        const known = await peopleDirectory({ store: options.store, config: options.config }).known("", {
            meeting: options.meeting,
            limit: options.limit ?? 200,
            kinds: ["meetings", "projects", "own"],
        });
        return known.people.map((person) => person.name);
    } catch (error) {
        log.warn({ error, meeting: options.meeting }, "the people directory did not read; answers complete without it");
        return [];
    }
}
