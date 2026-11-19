import { createHash, randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { sha256Json } from "@genesiscz/utils/hash";
import { parseJSON, SafeJSON } from "@genesiscz/utils/json";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/atomic-file";
import { withRecoverablePathArbitrationSync } from "@genesiscz/utils/storage/file-lock";
import { toolDataDir } from "@genesiscz/utils/storage/root";
import { z } from "zod";
import { MeetingsConfigStore, meetingsConfigSchema, projectNameSchema } from "./config";
import { nameKey } from "./people";
import { PeopleBook, type PeopleMerge, type PersonRefValue } from "./people-book";
import { type MeetingRecord, MeetingStore, voiceRootMeeting } from "./record";

export const voicePrintSchema = z
    .object({
        meeting: z.string().min(1),
        sourceSha: z.string().min(1),
        seat: z.enum(["mic", "call"]),
        track: z.enum(["source-mic", "source-call", "mic-raw", "system"]),
        fromSec: z.number().nonnegative(),
        toSec: z.number().positive(),
        embedding: z.array(z.number().finite()).min(1),
        confirmedAt: z.string().min(1),
        question: z.string().optional(),
    })
    .refine(
        (print) =>
            print.toSec > print.fromSec &&
            (print.seat === "mic" ? ["source-mic", "mic-raw"] : ["source-call", "system"]).includes(print.track),
        "Voice print needs a valid interval and a track of its seat"
    );
export type VoicePrint = z.infer<typeof voicePrintSchema>;

export const voiceStoreSchema = z.object({
    version: z.literal(1),
    model: z.string(),
    people: z.record(z.string(), z.object({ samples: z.array(voicePrintSchema) })),
});
export type VoiceStore = z.infer<typeof voiceStoreSchema>;

const nonblank = z.string().refine((value) => value.trim().length > 0);
export const ownerSchema = z.strictObject({ name: nonblank, email: nonblank.optional() });
export type VoiceOwner = PersonRefValue;
// Preserve an explicitly recorded address. The name on a v1 attachment alone never proves an address.
const legacyStoreSchema = voiceStoreSchema.extend({
    people: z.record(nonblank, z.object({ email: nonblank.optional(), samples: z.array(voicePrintSchema.strict()) })),
});

export const sourceSchema = z.strictObject({
    rootMeeting: nonblank,
    lineKey: nonblank,
    recordingKey: nonblank,
    /** Original physical span. Older documents encode just this address in lineKey. */
    spanKey: nonblank.optional(),
});
export type SampleSource = z.infer<typeof sourceSchema>;
export const idSchema = z.custom<`vs_${string}`>((v) => typeof v === "string" && v.startsWith("vs_") && v.length > 3);
export type SampleId = z.infer<typeof idSchema>;
const sampleSchema = voicePrintSchema
    .safeExtend({
        id: idSchema,
        owner: ownerSchema,
        project: projectNameSchema,
        origin: z.enum(["answer", "confirm", "enrol", "legacy"]),
        source: sourceSchema,
        acquiredBy: z.enum(["live", "backfill", "migration", "manual"]),
        /** A human transfer takes ownership from the original confirmation. Undo restores the previous snapshot. */
        transferred: z.literal(true).optional(),
    })
    .strict();
export type VoiceSample = z.infer<typeof sampleSchema>;
export type Origin = VoiceSample["origin"];
const rejectionSchema = z
    .strictObject({
        source: sourceSchema,
        owner: ownerSchema.optional(),
        reason: z.enum(["wrong-person", "bad-audio", "several-voices"]),
        at: nonblank,
        token: nonblank,
    })
    .refine((row) => row.reason !== "wrong-person" || !!row.owner, "A wrong-person refusal needs its owner");
export type Refusal = z.infer<typeof rejectionSchema>["reason"];
const revision = z.number().int().nonnegative();
const receiptSchema = z.discriminatedUnion("kind", [
    z.strictObject({
        kind: z.literal("learn"),
        token: nonblank,
        item: nonblank,
        project: projectNameSchema,
        owner: ownerSchema,
        source: sourceSchema,
        id: idSchema,
        revision,
        requestDigest: nonblank,
        active: z.literal(false).optional(),
    }),
    z.strictObject({
        kind: z.literal("correct"),
        token: nonblank,
        revision,
        requestDigest: nonblank.optional(),
        positions: z.array(revision).optional(),
        impact: z
            .object({
                planToken: nonblank,
                affected: z.array(
                    z.object({ meeting: nonblank, item: nonblank, fromSec: z.number(), toSec: z.number() })
                ),
            })
            .optional(),
        before: z.array(sampleSchema),
        after: z.array(sampleSchema),
        removedRefusals: z.array(rejectionSchema),
        addedRefusals: z.array(rejectionSchema),
    }),
]);
export type VoiceReceipt = z.infer<typeof receiptSchema>;
const manifestRow = z.strictObject({ tuple: z.string(), tupleDigest: nonblank, occurrence: revision, id: idSchema });
const manifestSchema = z.strictObject({
    project: projectNameSchema,
    fileDigest: nonblank,
    rows: z.array(manifestRow),
});
export const voiceLibrarySchema = z
    .strictObject({
        version: z.literal(2),
        revision,
        model: z.string(),
        samples: z.array(sampleSchema),
        rejected: z.array(rejectionSchema),
        imports: z.array(manifestSchema),
        receipts: z.array(receiptSchema),
    })
    .superRefine((doc, ctx) => {
        const samples = new Set(doc.samples.map((s) => s.id));
        const imports = doc.imports.flatMap((m) => m.rows.map((row) => row.id));
        if (samples.size !== doc.samples.length || new Set(imports).size !== imports.length) {
            ctx.addIssue({
                code: "custom",
                message: "Duplicate voice sample ID in the library or its import manifest",
            });
        }
        if (new Set(doc.imports.map((m) => m.project)).size !== doc.imports.length) {
            ctx.addIssue({ code: "custom", message: "Duplicate project in voice import manifest" });
        }
        if (samples.size && !doc.model.trim()) {
            ctx.addIssue({ code: "custom", message: "A nonempty voice library needs a model" });
        }
    });
export type LibraryV2 = z.infer<typeof voiceLibrarySchema>;
type Manifest = LibraryV2["imports"][number];
export type VoiceScope = { kind: "all" } | { kind: "project"; project: string } | { kind: "meeting"; meeting: string };
export type VoiceScopeSettings = { sampleScope: "all" | "project"; outlierBelow: number };

export interface VoiceLibrarySnapshot {
    library: LibraryV2;
    conflicts: Array<{ project: string; file: string; message: string }>;
    merges: PeopleMerge[];
    knownOwners: VoiceOwner[];
}

export interface MigrationReceipt {
    revision: number;
    imported: number;
    /** Includes a changed source digest even if all attachments were already accounted for. */
    changed: boolean;
}

interface MigrationOptions {
    /** Tests can force two distinct canonical attachments to propose the same selector. */
    idDigest?: (tuple: string, occurrence: number) => string;
    /** Fault injection on either side of the single atomic replacement. */
    publish?: (file: string, bytes: string) => void;
}

function libraryFile(): string {
    return toolDataDir("meetings", "voice-library", "library.json");
}

function legacyFile(project: string): string {
    return toolDataDir("meetings", "voices", `${projectNameSchema.parse(project)}.json`);
}

function legacyProjects(): string[] {
    const dir = toolDataDir("meetings", "voices");
    return existsSync(dir)
        ? readdirSync(dir, { withFileTypes: true })
              .filter((entry) => (entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith(".json"))
              .map((entry) => entry.name.slice(0, -5))
              .sort()
        : [];
}

/** Legacy prints identify a physical channel span. A question can cover many lines and is not a line ID. */
export function meetingVoiceOwner(record: MeetingRecord, name: string): VoiceOwner {
    const matches = record.calendar?.people?.filter((p) => nameKey(p.name) === nameKey(name)) ?? [];
    const addresses = new Set(matches.map((p) => p.email?.toLowerCase()));
    return addresses.size === 1 && matches[0]?.email ? { name, email: matches[0].email } : { name };
}

export function voiceLineKeys(meeting: {
    sourceMeetingId: string;
    transcript: readonly {
        id?: string;
        speaker: string;
        text: string;
        sourceIndex?: number;
    }[];
}): string[] {
    const ids = new Map<string, number>();
    for (const { id } of meeting.transcript) {
        if (id) {
            ids.set(id, (ids.get(id) ?? 0) + 1);
        }
    }
    return meeting.transcript.map((line, index) =>
        SafeJSON.stringify(
            line.id && ids.get(line.id) === 1
                ? ["entry-v1", meeting.sourceMeetingId, line.id]
                : ["line-v1", meeting.sourceMeetingId, line.sourceIndex ?? index, sha256Json([line.speaker, line.text])]
        )
    );
}

export function sourceForVoicePrint(
    print: Pick<VoicePrint, "meeting" | "sourceSha" | "seat" | "track" | "fromSec" | "toSec">,
    rootMeeting = print.meeting,
    lineKey?: string
): SampleSource {
    const recordingKey = SafeJSON.stringify([print.sourceSha, print.seat, print.track]);
    const spanKey = SafeJSON.stringify(["span-v1", recordingKey, print.fromSec, print.toSec]);
    return { rootMeeting, recordingKey, lineKey: lineKey ?? spanKey, ...(lineKey ? { spanKey } : {}) };
}

export function sameLine(a: SampleSource, b: SampleSource): boolean {
    if (a.rootMeeting !== b.rootMeeting) {
        return false;
    }
    // Distinct transcript entries can occupy the same instant. A span-only legacy address
    // cannot disambiguate them and is held out conservatively.
    return a.lineKey === b.lineKey || a.spanKey === b.lineKey || b.spanKey === a.lineKey;
}

export function ownerKey(owner: VoiceOwner): string {
    return owner.email ? `email:${owner.email.toLowerCase()}` : `name:${owner.name}`;
}

const physicalSpanSchema = z.tuple([z.literal("span-v1"), z.string(), z.number(), z.number()]);
const recordingKeySchema = z.tuple([z.string(), z.string(), z.string()]);

function uncertainOverlap(a: SampleSource, b: SampleSource) {
    if (
        a.rootMeeting !== b.rootMeeting ||
        (a.lineKey.startsWith('["entry-v1",') && b.lineKey.startsWith('["entry-v1",'))
    ) {
        return false;
    }
    const address = (s: SampleSource) => physicalSpanSchema.safeParse(parseJSON(s.spanKey ?? s.lineKey));
    const left = address(a),
        right = address(b);
    if (!left.success || !right.success || left.data[2] >= right.data[3] || right.data[2] >= left.data[3]) {
        return false;
    }
    if (a.recordingKey === b.recordingKey) {
        return true;
    }
    const x = recordingKeySchema.safeParse(parseJSON(a.recordingKey));
    const y = recordingKeySchema.safeParse(parseJSON(b.recordingKey));
    return x.success && y.success && x.data[1] === y.data[1] && x.data[2] !== y.data[2];
}

export function refused(
    library: LibraryV2,
    source: SampleSource,
    owner: VoiceOwner
): Refusal | "ambiguous-source" | undefined {
    let reason: Refusal | "ambiguous-source" | undefined;
    for (const r of library.rejected) {
        if (r.reason === "wrong-person" && (!r.owner || !sameVoiceOwner(r.owner, owner))) {
            continue;
        }
        if (sameLine(r.source, source)) {
            if (r.reason !== "wrong-person") {
                return r.reason;
            }
            reason = r.reason;
        } else if (!reason && uncertainOverlap(r.source, source)) {
            reason = "ambiguous-source";
        }
    }
    return reason;
}

export function sameVoiceOwner(a: VoiceOwner, b: VoiceOwner): boolean {
    return a.email && b.email ? ownerKey(a) === ownerKey(b) : nameKey(a.name) === nameKey(b.name);
}

function readDocument(): LibraryV2 {
    const file = libraryFile();
    return existsSync(file)
        ? voiceLibrarySchema.parse(SafeJSON.parse(readFileSync(file, "utf8"), { strict: true }))
        : { version: 2, revision: 0, model: "", samples: [], rejected: [], imports: [], receipts: [] };
}

/** Field order and the null sentinels are part of the v1 ID format, independent of JSON key order. */
function importTuple(project: string, model: string, owner: VoiceOwner, p: VoicePrint): string {
    return SafeJSON.stringify([
        "meetings-voice-import-v1",
        project,
        owner.name,
        owner.email ?? null,
        model,
        p.meeting,
        p.sourceSha,
        p.seat,
        p.track,
        p.fromSec,
        p.toSec,
        p.embedding,
        p.confirmedAt,
        p.question ?? null,
    ]);
}

type IdDigest = NonNullable<MigrationOptions["idDigest"]>;
const defaultIdDigest: IdDigest = (tuple, occurrence) => sha256Json([tuple, occurrence]);

function importProject(input: {
    library: LibraryV2;
    manifest: Manifest;
    raw: z.infer<typeof legacyStoreSchema>;
    reserved: Set<SampleId>;
    idDigest: IdDigest;
}): number {
    const { library, manifest, raw, reserved, idDigest } = input;
    const known = new Map<string, Set<number>>();
    // Keep a row's original tuple even after a move or deletion. A digest alone cannot distinguish a true collision.
    for (const row of manifest.rows) {
        const occurrences = known.get(row.tuple) ?? new Set<number>();
        occurrences.add(row.occurrence);
        known.set(row.tuple, occurrences);
    }
    const counts = new Map<string, number>();
    const additions: Array<{ owner: VoiceOwner; print: VoicePrint; tuple: string; occurrence: number }> = [];
    for (const name of Object.keys(raw.people).sort()) {
        const { samples, email } = raw.people[name]!;
        const owner = email ? { name, email } : { name };
        for (const print of samples) {
            const tuple = importTuple(manifest.project, raw.model, owner, print);
            const occurrence = counts.get(tuple) ?? 0;
            counts.set(tuple, occurrence + 1);
            if (known.get(tuple)?.has(occurrence)) {
                continue;
            }
            additions.push({ owner, print, tuple, occurrence });
        }
    }
    // Choose the winner of a collision in canonical order. Append samples in the original numbered order below.
    const ids = new Map<(typeof additions)[number], SampleId>();
    const ordered = [...additions].sort((a, b) =>
        a.tuple < b.tuple ? -1 : a.tuple > b.tuple ? 1 : a.occurrence - b.occurrence
    );
    for (const row of ordered) {
        const digest = idDigest(row.tuple, row.occurrence);
        let id: SampleId = `vs_${digest}`;
        if (reserved.has(id)) {
            const suffix = defaultIdDigest(row.tuple, row.occurrence);
            id = `vs_${digest}_${suffix}`;
            for (let i = 1; reserved.has(id); i++) {
                id = `vs_${digest}_${suffix}_${i}`;
            }
        }
        reserved.add(id);
        ids.set(row, id);
    }
    for (const row of additions) {
        const { tuple, occurrence, owner, print } = row;
        const id = ids.get(row)!;
        manifest.rows.push({ tuple, tupleDigest: sha256Json(tuple), occurrence, id });
        library.samples.push({
            ...print,
            id,
            owner,
            project: manifest.project,
            origin: "legacy",
            acquiredBy: "migration",
            source: sourceForVoicePrint(print),
        });
    }
    return additions.length;
}

function recordedRoot(store: MeetingStore, id: string) {
    const record = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(id) ? store.read(id) : undefined;
    return record ? voiceRootMeeting(store, record) : id;
}

function reconcile(projects: string[], options: MigrationOptions) {
    const library = readDocument();
    const manifests = new Map(library.imports.map((entry) => [entry.project, entry]));
    const reserved = new Set([
        ...library.samples.map((s) => s.id),
        ...library.imports.flatMap((entry) => entry.rows.map((row) => row.id)),
    ]);
    const conflicts: VoiceLibrarySnapshot["conflicts"] = [];
    let imported = 0;
    let changed = false;
    for (const project of projects) {
        const file = join(toolDataDir("meetings", "voices"), `${project}.json`);
        const prior = manifests.get(project);
        try {
            projectNameSchema.parse(project);
            const bytes = readFileSync(file);
            const fileDigest = createHash("sha256").update(bytes).digest("hex");
            if (prior?.fileDigest === fileDigest) {
                continue;
            }
            const raw = legacyStoreSchema.parse(SafeJSON.parse(bytes.toString("utf8")));
            if (Object.values(raw.people).some((p) => p.samples.length > 0)) {
                if (!raw.model.trim() || (library.model && library.model !== raw.model)) {
                    throw new Error(
                        `Voice model conflict: found '${raw.model}', expected '${library.model || "a model identity"}'`
                    );
                }
                library.model = raw.model;
            }
            const manifest = prior ?? { project, fileDigest, rows: [] };
            imported += importProject({
                library,
                manifest,
                raw,
                reserved,
                idDigest: options.idDigest ?? defaultIdDigest,
            });
            manifest.fileDigest = fileDigest;
            if (!prior) {
                library.imports.push(manifest);
            }
            changed = true;
        } catch (error) {
            conflicts.push({ project, file, message: error instanceof Error ? error.message : String(error) });
        }
    }
    // v1 and early v2 used the immediate meeting as root. Correct proven parent chains in the
    // overlay too, so browsing and predicting never have to upgrade a file to exclude a copy.
    const store = new MeetingStore();
    const roots = new Map<string, string>();
    function canonical(source: SampleSource) {
        const id = source.rootMeeting;
        if (!roots.has(id)) {
            roots.set(id, recordedRoot(store, id));
        }
        const root = roots.get(id)!;
        if (root !== id) {
            source.rootMeeting = root;
            changed = true;
        }
    }
    for (const sample of [...library.samples, ...library.rejected]) {
        canonical(sample.source);
    }
    for (const receipt of library.receipts) {
        if (receipt.kind === "learn") {
            canonical(receipt.source);
        } else {
            for (const row of [
                ...receipt.before,
                ...receipt.after,
                ...receipt.addedRefusals,
                ...receipt.removedRefusals,
            ]) {
                canonical(row.source);
            }
        }
    }
    return { library, conflicts, imported, changed };
}

export function readVoiceLibrary(options: Pick<MigrationOptions, "idDigest"> = {}): VoiceLibrarySnapshot {
    const { library, conflicts } = reconcile(legacyProjects(), options);
    const book = new PeopleBook().read();
    return {
        library,
        conflicts,
        merges: book.merges,
        knownOwners: book.entries.map(({ name, email }) => ({ name, email })),
    };
}

function requireValid(input: ReturnType<typeof reconcile>): void {
    if (input.conflicts.length) {
        throw new Error(input.conflicts.map((c) => `${c.file}: ${c.message}`).join("\n"));
    }
}

/** Global first, then the exact arbiters used by older writers in filename order. Busy means retry the whole write. */
function withProjectLocks<T>(projects: string[], index: number, write: () => T): T {
    const project = projects[index];
    return project === undefined
        ? write()
        : withRecoverablePathArbitrationSync(legacyFile(project), () => withProjectLocks(projects, index + 1, write));
}

function transact<T>(
    edit: (library: LibraryV2) => { changed: boolean; result: T },
    options: MigrationOptions = {}
): { result: T; migration: MigrationReceipt } {
    const file = libraryFile();
    return withRecoverablePathArbitrationSync(file, () => {
        const projects = legacyProjects();
        return withProjectLocks(projects, 0, () => {
            const pending = reconcile(projects, options);
            requireValid(pending);
            const { library, imported } = pending;
            const editResult = edit(library);
            const changed = pending.changed || editResult.changed || !existsSync(file);
            if (changed) {
                library.revision++;
                voiceLibrarySchema.parse(library);
                const bytes = SafeJSON.stringify(library);
                const publish: NonNullable<MigrationOptions["publish"]> =
                    options.publish ?? ((path, data) => atomicWriteFileSync(path, data, { mode: 0o600 }));
                publish(file, bytes);
                if (readFileSync(file, "utf8") !== bytes) {
                    throw new Error(`Voice library publication did not verify at ${file}`);
                }
            }
            return { result: editResult.result, migration: { revision: library.revision, imported, changed } };
        });
    });
}

export function upgradeVoiceLibrary(options: MigrationOptions & { dryRun?: boolean } = {}): MigrationReceipt {
    if (options.dryRun) {
        const plan = reconcile(legacyProjects(), options);
        requireValid(plan);
        return {
            revision: plan.library.revision,
            imported: plan.imported,
            changed: plan.changed || !existsSync(libraryFile()),
        };
    }
    return transact(() => ({ changed: false, result: undefined }), options).migration;
}

/** The legacy reader sees only this project's display names, in its original per-person sample order. */
export function projectVoiceStore(project: string): VoiceStore {
    const file = legacyFile(project);
    if (!existsSync(libraryFile())) {
        return existsSync(file)
            ? voiceStoreSchema.parse(SafeJSON.parse(readFileSync(file, "utf8")))
            : { version: 1, model: "", people: {} };
    }
    const pending = reconcile(existsSync(file) ? [project] : [], {});
    if (pending.conflicts.length) {
        // A different-model source remains available on the legacy recovery path.
        return voiceStoreSchema.parse(SafeJSON.parse(readFileSync(file, "utf8")));
    }
    const { library } = pending;
    const people = new Map<string, { samples: VoicePrint[] }>();
    for (const sample of library.samples) {
        if (sample.project !== project || refused(library, sample.source, sample.owner)) {
            continue;
        }
        const person: { samples: VoicePrint[] } = people.get(sample.owner.name) ?? { samples: [] };
        person.samples.push(voicePrintSchema.parse(sample));
        people.set(sample.owner.name, person);
    }
    const manifest = library.imports.find((m) => m.project === project);
    if (!people.size && manifest?.rows.length === 0 && existsSync(file)) {
        // An empty legacy project's declared model is local metadata; it never elects the library's model.
        const empty = voiceStoreSchema.parse(SafeJSON.parse(readFileSync(file, "utf8")));
        if (Object.values(empty.people).every((person) => !person.samples.length)) {
            return empty;
        }
    }
    const model = people.size || manifest?.rows.length ? library.model : "";
    return { version: 1, model, people: Object.fromEntries(people) };
}

/** Only explicit directory merges group different owner keys. A name-only print cannot pick between two addresses. */
export function groupedOwners(view: VoiceLibrarySnapshot) {
    type Group = { owner: VoiceOwner; keys: Set<string>; aliases: Set<string> };
    const byKey = new Map<string, Group>();
    const byAlias = new Map<string, Set<Group>>();
    for (const merge of view.merges) {
        const keys = new Set<string>();
        const aliases = new Set([nameKey(merge.name)]);
        for (const ref of merge.people) {
            const key = ownerKey(ref);
            const candidates = !ref.email ? byAlias.get(nameKey(ref.name)) : undefined;
            const previous = byKey.get(key) ?? (candidates?.size === 1 ? candidates.values().next().value : undefined);
            if (!previous) {
                keys.add(key);
                continue;
            }
            for (const member of previous.keys) {
                keys.add(member);
            }
            for (const alias of previous.aliases) {
                aliases.add(alias);
                byAlias.get(alias)?.delete(previous);
            }
        }
        const owner = { name: merge.name };
        const group = { owner, keys, aliases };
        for (const key of keys) {
            byKey.set(key, group);
        }
        for (const alias of aliases) {
            const groups = byAlias.get(alias) ?? new Set<Group>();
            groups.add(group);
            byAlias.set(alias, groups);
        }
    }
    const binding = (owner: VoiceOwner) => byKey.get(ownerKey(owner)) ?? ownerKey(owner);
    const names = new Map<string, Set<Group | string>>();
    for (const owner of [
        ...view.knownOwners,
        ...view.library.samples.map((s) => s.owner),
        ...view.merges.flatMap((m) => m.people),
    ]) {
        const name = nameKey(owner.name);
        const candidates = names.get(name) ?? new Set<Group | string>(byAlias.get(name));
        candidates.add(binding(owner));
        names.set(name, candidates);
    }
    // A name from the meeting roster can select an addressed person only if that name has one possible binding.
    function select(owner: VoiceOwner) {
        if (owner.email) {
            return binding(owner);
        }
        const name = nameKey(owner.name);
        const candidates = names.get(name) ?? byAlias.get(name);
        return candidates?.size === 1 ? candidates.values().next().value : undefined;
    }
    return { binding, select };
}

export function inScope(sample: VoiceSample, scope: VoiceScope): boolean {
    return (
        scope.kind === "all" ||
        (scope.kind === "meeting" ? sample.meeting === scope.meeting : sample.project === scope.project)
    );
}

export interface VoicePersonRow {
    owner: VoiceOwner;
    projects: string[];
    samples: Omit<VoiceSample, "embedding">[];
}

export function voicesIn(view: VoiceLibrarySnapshot, scope: VoiceScope, owner?: VoiceOwner): VoicePersonRow[] {
    const directory = groupedOwners(view);
    const selected = owner && (directory.select(owner) ?? directory.binding(owner));
    type Row = { owner: VoiceOwner; projects: Set<string>; samples: VoicePersonRow["samples"] };
    const groups = new Map<object | string, Row>();
    for (const sample of view.library.samples) {
        if (!inScope(sample, scope) || refused(view.library, sample.source, sample.owner)) {
            continue;
        }
        const key = directory.binding(sample.owner);
        if (selected && selected !== key) {
            continue;
        }
        const row: Row = groups.get(key) ?? {
            owner: typeof key === "string" ? sample.owner : key.owner,
            projects: new Set(),
            samples: [],
        };
        const { embedding: _embedding, ...listed } = sample;
        row.projects.add(sample.project);
        row.samples.push(listed);
        groups.set(key, row);
    }
    return [...groups.values()].map((row) => ({ ...row, projects: [...row.projects].sort() }));
}

export type TargetSource = SampleSource & { fromSec?: number; toSec?: number };
export interface PredictionPrints {
    model: string;
    samples: VoiceSample[];
    conflicts: VoiceLibrarySnapshot["conflicts"];
}

export function overlapsVoiceSource(sample: VoiceSample, target: TargetSource): boolean {
    return (
        sameLine(sample.source, target) ||
        (sample.source.rootMeeting === target.rootMeeting &&
            sample.source.recordingKey === target.recordingKey &&
            target.fromSec !== undefined &&
            target.toSec !== undefined &&
            sample.fromSec < target.toSec &&
            target.fromSec < sample.toSec)
    );
}

/** The existing CLI readiness and removal-preview APIs are synchronous. Parse the same saved settings as the pass. */
export function predictionScope(): VoiceScopeSettings["sampleScope"] {
    const file = new MeetingsConfigStore().path;
    return meetingsConfigSchema.parse(existsSync(file) ? SafeJSON.parse(readFileSync(file, "utf8")) : {}).global
        .speakerLabels.voice.sampleScope;
}

export function predictionPrints(input: {
    project: string;
    scope?: VoiceScopeSettings["sampleScope"];
    target?: TargetSource;
    owners?: readonly VoiceOwner[];
    view?: VoiceLibrarySnapshot;
}): PredictionPrints {
    projectNameSchema.parse(input.project);
    const view = input.view ?? readVoiceLibrary();
    const { library, conflicts } = view;
    const directory = groupedOwners(view);
    const eligible = input.owners && new Set(input.owners.map(directory.select));
    const scope = input.scope ?? predictionScope();
    const samples = library.samples.filter(
        (sample) =>
            (scope === "all" || sample.project === input.project) &&
            (!eligible || eligible.has(directory.binding(sample.owner))) &&
            (!input.target || !overlapsVoiceSource(sample, input.target)) &&
            !refused(library, sample.source, sample.owner)
    );
    return { model: library.model, samples, conflicts };
}

export interface ConfirmedSampleInput {
    project: string;
    owner: VoiceOwner;
    print: VoicePrint;
    model: string;
    source: SampleSource;
    origin: Origin;
    acquiredBy: Exclude<VoiceSample["acquiredBy"], "migration">;
    decision?: { token: string; item: string };
}
export type InsertReceipt =
    | { status: "added" | "already-present" | "conflict"; id: SampleId; revision: number }
    | { status: "refused"; reason: Refusal | "ambiguous-source"; revision: number };

function insertLocked(
    library: LibraryV2,
    input: ConfirmedSampleInput,
    replace: boolean
): {
    changed: boolean;
    result: InsertReceipt;
} {
    const project = projectNameSchema.parse(input.project);
    const owner = ownerSchema.parse(input.owner);
    const print = voicePrintSchema.parse(input.print);
    const source = sourceSchema.parse(input.source);
    if (source.rootMeeting === print.meeting && !source.spanKey) {
        source.rootMeeting = recordedRoot(new MeetingStore(), source.rootMeeting);
    }
    const model = nonblank.parse(input.model);
    if (library.model && library.model !== model) {
        throw new Error(
            `Voice model changed: project '${project}' supplied '${model}', library uses '${library.model}'`
        );
    }
    const reason = refused(library, source, owner);
    if (reason) {
        return { changed: false, result: { status: "refused", reason, revision: library.revision } };
    }
    const requestDigest = sha256Json([importTuple(project, model, owner, print), source, input.origin]);
    const decision = input.decision;
    let recoveredId: SampleId | undefined;
    if (decision) {
        const receipt = library.receipts.find(
            (r) =>
                r.kind === "learn" &&
                r.project === project &&
                r.token === decision.token &&
                r.item === decision.item &&
                sameLine(r.source, source) &&
                ownerKey(r.owner) === ownerKey(owner)
        );
        if (receipt?.kind === "learn") {
            recoveredId = receipt.id;
            const present = library.samples.some((s) => s.id === receipt.id && ownerKey(s.owner) === ownerKey(owner));
            if (
                receipt.requestDigest !== requestDigest ||
                present ||
                library.samples.some((s) => s.id === receipt.id)
            ) {
                return {
                    changed: false,
                    result: {
                        status: present && receipt.requestDigest === requestDigest ? "already-present" : "conflict",
                        id: receipt.id,
                        revision: receipt.revision,
                    },
                };
            }
        }
    }
    if (input.acquiredBy === "backfill" || (source.spanKey && !replace)) {
        const existing = library.samples.find(
            (s) =>
                s.project === project &&
                sameVoiceOwner(s.owner, owner) &&
                (sameLine(s.source, source) ||
                    (input.acquiredBy === "backfill" &&
                        voicePrintKey(owner.name, s) === voicePrintKey(owner.name, print)))
        );
        if (existing) {
            return {
                changed: false,
                result: { status: "already-present", id: existing.id, revision: library.revision },
            };
        }
    }
    const matches = library.samples.filter(
        (s) =>
            s.project === project &&
            ownerKey(s.owner) === ownerKey(owner) &&
            s.meeting === print.meeting &&
            s.track === print.track &&
            s.sourceSha === print.sourceSha &&
            s.fromSec === print.fromSec &&
            s.toSec === print.toSec
    );
    const prior = matches[0];
    if (prior && matches.length > 1) {
        return { changed: false, result: { status: "conflict", id: prior.id, revision: library.revision } };
    }
    const occupied = library.samples.find(
        (s) =>
            sameLine(s.source, source) && ownerKey(s.owner) !== ownerKey(owner) && !refused(library, s.source, s.owner)
    );
    if (occupied) {
        return { changed: false, result: { status: "conflict", id: occupied.id, revision: library.revision } };
    }
    const unchanged =
        prior &&
        sameLine(prior.source, source) &&
        importTuple(project, model, owner, prior) === importTuple(project, model, owner, print);
    if (prior && !replace) {
        // A second decision finding an existing print must not gain an Undo receipt for the first decision's work.
        return {
            changed: false,
            result: { status: unchanged ? "already-present" : "conflict", id: prior.id, revision: library.revision },
        };
    }
    const id: SampleId = prior?.id ?? recoveredId ?? `vs_${randomUUID()}`;
    const writeSample = !unchanged;
    const changed = writeSample || !!decision;
    const nextRevision = changed ? library.revision + 1 : library.revision;
    if (writeSample) {
        if (prior) {
            library.samples = library.samples.filter((s) => s.id !== prior.id);
        }
        library.model = model;
        library.samples.push({
            ...print,
            id,
            owner,
            project,
            source,
            origin: input.origin,
            acquiredBy: input.acquiredBy,
        });
    }
    if (decision) {
        // A plain removal permits recovery. Replace its old learning receipt with the newly committed attachment.
        library.receipts = library.receipts.filter(
            (r) =>
                !(
                    r.kind === "learn" &&
                    r.project === project &&
                    r.token === decision.token &&
                    r.item === decision.item &&
                    sameLine(r.source, source) &&
                    ownerKey(r.owner) === ownerKey(owner)
                )
        );
        library.receipts.push({
            kind: "learn",
            ...decision,
            project,
            owner,
            source,
            id,
            revision: nextRevision,
            requestDigest,
        });
    }
    return { changed, result: { status: writeSample ? "added" : "already-present", id, revision: nextRevision } };
}

export function insertVoiceSample(input: ConfirmedSampleInput): InsertReceipt {
    return transact((library) => insertLocked(library, input, false)).result;
}

export interface OwnedVoicePrint {
    project: string;
    owner: VoiceOwner;
    model: string;
    print: VoicePrint;
    before?: VoicePrint;
    source?: SampleSource;
    id?: SampleId;
    token?: string;
}

/** A journal and its sidecar publish one batch while the caller holds the meeting lock. */
export function changeVoiceLearning(options: {
    remove?: readonly OwnedVoicePrint[];
    add: readonly ConfirmedSampleInput[];
    dryRun?: boolean;
}) {
    function edit(library: LibraryV2) {
        const beforeModel = library.model;
        const beforeSamples = [...library.samples];
        const beforeReceipts = [...library.receipts];
        for (const owned of options.remove ?? []) {
            const priorReceipt = library.receipts.findLast(
                (r) =>
                    r.kind === "learn" &&
                    r.token === owned.token &&
                    r.project === owned.project &&
                    sameVoiceOwner(r.owner, owned.owner) &&
                    (r.id === owned.id ||
                        (r.item === owned.print.question &&
                            sameLine(r.source, owned.source ?? sourceForVoicePrint(owned.print))))
            );
            if (priorReceipt?.kind === "learn" && priorReceipt.active !== false) {
                library.receipts = library.receipts.map((r) =>
                    r === priorReceipt ? { ...priorReceipt, active: false, revision: library.revision + 1 } : r
                );
            }
            const matches = library.samples.filter(
                (s) =>
                    !s.transferred &&
                    (!owned.id || s.id === owned.id) &&
                    s.project === owned.project &&
                    sameVoiceOwner(s.owner, owned.owner) &&
                    isDeepStrictEqual(voicePrintSchema.parse(s), voicePrintSchema.parse(owned.print))
            );
            const sample = matches[0];
            if (matches.length !== 1 || !sample) {
                continue;
            }
            const receipt = library.receipts.findLast((r) => r.kind === "learn" && r.id === sample.id);
            if (receipt && receipt.token !== owned.token) {
                continue;
            }
            library.samples = library.samples.filter((s) => s.id !== sample.id);
            if (owned.before) {
                insertLocked(
                    library,
                    {
                        project: owned.project,
                        owner: owned.owner,
                        model: owned.model,
                        print: owned.before,
                        source: sourceForVoicePrint(owned.before, sample.source.rootMeeting),
                        origin: "legacy",
                        acquiredBy: "live",
                    },
                    false
                );
            }
        }
        const results = options.add.map((input) => insertLocked(library, input, false).result);
        const previousSamples = new Set(beforeSamples),
            currentSamples = new Set(library.samples);
        const previousReceipts = new Set(beforeReceipts),
            currentReceipts = new Set(library.receipts);
        const inserted = library.samples.filter((s) => !previousSamples.has(s));
        const removed = beforeSamples.filter((s) => !currentSamples.has(s));
        const newReceipts = library.receipts.filter((r) => !previousReceipts.has(r));
        const oldReceipts = beforeReceipts.filter((r) => !currentReceipts.has(r));
        const changed = !!(inserted.length || removed.length || newReceipts.length || oldReceipts.length);
        const rollback = () => {
            if (!changed || options.dryRun) {
                return;
            }
            transact((current) => {
                // Only this batch's versions may be put back if a different process corrected a binding meanwhile.
                for (const s of inserted) {
                    const index = current.samples.findIndex((row) => isDeepStrictEqual(row, s));
                    if (index >= 0) {
                        current.samples.splice(index, 1);
                    }
                }
                for (const s of removed) {
                    if (
                        !current.samples.some((row) => row.id === s.id || sameLine(row.source, s.source)) &&
                        !refused(current, s.source, s.owner)
                    ) {
                        current.samples.splice(beforeSamples.indexOf(s), 0, s);
                    }
                }
                current.receipts = current.receipts.filter((r) => !newReceipts.some((n) => isDeepStrictEqual(n, r)));
                current.receipts.push(
                    ...oldReceipts.filter(
                        (old) =>
                            !current.receipts.some(
                                (r) =>
                                    r.kind === "learn" &&
                                    old.kind === "learn" &&
                                    r.id === old.id &&
                                    r.token === old.token
                            )
                    )
                );
                if (!current.samples.length) {
                    current.model = beforeModel;
                }
                return { changed: true, result: undefined };
            });
        };
        return { changed, result: { results, rollback } };
    }
    if (!options.add.length && !options.remove?.length) {
        return { results: [], rollback: () => {} };
    }
    return options.dryRun ? edit(readVoiceLibrary().library).result : transact(edit).result;
}

type StoredCorrection = Extract<VoiceReceipt, { kind: "correct" }>;
export type VoiceCorrection = (
    | { kind: "remove"; ids: SampleId[] }
    | { kind: "move"; id: SampleId; to: VoiceOwner }
    | { kind: "reject"; id: SampleId; reason: Refusal }
    | { kind: "revert"; correction: string }
) & {
    token?: string;
    resolvedSource?: SampleSource;
    expectedRevision?: number;
    expectedIds?: SampleId[];
    impact?: StoredCorrection["impact"];
};

function correctionEdit(library: LibraryV2, action: VoiceCorrection) {
    const { token = randomUUID(), expectedRevision, expectedIds, impact, resolvedSource, ...operation } = action;
    const requestDigest = sha256Json(operation);
    const previous = library.receipts.find((r) => r.kind === "correct" && r.token === token);
    if (previous?.kind === "correct") {
        if (previous.requestDigest !== requestDigest) {
            throw new Error("Correction token belongs to a different request.");
        }
        return { changed: false, result: previous };
    }
    if (expectedRevision !== undefined && expectedRevision !== library.revision) {
        throw new Error("Stale voice library preview. Preview the current selection.");
    }
    const receipt: StoredCorrection = {
        kind: "correct",
        token,
        requestDigest,
        revision: library.revision + 1,
        ...(impact ? { impact } : {}),
        before: [],
        after: [],
        positions: [],
        removedRefusals: [],
        addedRefusals: [],
    };
    let restoreAt: number[] | undefined;
    if (action.kind === "revert") {
        const original = library.receipts.find((r) => r.kind === "correct" && r.token === action.correction);
        if (original?.kind !== "correct") {
            throw new Error("Unknown voice correction token.");
        }
        const sources = [
            ...original.before,
            ...original.after,
            ...original.addedRefusals,
            ...original.removedRefusals,
        ].map((s) => s.source);
        const release =
            original.after.length === 0 && original.addedRefusals.length > 0 && !original.removedRefusals.length;
        const superseded = library.receipts.some(
            (r) =>
                r.revision > original.revision &&
                (r.kind === "correct" ? [...r.before, ...r.after] : [r]).some((s) =>
                    sources.some((src) => sameLine(src, s.source))
                )
        );
        if (
            (!release && superseded) ||
            original.after.some((s) => !library.samples.some((row) => isDeepStrictEqual(row, s))) ||
            original.addedRefusals.some((r) => !library.rejected.some((row) => isDeepStrictEqual(row, r)))
        ) {
            throw new Error("Stale voice correction. The sample has changed since this action.");
        }
        receipt.before = original.after;
        // Releasing this refusal is still possible after its confirmation was undone. It does
        // not give the withdrawn decision ownership again or displace a later confirmed owner.
        receipt.after = release
            ? original.before.filter(
                  (sample) =>
                      !library.receipts.some(
                          (r) =>
                              r.revision > original.revision &&
                              (r.kind === "learn"
                                  ? sameLine(r.source, sample.source)
                                  : [...r.before, ...r.after, ...r.addedRefusals].some((s) =>
                                        sameLine(s.source, sample.source)
                                    ))
                      ) &&
                      !library.samples.some(
                          (s) => sameLine(s.source, sample.source) && !sameVoiceOwner(s.owner, sample.owner)
                      )
              )
            : original.before;
        receipt.removedRefusals = original.addedRefusals;
        receipt.addedRefusals = original.removedRefusals;
        restoreAt =
            original.positions &&
            receipt.after.map((s) => original.positions![original.before.findIndex((row) => row.id === s.id)]!);
    } else {
        const ids = new Set(action.kind === "remove" ? action.ids : [action.id]);
        receipt.before = library.samples.filter((s) => ids.has(s.id));
        if (!ids.size || receipt.before.length !== ids.size) {
            throw new Error("Stale voice sample selection.");
        }
        const first = receipt.before[0]!;
        if (action.kind !== "remove") {
            const source = resolvedSource ?? first.source;
            if (!sameLine(source, first.source) || source.recordingKey !== first.source.recordingKey) {
                throw new Error("Stale voice source. Preview the current recording.");
            }
            const reason = action.kind === "move" ? "wrong-person" : action.reason;
            const rejection = {
                source,
                reason,
                token,
                at: new Date().toISOString(),
                ...(reason === "wrong-person" ? { owner: first.owner } : {}),
            };
            receipt.addedRefusals.push(rejection);
            if (action.kind === "move") {
                const to = ownerSchema.parse(action.to);
                if (
                    sameVoiceOwner(to, first.owner) ||
                    library.samples.some(
                        (s) => s.id !== first.id && sameLine(s.source, source) && sameVoiceOwner(s.owner, to)
                    )
                ) {
                    throw new Error("Voice attachment conflict at destination.");
                }
                receipt.after = [{ ...first, source, owner: to, transferred: true }];
            }
            // A source-wide refusal affects every attachment, including a late legacy import from another project.
            receipt.before = library.samples.filter(
                (s) => sameLine(s.source, source) && (reason !== "wrong-person" || sameVoiceOwner(s.owner, first.owner))
            );
        }
    }
    const affectedIds = [...new Set([...receipt.before, ...receipt.after].map((s) => s.id))];
    if (expectedIds && !isDeepStrictEqual(affectedIds, expectedIds)) {
        throw new Error("Stale voice correction preview. The affected samples changed.");
    }
    receipt.positions = receipt.before.map((s) => library.samples.findIndex((row) => row.id === s.id));
    const replaced = new Set(receipt.before.map((s) => s.id));
    library.samples = library.samples.filter((s) => !replaced.has(s.id));
    library.rejected = library.rejected.filter(
        (row) => !receipt.removedRefusals.some((r) => isDeepStrictEqual(r, row))
    );
    if (
        action.kind === "revert" &&
        receipt.addedRefusals.some((r) =>
            library.samples.some((s) => sameLine(r.source, s.source) && (!r.owner || sameVoiceOwner(r.owner, s.owner)))
        )
    ) {
        throw new Error("Stale voice correction. A new attachment occupies this source.");
    }
    library.rejected.push(...receipt.addedRefusals);
    for (const [i, sample] of receipt.after.entries()) {
        if (
            !sample.transferred &&
            library.receipts.some(
                (r) =>
                    r.kind === "learn" &&
                    r.id === sample.id &&
                    r.active === false &&
                    sameVoiceOwner(r.owner, sample.owner)
            )
        ) {
            throw new Error("Stale voice correction. The confirmation no longer owns this sample.");
        }
        const reason = refused(library, sample.source, sample.owner);
        if (reason) {
            throw new Error(`Voice sample refused: ${reason}`);
        }
        if (
            library.samples.some(
                (s) =>
                    s.id === sample.id ||
                    (sameLine(s.source, sample.source) &&
                        !replaced.has(s.id) &&
                        !receipt.after.some((restored) => restored.id === s.id))
            )
        ) {
            throw new Error("Voice attachment conflict at destination.");
        }
        library.samples.splice(restoreAt?.[i] ?? receipt.positions[i] ?? library.samples.length, 0, sample);
    }
    library.receipts.push(receipt);
    return { changed: true, result: receipt };
}

export function previewVoiceCorrection(library: LibraryV2, action: VoiceCorrection) {
    return correctionEdit(structuredClone(library), action).result;
}

export function correctVoiceSample(action: VoiceCorrection) {
    return transact((library) => correctionEdit(library, action)).result;
}

export function voicePrintKey(person: string, print: VoicePrint): string {
    return SafeJSON.stringify([nameKey(person), print.meeting, print.sourceSha, print.fromSec, print.toSec]);
}

function requireUnambiguousName(library: LibraryV2, project: string, name: string): void {
    const owners = new Set(
        library.samples.filter((s) => s.project === project && s.owner.name === name).map((s) => ownerKey(s.owner))
    );
    if (owners.size > 1) {
        throw new Error(`More than one person named '${name}' in project '${project}'; select a sample ID`);
    }
}

/** The old add/backfill pair remains a single atomic transaction, including its missing-at-preview check. */
export function addProjectVoicePrints(input: {
    project: string;
    changes: readonly { person: string; after: VoicePrint; model?: string }[];
    requireMissing: boolean;
    defaultModel: () => string;
}): void {
    if (!input.changes.length) {
        return;
    }
    const project = projectNameSchema.parse(input.project);
    transact((library) => {
        if (input.requireMissing) {
            const keys = new Set(
                library.samples.filter((s) => s.project === project).map((s) => voicePrintKey(s.owner.name, s))
            );
            if (input.changes.some((c) => keys.has(voicePrintKey(c.person, c.after)))) {
                throw new Error("The project's voice samples changed during backfill. Retry to count the new samples.");
            }
        }
        let changed = false;
        for (const change of input.changes) {
            requireUnambiguousName(library, project, change.person);
            const insertion = insertLocked(
                library,
                {
                    project,
                    owner: { name: change.person },
                    print: change.after,
                    model: change.model ?? (library.model || input.defaultModel()),
                    source: sourceForVoicePrint(change.after),
                    origin: "legacy",
                    acquiredBy: input.requireMissing ? "backfill" : "live",
                },
                true
            );
            if (insertion.result.status === "refused") {
                throw new Error(`Voice sample refused: ${insertion.result.reason}`);
            }
            if (insertion.result.status === "conflict") {
                throw new Error(
                    `Voice attachment conflict in project '${project}' at ${insertion.result.id}; select a sample ID`
                );
            }
            changed ||= insertion.changed;
        }
        return { changed, result: undefined };
    });
}

/** What names one print in a person's samples: its meeting, source file, track and interval. */
export type VoicePrintIdentity = Pick<VoicePrint, "meeting" | "sourceSha" | "seat" | "track" | "fromSec" | "toSec">;

function sameVoicePrint(a: VoicePrintIdentity, b: VoicePrintIdentity): boolean {
    return (
        a.meeting === b.meeting &&
        a.sourceSha === b.sourceSha &&
        a.seat === b.seat &&
        a.track === b.track &&
        a.fromSec === b.fromSec &&
        a.toSec === b.toSec
    );
}

/** Removes the one print `at` names (another track or end at the same start stays), or every print of the person. */
export function removeProjectVoicePrint(project: string, person: string, at?: VoicePrintIdentity): number {
    projectNameSchema.parse(project);
    return transact((library) => {
        requireUnambiguousName(library, project, person);
        const before = library.samples.length;
        library.samples = library.samples.filter(
            (s) => !(s.project === project && s.owner.name === person && (!at || sameVoicePrint(s, at)))
        );
        const removed = before - library.samples.length;
        return { changed: removed > 0, result: removed };
    }).result;
}
