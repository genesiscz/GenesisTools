import { isDeepStrictEqual } from "node:util";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { projectNameSchema } from "@genesiscz/utils/meetings/config";
import type { MeetingRecord } from "@genesiscz/utils/meetings/record";
import { readVoiceStore, voicePrintKey } from "@genesiscz/utils/meetings/voice-store";
import { DecisionJournal } from "./decision-journal";
import { recordPeople } from "./listen-answers";
import { OpenedMeeting } from "./opened-meeting";
import { errorText } from "./shared";
import { answeredVoiceTargets, prepareVoicePrints, type VoicePrintChange, type VoiceTarget } from "./voice-samples";
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
    const decisions: BackfillDecision[] = [];
    for (const entry of journal.read(record.id).reverse()) {
        if (entry.meeting !== record.id) {
            throw new Error(`Decision ${entry.token} belongs to ${entry.meeting}, not ${record.id}.`);
        }
        for (const target of answeredVoiceTargets(entry, people)) {
            if (owners.get(target.voice.item) !== entry.token) {
                decisions.push({ ...target, changes: [], skipped: "confirmation undone or replaced" });
                continue;
            }
            const saved = entry.voices?.filter(
                (change) =>
                    change.after.question === target.voice.item &&
                    change.after.meeting === record.id &&
                    change.project === record.project
            );
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
        const { people, model } = readVoiceStore(project);
        let projectModel = model;
        const present = new Set(
            Object.entries(people).flatMap(([name, row]) => row.samples.map((print) => voicePrintKey(name, print)))
        );
        const changes: VoicePrintChange[] = [];
        const recovered = new Map<string, VoicePrintChange[]>();
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
                const key = voicePrintKey(change.person, change.after);
                if (present.has(key)) {
                    row.present++;
                    continue;
                }
                if (projectModel && projectModel !== change.model) {
                    const reason = "sample uses a different voice model from the project";
                    row.skipped[reason] = (row.skipped[reason] ?? 0) + 1;
                    continue;
                }
                projectModel = change.model;
                present.add(key);
                changes.push(change);
                row.added++;
                if (!decision.saved?.includes(change)) {
                    const group = recovered.get(entry.token) ?? [];
                    group.push(change);
                    recovered.set(entry.token, group);
                }
            }
        }
        if (changes.length && !dryRun) {
            journal.publishBackfilledVoices(record.id, project, changes, recovered);
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
