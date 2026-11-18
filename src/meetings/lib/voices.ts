import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { sha256FileAsync } from "@genesiscz/utils/fs/hash";
import { sha256Json } from "@genesiscz/utils/hash";
import { logger } from "@genesiscz/utils/logger";
import { type MeetingsConfig, MeetingsConfigStore } from "@genesiscz/utils/meetings/config";
import type { MeetingRecord, MeetingStore } from "@genesiscz/utils/meetings/record";
import { voiceRootMeeting } from "@genesiscz/utils/meetings/record";
import { MeetingRule } from "@genesiscz/utils/meetings/rules";
import { roomSeatNames, seatIntervalsFor } from "@genesiscz/utils/meetings/seats";
import type { VoiceProgress } from "@genesiscz/utils/meetings/voice";
import {
    type ConfirmedSampleInput,
    changeVoiceLearning,
    correctVoiceSample,
    groupedOwners,
    inScope,
    meetingVoiceOwner,
    predictionScope,
    previewVoiceCorrection,
    readVoiceLibrary,
    refused,
    type SampleId,
    sourceForVoicePrint,
    type VoiceCorrection,
    type VoiceLibrarySnapshot,
    type VoiceOwner,
    type VoiceSample,
    type VoiceScope,
    voiceLineKeys,
    voicesIn,
} from "@genesiscz/utils/meetings/voice-library";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/atomic-file";
import { TranscriptLines } from "@genesiscz/utils/transcribe/lines";
import { sameName } from "@genesiscz/utils/transcribe/speakers";
import { OpenedMeeting } from "./opened-meeting";
import {
    type MeetingSound,
    measureSoundClock,
    meetingSound,
    readSoundInputs,
    type Seat,
    type SoundSlice,
} from "./sound";
import type { LinkedSource } from "./sources";
import { proposeSpeakerLabels } from "./speaker-labels";
import type { LineLabel } from "./speaker-labels/types";
import { embedSeatLines, voiceProgressForMeeting, voiceSignalForMeeting } from "./speaker-labels/voice";
import { runSuggest } from "./suggest-run";
import { correctTranscript } from "./transcript-corrections";
import { learntVoices } from "./voice-quality";

const { log } = logger.scoped("meetings-voices");

export interface VoicesAccess {
    store: MeetingStore;
    linkedSource?: (record: MeetingRecord) => LinkedSource | undefined;
    config?: () => Promise<MeetingsConfig>;
}

export interface VoiceSampleRow extends Omit<VoiceSample, "embedding" | "sourceSha" | "transferred"> {
    sample: number;
    words: string;
    title?: string;
    transferred: boolean;
    available: boolean;
}
export interface VoicePersonRow {
    project: string;
    projects: string[];
    person: string;
    owner: VoiceOwner;
    meetings: string[];
    samples: VoiceSampleRow[];
}
type Browse = { project?: string; scope?: VoiceScope; person?: string };

function explicitScope(options: Browse): VoiceScope {
    if (
        options.project !== undefined &&
        options.scope &&
        (options.scope.kind !== "project" || options.scope.project !== options.project)
    ) {
        throw new Error("Conflicting voice scopes.");
    }
    return (
        options.scope ??
        (options.project !== undefined ? { kind: "project", project: options.project } : { kind: "all" })
    );
}

function openedOf(access: VoicesAccess, record: MeetingRecord): OpenedMeeting {
    return OpenedMeeting.of(access.store, record, access.linkedSource?.(record));
}

function recordOf(access: VoicesAccess, meeting: string): MeetingRecord {
    const record = access.store.resolve(meeting);

    if (!record) {
        throw new Error(`No meeting "${meeting}".`);
    }

    return record;
}

/** Clock measurement belongs to an explicit writer; a preview keeps it in memory. */
export async function voiceReadMeeting(opened: OpenedMeeting): Promise<OpenedMeeting> {
    const inputs = await readSoundInputs(opened);
    let sound = meetingSound(inputs);

    if (!inputs.clock && inputs.tracks === "best" && sound.tracks.some((track) => track.clock === "stamp")) {
        const measured = await measureSoundClock(inputs);

        if (measured) {
            sound = meetingSound({ ...inputs, clock: measured.clock });
        }
    }

    // The base labeler measures and saves a stamp it sees. Its slice still refuses an unmeasured recorder track.
    const readOnly: MeetingSound = {
        tracks: sound.tracks.filter((track) => track.clock !== "stamp"),
        slice: sound.slice,
    };
    opened.sound = async () => readOnly;
    return opened;
}

export async function listProjectVoices(options: VoicesAccess & Browse) {
    const scope = explicitScope(options);
    const view = readVoiceLibrary();
    const listing = options.project && !options.scope ? { ...view, merges: [] } : view;
    const selected = voicesIn(listing, scope).filter(
        (row) =>
            !options.person ||
            sameName(row.owner.name, options.person) ||
            row.samples.some((s) => sameName(s.owner.name, options.person!))
    );
    const records = options.store.listBounded({
        where: (record) =>
            scope.kind === "meeting"
                ? record.id === scope.meeting
                : scope.kind !== "project" || record.project === scope.project,
    }).records;
    const openedMeetings = new Map<string, OpenedMeeting>();
    const people: VoicePersonRow[] = [];
    const directory = groupedOwners(listing);
    for (const group of selected) {
        const samples: VoiceSampleRow[] = [];
        for (const [index, { sourceSha: _sha, ...sample }] of group.samples.entries()) {
            let words = "";
            let available = false;
            const record = options.store.read(sample.meeting);
            if (record) {
                try {
                    const opened = openedMeetings.get(record.id) ?? openedOf(options, record);
                    openedMeetings.set(record.id, opened);
                    available = !!(await opened.sound()).slice({ ...sample, purpose: "listen" });
                    const lines = new TranscriptLines((await opened.meeting()).transcript);
                    words = lines.entries
                        .filter((_entry, at) => {
                            const span = lines.span(at);
                            return span && span.fromSec < sample.toSec && span.toSec > sample.fromSec;
                        })
                        .map((entry) => entry.text)
                        .join(" ");
                } catch (error) {
                    log.debug({ error, meeting: sample.meeting }, "voice sample source unavailable");
                }
            }
            samples.push({
                ...sample,
                sample: index + 1,
                words,
                available,
                transferred: !!sample.transferred,
                title: record?.title,
            });
        }
        people.push({
            person: group.owner.name,
            owner: group.owner,
            projects: group.projects,
            project: group.projects.length === 1 ? group.projects[0]! : "",
            samples,
            meetings: [...new Set(samples.map((s) => s.meeting))],
        });
    }
    for (const record of records) {
        const names = new Set([
            ...record.participants.map((p) => p.name),
            ...roomSeatNames(record.seats),
            ...(record.seats?.remote.map((p) => p.name) ?? []),
        ]);
        for (const name of names) {
            if (options.person && !sameName(options.person, name)) {
                continue;
            }
            const ref = meetingVoiceOwner(record, name);
            const binding = directory.select(ref) ?? directory.binding(ref);
            let row = people.find((p) => (directory.select(p.owner) ?? directory.binding(p.owner)) === binding);
            if (!row) {
                row = {
                    person: name,
                    owner: ref,
                    project: record.project ?? "",
                    projects: [],
                    meetings: [],
                    samples: [],
                };
                people.push(row);
            }
            if (record.project && !row.projects.includes(record.project)) {
                row.projects.push(record.project);
            }
            if (!row.meetings.includes(record.id)) {
                row.meetings.push(record.id);
            }
        }
    }
    const { learnt } = await voiceQuality(options, view);
    return { people: people.sort((a, b) => a.person.localeCompare(b.person)), learnt, conflicts: view.conflicts };
}

export async function voiceQuality(options: VoicesAccess & Browse, view = readVoiceLibrary()) {
    const scope = explicitScope(options);
    const directory = groupedOwners(view);
    const selected = options.person && directory.select({ name: options.person });
    const config = await (options.config?.() ?? new MeetingsConfigStore().read());
    const library = view.library;
    // Neighbors are measured in the same browsing scope, including when just one person's rows are requested.
    const learnt = learntVoices(
        {
            model: library.model,
            conflicts: view.conflicts,
            samples: library.samples.filter((s) => inScope(s, scope) && !refused(library, s.source, s.owner)),
        },
        { ...config.global.speakerLabels.voice, directory }
    ).filter(
        (group) =>
            !options.person ||
            (selected ? directory.binding(group.owner) === selected : sameName(group.owner.name, options.person))
    );
    return { learnt };
}

export async function previewVoices(
    options: VoicesAccess & { meeting: string; onProgress?: VoiceProgress; signal?: AbortSignal }
): Promise<{
    meeting: string;
    project?: string;
    lines: Array<LineLabel & { fromSec: number; toSec: number; text: string; current: string }>;
}> {
    const record = recordOf(options, options.meeting);
    const opened = await voiceReadMeeting(openedOf(options, record));
    if (options.onProgress) {
        voiceProgressForMeeting.set(opened, options.onProgress);
    }

    if (options.signal) {
        voiceSignalForMeeting.set(opened, options.signal);
    }

    const config = await (options.config?.() ?? opened.config());
    const meeting = await opened.meeting();
    const lines = new TranscriptLines(meeting.transcript);
    const corrected = correctTranscript({
        record,
        transcript: meeting.transcript,
        config,
        format: "json",
        withSuggested: true,
    });
    const labels = await proposeSpeakerLabels(opened, config.global.speakerLabels, undefined, {
        voiceOnly: true,
        applyAbove: config.global.suggest.applyAbove,
    });
    return {
        meeting: record.id,
        ...(record.project ? { project: record.project } : {}),
        lines: labels
            .filter((label) => label.labeler === "voice")
            .flatMap((label) => {
                const span = lines.span(label.index);
                const entry = meeting.transcript[label.index];
                return span && entry
                    ? [
                          {
                              ...label,
                              ...span,
                              text: entry.text,
                              current:
                                  corrected.entries.find(
                                      (current) =>
                                          current.sourceIndex === label.index ||
                                          (entry.id !== undefined && current.id === entry.id) ||
                                          (entry.startSec !== undefined && current.startSec === entry.startSec)
                                  )?.speaker ?? entry.speaker,
                          },
                      ]
                    : [];
            }),
    };
}

export async function applyVoices(
    options: VoicesAccess & { meeting: string; onProgress?: VoiceProgress; signal?: AbortSignal }
): Promise<{ meeting: string; added: number; warnings: string[] }> {
    const record = recordOf(options, options.meeting);

    if (!record.project) {
        throw new Error("Choose a project before naming voices.");
    }

    const result = await runSuggest({
        store: options.store,
        record,
        rules: ["speakers"],
        ...(options.onProgress ? { onProgress: options.onProgress } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
    });
    return { meeting: record.id, added: result.fresh.length, warnings: result.warnings };
}

interface Selection extends Browse {
    sample?: number;
    id?: SampleId;
    planToken?: string;
}

function select(view: VoiceLibrarySnapshot, options: Selection, bulk: boolean) {
    const scope = explicitScope(options);
    if (options.id && options.sample !== undefined) {
        throw new Error("Choose a voice ID or a numbered sample.");
    }
    const person = options.person;
    if (!options.id && !person) {
        throw new Error("Choose a voice sample ID or a person.");
    }
    const selectionView = !options.id && options.project && !options.scope ? { ...view, merges: [] } : view;
    const groups = voicesIn(selectionView, scope).filter(
        (group) =>
            !person || sameName(group.owner.name, person) || group.samples.some((s) => sameName(s.owner.name, person))
    );
    if (!options.id && (groups.length > 1 || (options.sample !== undefined && scope.kind !== "project"))) {
        throw new Error("Ambiguous voice selection. Give a project and person, or select a sample ID.");
    }
    const samples = groups.flatMap((group) => group.samples);
    if (options.id) {
        const chosen = samples.find((s) => s.id === options.id);
        if (!chosen) {
            throw new Error("Stale voice sample selection.");
        }
        return [chosen];
    }
    if (bulk && options.sample === undefined) {
        if (!options.project && !options.scope) {
            throw new Error("Choose a scope for a bulk voice correction.");
        }
        return samples;
    }
    const index = options.sample ?? 1;
    if (
        !Number.isInteger(index) ||
        index < 1 ||
        !samples[index - 1] ||
        (scope.kind !== "project" && samples.length > 1)
    ) {
        throw new Error(`No unambiguous voice sample ${index} for this person in this scope.`);
    }
    return [samples[index - 1]!];
}

export async function voiceSample(
    options: VoicesAccess & Selection
): Promise<SoundSlice & { meeting: string; fromSec: number; toSec: number }> {
    const sample = select(readVoiceLibrary(), options, false)[0]!;
    const record = recordOf(options, sample.meeting);
    const sound = await openedOf(options, record).sound();
    const slice = sound.slice({ ...sample, purpose: "listen" });

    if (!slice) {
        throw new Error("This sample's track has no audible sound covering its time.");
    }

    if ((await sha256FileAsync(slice.path)) !== sample.sourceSha) {
        throw new Error("This sample's sound changed since it was confirmed; confirm a new sample.");
    }

    return { ...slice, meeting: record.id, fromSec: sample.fromSec, toSec: sample.toSec };
}

type Correction = ReturnType<typeof correctVoiceSample>;
type Affected = { meeting: string; item: string; fromSec: number; toSec: number };
type CorrectionOptions = VoicesAccess & { planToken?: string; preview?: boolean; predictionScope?: "all" | "project" };

function impact(
    records: Iterable<MeetingRecord>,
    receipt: Correction,
    scope: "all" | "project",
    view: VoiceLibrarySnapshot
) {
    const changed = [...receipt.before, ...receipt.after];
    const directory = groupedOwners(view);
    return Array.from(records)
        .flatMap((record) => {
            if (!record.project) {
                return [];
            }
            const bindings = changed.filter((s) => scope === "all" || s.project === record.project);
            return record.items.flatMap((item): Affected[] => {
                if (
                    item.kind !== "speaker-range" ||
                    item.status !== "suggested" ||
                    !item.rules.includes(MeetingRule.VoiceEmbedding)
                ) {
                    return [];
                }
                const next = item.evidence?.next;
                const rival =
                    next && typeof next === "object" && "person" in next && typeof next.person === "string"
                        ? next.person
                        : undefined;
                const names = [item.speaker, rival, ...(item.candidates ?? [])];
                const affected = bindings.some((s) =>
                    names.some(
                        (name) =>
                            name &&
                            (sameName(name, s.owner.name) || directory.select({ name }) === directory.binding(s.owner))
                    )
                );
                return affected
                    ? [{ meeting: record.id, item: item.id, fromSec: item.fromSec, toSec: item.toSec }]
                    : [];
            });
        })
        .sort((a, b) => a.meeting.localeCompare(b.meeting) || a.item.localeCompare(b.item));
}

function correctionPlan(options: CorrectionOptions, view: VoiceLibrarySnapshot, action: VoiceCorrection) {
    const receipt = previewVoiceCorrection(view.library, action);
    const scope = options.predictionScope ?? predictionScope();
    const affected = impact(options.store.list(), receipt, scope, view);
    const ids = [...new Set([...receipt.before, ...receipt.after].map((s) => s.id))];
    const planToken = sha256Json([
        view.library.revision,
        receipt.requestDigest,
        receipt.addedRefusals.map((r) => r.source),
        ids,
        affected,
        scope,
    ]);
    return { receipt, affected, scope, ids, planToken };
}

async function applyCorrection(options: CorrectionOptions, view: VoiceLibrarySnapshot, action: VoiceCorrection) {
    const plan = correctionPlan(options, view, action);
    const { receipt, affected, ids, planToken } = plan;
    const result = { token: receipt.token, revision: receipt.revision, ids, affected, planToken };
    if (action.token && view.library.receipts.some((r) => r.kind === "correct" && r.token === action.token)) {
        return { ...result, ...receipt.impact, status: "applied" as const };
    }
    if (options.planToken && options.planToken !== planToken) {
        throw new Error("Stale voice correction preview. Preview again.");
    }
    if (options.preview) {
        return { ...result, status: "preview" as const };
    }
    await options.store.withRecords({
        ids: affected.map((row) => row.meeting),
        fn: async (records, update) => {
            if (!isDeepStrictEqual(impact(records.values(), receipt, plan.scope, view), affected)) {
                throw new Error("Stale voice proposal preview. Preview again.");
            }
            const saved = new Map<string, Buffer>();
            try {
                for (const [meeting] of records) {
                    const path = options.store.path(meeting);
                    saved.set(path, readFileSync(path));
                    const remove = new Set(affected.filter((r) => r.meeting === meeting).map((r) => r.item));
                    await update(
                        meeting,
                        { command: "voices correct", change: "retire affected voice suggestions" },
                        (record) => {
                            record.items = record.items.filter((item) => !remove.has(item.id));
                            for (const item of record.items) {
                                if (item.kind === "question" && item.decides) {
                                    item.decides = item.decides.filter((id) => !remove.has(id));
                                }
                            }
                        }
                    );
                }
                correctVoiceSample({
                    ...action,
                    token: receipt.token,
                    expectedRevision: view.library.revision,
                    expectedIds: ids,
                    impact: { affected, planToken },
                });
            } catch (error) {
                for (const [path, bytes] of saved) {
                    atomicWriteFileSync(path, bytes, { mode: 0o600 });
                }
                throw error;
            }
        },
    });
    return { ...result, status: "applied" as const };
}

/** A migrated attachment only proves a channel span. Pin a transcript address when both the original
 * recording and exactly one complete line still match. Missing media never prevents a human rejection. */
async function resolveCorrectionSource(access: VoicesAccess, sample: VoiceSample) {
    if (sample.source.spanKey) {
        return sample.source;
    }
    const record = access.store.read(sample.meeting);
    if (!record) {
        return sample.source;
    }
    try {
        const opened = openedOf(access, record);
        const meeting = await opened.meeting();
        const lines = new TranscriptLines(meeting.transcript);
        const match = lines.at(sample.fromSec, (_line, i) => lines.end(i) === sample.toSec);
        if (match.kind === "found" && lines.entries[match.index]?.startSec === sample.fromSec) {
            const slice = (await opened.sound()).slice({ ...sample, purpose: "listen" });
            if (slice?.track === sample.track && (await sha256FileAsync(slice.path)) === sample.sourceSha) {
                return sourceForVoicePrint(
                    sample,
                    voiceRootMeeting(access.store, record),
                    voiceLineKeys(meeting)[match.index]
                );
            }
        }
    } catch (error) {
        log.debug({ error, id: sample.id }, "original recording unavailable for transcript address");
    }
    return sample.source;
}

export async function editVoice(options: CorrectionOptions & { action: VoiceCorrection; person?: string }) {
    try {
        const view = readVoiceLibrary();
        let action = options.action;
        if (
            "id" in action &&
            !view.library.receipts.some((r) => r.kind === "correct" && r.token === options.action.token)
        ) {
            const id = action.id;
            const sample = view.library.samples.find((s) => s.id === id);
            if (sample) {
                action = { ...action, resolvedSource: await resolveCorrectionSource(options, sample) };
            }
        }
        if ("id" in action && options.person && !view.library.receipts.some((r) => r.token === action.token)) {
            select(view, { person: options.person, id: action.id }, false);
        }
        const predictionScope = (await (options.config?.() ?? new MeetingsConfigStore().read())).global.speakerLabels
            .voice.sampleScope;
        return await applyCorrection({ ...options, predictionScope }, view, action);
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        if (
            !/^(Stale |Unknown voice correction|Voice sample refused|Voice attachment conflict|Correction token belongs)/.test(
                reason
            )
        ) {
            throw error;
        }
        return { status: reason.startsWith("Stale") ? ("stale" as const) : ("refused" as const), reason };
    }
}

const removalPreviews = new WeakMap<Selection, string>();
export function planVoiceRemoval(options: VoicesAccess & Selection & { predictionScope?: "all" | "project" }) {
    const view = readVoiceLibrary();
    const selected = select(view, options, true);
    const ids = selected.map((s) => s.id);
    const plan = ids.length ? correctionPlan(options, view, { kind: "remove", ids }) : undefined;
    if (plan) {
        removalPreviews.set(options, plan.planToken);
    }
    return {
        project: options.project ?? selected[0]?.project ?? "",
        person: options.person ?? selected[0]?.owner.name ?? "",
        removed: ids.length,
        affected: plan?.affected ?? [],
        ...(plan ? { ids, planToken: plan.planToken, revision: view.library.revision } : {}),
    };
}

export async function removeVoice(options: VoicesAccess & Selection & { predictionScope?: "all" | "project" }) {
    const view = readVoiceLibrary();
    const selected = select(view, options, true);
    const ids = selected.map((s) => s.id);
    const planToken = options.planToken ?? removalPreviews.get(options);
    if (!ids.length && planToken) {
        throw new Error("Stale voice removal preview.");
    }
    if (explicitScope(options).kind === "all" && options.sample === undefined && !options.id && !planToken) {
        throw new Error("Preview the affected IDs before an all-project bulk removal.");
    }
    const receipt = ids.length
        ? await applyCorrection({ ...options, planToken }, view, { kind: "remove", ids })
        : undefined;
    return {
        project: options.project ?? selected[0]?.project ?? "",
        person: options.person ?? selected[0]?.owner.name ?? "",
        removed: ids.length,
        affected: receipt?.affected ?? [],
        ...(receipt ? { ids, token: receipt.token, revision: receipt.revision, planToken: receipt.planToken } : {}),
    };
}

export async function addVoiceSample(
    options: VoicesAccess & { meeting: string; fromSec: number; toSec: number; person: string; confirmed: boolean }
): Promise<{ samples: number; skipped?: string[] }> {
    if (
        !options.confirmed ||
        !Number.isFinite(options.fromSec) ||
        !Number.isFinite(options.toSec) ||
        options.fromSec < 0 ||
        options.toSec <= options.fromSec
    ) {
        throw new Error("Give a valid --from/--to interval and --confirmed after listening to this person.");
    }

    const record = recordOf(options, options.meeting);
    if (!record.project) {
        throw new Error("Choose a project before adding a voice sample.");
    }

    const opened = await voiceReadMeeting(openedOf(options, record));
    const meeting = await opened.meeting();
    const root = voiceRootMeeting(options.store, record);
    const keys = voiceLineKeys(meeting);
    const lines = new TranscriptLines(meeting.transcript);
    const energy = await opened.energy();
    const evidence = await opened.evidence();
    const { lineEvidence } = await import("@genesiscz/utils/transcribe/evidence");
    const stays = (await opened.presence())?.filter((stay) => sameName(stay.name, options.person)) ?? [];
    const seated = record.seats && seatIntervalsFor(record.seats, options.person);
    const hasSavedSeat = Boolean(
        seated?.length || record.seats?.remote.some((row) => sameName(row.name, options.person))
    );
    const self = record.participants.some((person) => person.self && sameName(person.name, options.person));
    const eligible = lineEvidence(
        [...lines.entries],
        evidence ?? { segments: [], speaking: [] },
        undefined,
        energy.share
    ).flatMap((line) => {
        const share = line.micShare ?? line.energyMic;
        if (share === undefined || share === 0.5 || line.startSec < options.fromSec || line.endSec > options.toSec) {
            return [];
        }
        const seat: Seat = share > 0.5 ? "mic" : "call";
        const present = stays.some((stay) => stay.fromSec <= line.startSec && line.endSec <= stay.toSec);
        const eligibleSeat = hasSavedSeat
            ? seated?.some(
                  (span) =>
                      span.side === seat && span.fromSec <= line.startSec && line.endSec <= (span.toSec ?? Infinity)
              ) &&
              (seat === "mic" || present)
            : record.seats && present && (self ? "mic" : "call") === seat;
        return eligibleSeat ? [{ index: line.index, fromSec: line.startSec, toSec: line.endSec, seat }] : [];
    });
    const embedded = await embedSeatLines({ lines: eligible, sound: await opened.sound() });
    const hashes = new Map<string, string>();
    const changes: ConfirmedSampleInput[] = [];
    for (const line of embedded) {
        const voice = line.channels[0];
        if (voice?.quality !== "ready") {
            continue;
        }
        const file = voice.source.audioPath;
        const sourceSha = hashes.get(file) ?? (await sha256FileAsync(file));
        hashes.set(file, sourceSha);
        const print = {
            meeting: record.id,
            sourceSha,
            seat: line.seat,
            track: line.track,
            fromSec: line.fromSec!,
            toSec: line.toSec!,
            embedding: voice.embedding,
            confirmedAt: new Date().toISOString(),
        };
        changes.push({
            project: record.project,
            owner: meetingVoiceOwner(record, options.person),
            model: voice.model,
            print,
            source: sourceForVoicePrint(print, root, keys[line.index]),
            origin: "enrol",
            acquiredBy: "manual",
        });
    }
    if (!changes.length) {
        throw new Error("No complete usable line of this person's seat in that interval; no sample was saved.");
    }
    const { results } = await options.store.withRecords({
        ids: [record.id],
        fn: async (records) => {
            if (!isDeepStrictEqual(record, records.get(record.id))) {
                throw new Error("The meeting changed while preparing the sample. Confirm its current interval.");
            }
            return changeVoiceLearning({ add: changes });
        },
    });
    const samples = results.filter((r) => r.status === "added").length;
    const skipped = results.flatMap((r) =>
        r.status === "refused" ? [r.reason] : r.status === "added" ? [] : [r.status]
    );
    return { samples, ...(skipped.length ? { skipped } : {}) };
}
