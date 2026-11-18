import { isDeepStrictEqual } from "node:util";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { projectNameSchema } from "@genesiscz/utils/meetings/config";
import type { MeetingRecord } from "@genesiscz/utils/meetings/record";
import { voiceRootMeeting } from "@genesiscz/utils/meetings/record";
import { readVoiceLibrary, sourceForVoicePrint } from "@genesiscz/utils/meetings/voice-library";
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

interface BackfillRow {
    meeting: string;
    person: string | null;
    added: number;
    present: number;
    skipped: Record<string, number>;
}

interface BackfillDecision extends VoiceTarget {
    changes: VoicePrintChange[];
    skipped?: string;
}

/** Words a name abbreviates with a period (`Dr. Ada Example`), lower case. A single letter is an initial. */
const NAME_ABBREVIATIONS = new Set(["mr", "mrs", "ms", "mx", "dr", "prof", "st", "jr", "sr"]);
/** A suffix a name sets off with a comma: `Bob Example, Jr.`. */
const NAME_SUFFIX = /^\s+(?:jr|sr|ii|iii|iv)\.?(?:\s|$)/i;

/**
 * Answers saved before free text was parsed into people (I6) can hold a whole sentence as the speaker, and the record
 * then lists that sentence as a confirmed speaker, so the record's own speakers cannot veto it. A name that an
 * independent source lists (`known`: the participants and the attendance) is one person. Otherwise a name has at most
 * six words, and its punctuation before a space is a period after an initial or a title (`J. R. Example`,
 * `Dr. Example`) or a comma before a suffix (`Bob Example, Jr.`); any other is a sentence's.
 */
export function looksLikeOnePerson(name: string, known: readonly string[] = []): boolean {
    if (known.some((person) => sameName(person, name))) {
        return true;
    }

    if (name.trim().split(/\s+/).length > 6) {
        return false;
    }

    for (const match of name.matchAll(/([^\s.?!,;:]*)([.?!,;:])(?=\s)/g)) {
        const [, word = "", mark] = match;
        const rest = name.slice(match.index + match[0].length);
        const initial = mark === "." && (word.length === 1 || NAME_ABBREVIATIONS.has(word.toLowerCase()));
        if (!initial && !(mark === "," && NAME_SUFFIX.test(rest))) {
            return false;
        }
    }

    return true;
}

async function prepareDecisions(
    access: VoicesAccess,
    journal: DecisionJournal,
    record: MeetingRecord,
    dryRun: boolean
) {
    const owners = new Map(
        record.items.filter((item) => item.status === "confirmed").map((item) => [item.id, item.decision?.token])
    );
    const people = recordPeople(record);
    // Only sources independent of the answers: a confirmed speaker may be the very sentence being checked.
    const listed = [
        ...record.participants.map((one) => one.name),
        ...(record.attendance?.people.map((one) => one.name) ?? []),
    ];
    const decisions: BackfillDecision[] = [];
    for (const entry of journal.read(record.id).reverse()) {
        if (entry.meeting !== record.id) {
            throw new Error(`Decision ${entry.token} belongs to ${entry.meeting}, not ${record.id}.`);
        }
        for (const target of answeredVoiceTargets(entry, people)) {
            if (!looksLikeOnePerson(target.voice.person, listed)) {
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
        const opened = OpenedMeeting.of(access.store, record, access.linkedSource?.(record));
        try {
            for (const { target, changes } of await prepareVoicePrints(opened, active, dryRun)) {
                target.changes.push(...changes);
                if (!changes.length && !target.saved?.length) {
                    target.skipped = "no complete line with usable channel and voice evidence";
                }
            }
        } catch (error) {
            for (const target of active) {
                target.skipped = `voice extraction unavailable: ${errorText(error)}`;
            }
        }
    }

    return decisions;
}

async function backfillMeeting(
    access: VoicesAccess,
    record: MeetingRecord,
    project: string,
    dryRun: boolean
): Promise<BackfillRow[]> {
    const journal = new DecisionJournal({ store: access.store });
    const decisions = await prepareDecisions(access, journal, record, dryRun);
    const finish = () => {
        const view = readVoiceLibrary();
        const root = voiceRootMeeting(access.store, record);
        const changes: VoicePrintChange[] = [];
        const rows = new Map<string, BackfillRow>();
        for (const decision of decisions) {
            const { entry, voice } = decision;
            const row: BackfillRow = rows.get(voice.person) ?? {
                meeting: record.id,
                person: voice.person,
                added: 0,
                present: 0,
                skipped: {},
            };
            rows.set(voice.person, row);
            const reason = decision.skipped;
            if (reason) {
                row.skipped[reason] = (row.skipped[reason] ?? 0) + 1;
            }
            for (const change of decision.changes) {
                if (view.library.model && view.library.model !== change.model) {
                    const reason = "sample uses a different voice model from the project";
                    row.skipped[reason] = (row.skipped[reason] ?? 0) + 1;
                    continue;
                }
                changes.push({
                    ...change,
                    project,
                    origin: entry.action.kind === "confirm" ? "confirm" : "answer",
                    acquiredBy: "backfill",
                    token: entry.token,
                    source: change.source ?? sourceForVoicePrint(change.after, root),
                });
            }
        }
        const receipts = journal.publishBackfilledVoices(record.id, changes, dryRun);
        for (const [index, receipt] of receipts.entries()) {
            const row = rows.get(changes[index]!.person)!;
            if (receipt.status === "added") {
                row.added++;
            } else if (receipt.status === "already-present") {
                row.present++;
            } else {
                const reason = receipt.status === "refused" ? receipt.reason : "attachment conflict";
                row.skipped[reason] = (row.skipped[reason] ?? 0) + 1;
            }
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
    if (dryRun || !decisions.some((decision) => decision.changes.length)) {
        return finish();
    }
    // Extraction may take minutes. Hold the same lock as Undo only for the final read and publication.
    return access.store.withRecords({
        ids: [record.id],
        fn: async (current) => {
            if (!isDeepStrictEqual(current.get(record.id), record)) {
                throw new Error(`Meeting ${record.id} changed during backfill. Retry with its current decisions.`);
            }
            return finish();
        },
    });
}

export async function backfillVoices(
    options: VoicesAccess & { meetings?: string[]; project?: string; dryRun?: boolean }
) {
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
    const rows: BackfillRow[] = [];
    const dryRun = options.dryRun ?? false;
    for (const { record, project } of selected.values()) {
        rows.push(...(await backfillMeeting(options, record, project, dryRun)));
    }
    return {
        dryRun,
        rows,
        added: rows.reduce((sum, row) => sum + row.added, 0),
        present: rows.reduce((sum, row) => sum + row.present, 0),
    };
}
