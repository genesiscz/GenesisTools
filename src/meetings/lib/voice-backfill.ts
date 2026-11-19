import { isDeepStrictEqual } from "node:util";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { sha256Json } from "@genesiscz/utils/hash";
import { projectNameSchema } from "@genesiscz/utils/meetings/config";
import type { MeetingRecord } from "@genesiscz/utils/meetings/record";
import { voiceRootMeeting } from "@genesiscz/utils/meetings/record";
import { meetingVoiceOwner, readVoiceLibrary, sourceForVoicePrint } from "@genesiscz/utils/meetings/voice-library";
import { DecisionJournal } from "./decision-journal";
import { recordPeople } from "./listen-answers";
import { OpenedMeeting } from "./opened-meeting";
import { errorText } from "./shared";
import {
    answeredVoiceTargets,
    journalVoices,
    prepareVoicePrints,
    type VoicePrintChange,
    type VoiceTarget,
} from "./voice-samples";
import type { VoicesAccess } from "./voices";

export interface BackfillRow {
    meeting: string;
    person: string | null;
    added: number;
    present: number;
    skipped: Record<string, number>;
}

interface BackfillDecision extends VoiceTarget {
    changes: VoicePrintChange[];
    skipped?: string;
    missing?: number;
    refusals?: Map<string, number>;
    transcriptVersion?: string;
    audioCurrent?: () => boolean;
}

/**
 * Answers saved before free text was parsed into people (I6) can hold a whole sentence as the speaker, and the record
 * then lists that sentence as a confirmed speaker, so the record's own people cannot veto it. A name never holds
 * sentence punctuation followed by a space, nor more than six words.
 */
export function looksLikeOnePerson(name: string): boolean {
    return !/[.?!,;:]\s/.test(name) && name.trim().split(/\s+/).length <= 6;
}

async function prepareDecisions(
    access: VoicesAccess,
    journal: DecisionJournal,
    record: MeetingRecord,
    dryRun: boolean,
    job: LearningRun
) {
    const owners = new Map(
        record.items.filter((item) => item.status === "confirmed").map((item) => [item.id, item.decision?.token])
    );
    const people = recordPeople(record);
    const decisions: BackfillDecision[] = [];
    for (const entry of journal.read(record.id).reverse()) {
        if (job.tokens && !job.tokens.has(entry.token)) {
            continue;
        }
        if (entry.meeting !== record.id) {
            throw new Error(`Decision ${entry.token} belongs to ${entry.meeting}, not ${record.id}.`);
        }
        for (const target of answeredVoiceTargets(entry, people)) {
            if (!looksLikeOnePerson(target.voice.person)) {
                decisions.push({ ...target, changes: [], skipped: "the answer is a sentence, not one person" });
                continue;
            }
            if (owners.get(target.voice.item) !== entry.token) {
                decisions.push({ ...target, changes: [], skipped: "confirmation undone or replaced" });
                continue;
            }
            const saved = journalVoices(entry, target.voice.item, record.project);
            decisions.push({ ...target, saved, changes: [...(saved ?? [])] });
        }
    }
    const active = decisions.filter((decision) => !decision.skipped);
    if (active.length) {
        const opened = OpenedMeeting.of(access.store, record, access.linkedSource?.(record), await access.config?.());
        try {
            for (const prepared of await prepareVoicePrints(opened, active, {
                dryRun,
                signal: job.signal,
                guardPublication: true,
                planned: (count) =>
                    job.progress?.({
                        done: 0,
                        total: count + decisions.length - active.length,
                        added: 0,
                        skipped: 0,
                        step: "Extracting confirmed lines",
                    }),
            })) {
                const { target, changes } = prepared;
                target.missing = prepared.missing;
                target.refusals = prepared.refusals;
                if (changes.length) {
                    target.transcriptVersion = prepared.transcriptVersion;
                    target.audioCurrent = prepared.audioCurrent;
                }
                target.changes.push(...changes);
                if (!changes.length && !target.saved?.length && !target.refusals.size) {
                    target.skipped = "no complete line with usable channel and voice evidence";
                }
            }
        } catch (error) {
            job.signal?.throwIfAborted();
            for (const target of active) {
                if (target.saved?.length) {
                    continue;
                }
                target.skipped = `voice extraction unavailable: ${errorText(error)}`;
            }
        }
    }

    return decisions;
}

export interface LearningRun {
    tokens?: ReadonlySet<string>;
    signal?: AbortSignal;
    acquiredBy?: "live" | "backfill";
    progress?: (progress: { done: number; total: number; added: number; skipped: number; step: string }) => void;
}

function sameRecording(a: MeetingRecord, b: MeetingRecord): boolean {
    return (
        a.start === b.start &&
        a.voiceRootMeeting === b.voiceRootMeeting &&
        isDeepStrictEqual(a.sources, b.sources) &&
        isDeepStrictEqual(a.recording, b.recording) &&
        isDeepStrictEqual(a.audio, b.audio) &&
        isDeepStrictEqual(a.evidence?.channels, b.evidence?.channels) &&
        isDeepStrictEqual(a.seats, b.seats)
    );
}

/** The project and tokens come from the enqueue-time record. Nothing computed outside the lock grants publication rights. */
export async function learnMeetingVoices(options: {
    access: VoicesAccess;
    record: MeetingRecord;
    project: string;
    dryRun: boolean;
    job?: LearningRun;
}): Promise<BackfillRow[]> {
    const { access, record, project, dryRun, job = {} } = options;
    const journal = new DecisionJournal({ store: access.store });
    job.signal?.throwIfAborted();
    const decisions = await prepareDecisions(access, journal, record, dryRun, job);
    const units = (decision: BackfillDecision) =>
        Math.max(
            1,
            decision.changes.length +
                (decision.missing ?? 0) +
                [...(decision.refusals?.values() ?? [])].reduce((sum, n) => sum + n, 0)
        );
    const total = decisions.reduce((sum, d) => sum + units(d), 0);
    let done = 0,
        added = 0,
        skipped = 0;
    job.progress?.({ done, total, added, skipped, step: "Checking confirmed lines" });
    const finish = async (current: MeetingRecord) => {
        job.signal?.throwIfAborted();
        if (!dryRun) {
            journal.repairVoiceReceipts(record.id);
        }
        const root = voiceRootMeeting(access.store, current);
        const view = readVoiceLibrary();
        const items = new Map(current.items.map((item) => [item.id, item]));
        const sameSource = sameRecording(record, current);
        const versions =
            decisions.some((d) => d.transcriptVersion) && sameSource && current.project === project
                ? await OpenedMeeting.of(access.store, current, access.linkedSource?.(current))
                      .meeting()
                      .then((m) => sha256Json(m.transcript))
                : undefined;
        job.signal?.throwIfAborted();
        const changes: VoicePrintChange[] = [];
        const rows = new Map<string, BackfillRow>();
        function skip(row: BackfillRow, reason: string, count = 1) {
            row.skipped[reason] = (row.skipped[reason] ?? 0) + count;
            skipped += count;
            done += count;
            job.progress?.({ done, total, added, skipped, step: reason });
        }
        for (const decision of decisions) {
            const { entry, voice } = decision;
            const row = rows.get(voice.person) ?? {
                meeting: record.id,
                person: voice.person,
                added: 0,
                present: 0,
                skipped: {},
            };
            rows.set(voice.person, row);
            const item = items.get(voice.item);
            const original = entry.changes.find((change) => change.id === voice.item)?.after;
            const reason =
                decision.skipped ??
                (current.project !== project
                    ? "meeting project changed"
                    : item?.status !== "confirmed" ||
                        item.decision?.token !== entry.token ||
                        !isDeepStrictEqual(item, original)
                      ? "confirmation undone or replaced"
                      : !sameSource ||
                          (decision.transcriptVersion && versions !== decision.transcriptVersion) ||
                          decision.audioCurrent?.() === false
                        ? "recording or source line changed"
                        : undefined);
            if (reason) {
                skip(row, reason, units(decision));
                continue;
            }
            for (const [reason, count] of decision.refusals ?? []) {
                skip(row, reason, count);
            }
            if (decision.missing) {
                skip(row, "no complete line with usable channel and voice evidence", decision.missing);
            }
            for (const change of decision.changes) {
                if (change.owner && !isDeepStrictEqual(meetingVoiceOwner(current, voice.person), change.owner)) {
                    skip(row, "confirmed person's identity changed");
                    continue;
                }
                if (view.library.model && view.library.model !== change.model) {
                    skip(row, "sample uses a different voice model from the project");
                    continue;
                }
                changes.push({
                    ...change,
                    project,
                    item: voice.item,
                    origin: entry.action.kind === "confirm" ? "confirm" : "answer",
                    acquiredBy: job.acquiredBy ?? "backfill",
                    token: entry.token,
                    source: change.source ?? sourceForVoicePrint(change.after, root),
                });
            }
        }
        job.signal?.throwIfAborted();
        const receipts = journal.publishBackfilledVoices(record.id, changes, dryRun);
        for (const [index, receipt] of receipts.entries()) {
            const row = rows.get(changes[index]!.person)!;
            if (receipt.status === "added") {
                row.added++;
                added++;
            } else if (receipt.status === "already-present") {
                row.present++;
                skipped++;
            } else {
                skip(row, receipt.status === "refused" ? receipt.reason : "attachment conflict");
                continue;
            }
            job.progress?.({ done: ++done, total, added, skipped, step: receipt.status });
        }
        return rows.size
            ? [...rows.values()]
            : [
                  {
                      meeting: record.id,
                      person: null,
                      added: 0,
                      present: 0,
                      skipped: { "no human speaker decisions": 1 },
                  },
              ];
    };
    return dryRun
        ? finish(record)
        : access.store.withRecords({
              ids: [record.id],
              fn: async (current) => finish(current.get(record.id)!),
          });
}

export function backfillRecords(options: VoicesAccess & { meetings?: string[]; project?: string; dryRun?: boolean }) {
    if (Boolean(options.meetings?.length) === (options.project !== undefined)) {
        throw new Error("Give one or more meetings or --project <name>.");
    }
    const project = options.project === undefined ? undefined : projectNameSchema.parse(options.project);
    const records =
        project !== undefined
            ? options.store.listBounded({ where: (record) => record.project === project }).records
            : (options.meetings ?? []).map((ref) => {
                  const record = options.store.resolve(ref);
                  if (!record) {
                      throw new Error(`No meeting "${ref}".`);
                  }
                  return record;
              });
    const selected = new Map(
        records.map((record) => {
            if (!record.project) {
                throw new Error(
                    `Meeting ${record.id} needs a project. Run ${toolCommand("meetings set", record.id, "--project", "<name>")}`
                );
            }
            return [record.id, { record, project: record.project }] as const;
        })
    );
    return [...selected.values()];
}

export async function backfillVoices(
    options: VoicesAccess & { meetings?: string[]; project?: string; dryRun?: boolean }
) {
    const selected = backfillRecords(options);
    const rows: BackfillRow[] = [];
    const dryRun = options.dryRun ?? false;
    for (const { record, project } of selected) {
        rows.push(...(await learnMeetingVoices({ access: options, record, project, dryRun })));
    }
    return {
        dryRun,
        rows,
        added: rows.reduce((sum, row) => sum + row.added, 0),
        present: rows.reduce((sum, row) => sum + row.present, 0),
    };
}
