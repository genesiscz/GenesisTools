import { ui } from "@genesiscz/utils/cli/ui";
import { logger } from "@genesiscz/utils/logger";
import type { MeetingRecord, MeetingStore } from "@genesiscz/utils/meetings/record";
import { presenceSections } from "@genesiscz/utils/transcribe/speakers";
import { type LoadedPresence, loadPresence } from "./attendance";
import { energyMicShareFor } from "./energy";
import { MEETING_PLATFORMS, platformOfSourceName } from "./platforms";
import { meetingSource } from "./sources";

const { log } = logger.scoped("meetings-collect");

/**
 * Stores attendance in the record: the user under their own name, an open stay closed at the last known time, and
 * the sections derived from the stays.
 */
export async function storeAttendance(options: {
    store: MeetingStore;
    record: MeetingRecord;
    loaded: LoadedPresence;
    from: string;
}): Promise<MeetingRecord> {
    const { store, record, loaded } = options;
    const selfName = record.participants.find((person) => person.self)?.name;
    const people = loaded.presence.map((stay) => ({ ...stay, name: stay.self && selfName ? selfName : stay.name }));
    const lastKnown = Math.max(
        ...people.flatMap((stay) => [stay.fromSec, Number.isFinite(stay.toSec) ? stay.toSec : stay.fromSec])
    );
    const stored = people.map((stay) => ({ ...stay, toSec: Number.isFinite(stay.toSec) ? stay.toSec : lastKnown }));
    const sections = presenceSections(stored);
    return store.update(
        record.id,
        { command: "attendance", change: `${stored.length} stays, ${sections.length} sections (${loaded.note})` },
        (next) => {
            next.attendance = { from: options.from, people: stored };
            next.sections = sections;
        }
    );
}

export interface CollectOutcome {
    record: MeetingRecord;
    /** One line per step that did something or could not, for the user. */
    notes: Array<{ ok: boolean; text: string }>;
}

/**
 * Collects what a linked recording can tell without being asked: the call platform (from the source), the
 * attendance and its sections (when the platform keeps them and the record has none), and the audio channel layout.
 * A step that fails is a note, never an error: the record stays as it was for that step.
 */
export async function collectRecord(store: MeetingStore, record: MeetingRecord): Promise<CollectOutcome> {
    const notes: CollectOutcome["notes"] = [];
    const [sourceId, block] =
        Object.entries(record.sources).find(([, value]) => typeof value.meetingId === "string") ?? [];

    if (!sourceId || typeof block?.meetingId !== "string") {
        return { record, notes };
    }

    let current = record;
    const source = await meetingSource(sourceId);
    const meeting = await source.load(block.meetingId);
    const evidence = await source.evidence(block.meetingId);
    const named = platformOfSourceName(evidence?.platform);

    if (!current.platform && named) {
        current = await store.update(current.id, { command: "collect", change: `platform ${named.id}` }, (next) => {
            next.platform = named.id;
        });
        notes.push({ ok: true, text: `platform: ${named.label}` });
    }

    const platform = current.platform ? MEETING_PLATFORMS[current.platform] : undefined;

    if (!current.attendance && platform && platform.capabilities.attendance !== "none") {
        try {
            const loaded = await loadPresence(
                {
                    title: current.calendar?.title ?? current.title,
                    start: meeting.start,
                    ...(meeting.end ? { end: meeting.end } : {}),
                },
                platform.id
            );
            current = await storeAttendance({ store, record: current, loaded, from: platform.id });
            notes.push({ ok: true, text: `${loaded.note}, ${current.sections?.length ?? 0} sections` });
        } catch (err) {
            log.warn({ err, meeting: current.id, platform: platform.id }, "attendance not collected");
            notes.push({
                ok: false,
                text: `attendance not collected: ${err instanceof Error ? err.message : String(err)}`,
            });
        }
    }

    const energy = await energyMicShareFor(store, current, evidence);

    if (energy.calibration) {
        const { layout, reason } = energy.calibration;
        notes.push({ ok: layout !== "unknown", text: `audio channels: ${layout}${reason ? ` (${reason})` : ""}` });
        current = store.resolve(current.id) ?? current;
    }

    log.info({ meeting: current.id, notes }, "collected");
    return { record: current, notes };
}

/** Collects and prints one line per note; a failure here never fails the command that linked the recording. */
export async function collectAndReport(store: MeetingStore, record: MeetingRecord): Promise<MeetingRecord> {
    try {
        const outcome = await collectRecord(store, record);

        for (const note of outcome.notes) {
            note.ok ? ui.dim(`  ${note.text}`) : ui.warn(`  ${note.text}`);
        }

        return outcome.record;
    } catch (err) {
        log.warn({ err, meeting: record.id }, "collect failed");
        ui.warn(`  could not collect the call's facts: ${err instanceof Error ? err.message : String(err)}`);
        return record;
    }
}
