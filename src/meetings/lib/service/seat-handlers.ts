import { logger } from "@genesiscz/utils/logger";
import type { MeetingRecord, MeetingStore } from "@genesiscz/utils/meetings/record";
import { lineEvidence } from "@genesiscz/utils/transcribe/evidence";
import { OpenedMeeting } from "../opened-meeting";
import { speakingEvidence } from "../platforms";
import { decidedSeatRanges, explicitPreviewSeats, includeSeatVoiceHints, suggestSeats } from "../seat-suggest";
import { type LinkedSource, sourceRefOf } from "../sources";

const { log } = logger.scoped("meetings-service");

async function seatEvidence(opened: OpenedMeeting) {
    const [meeting, energy, evidence] = await Promise.all([
        opened.meeting().catch((error: unknown) => {
            log.warn({ error, meeting: opened.record.id }, "seat suggestions without transcript lines");
            return undefined;
        }),
        opened.energy().catch((error: unknown) => {
            log.warn({ error, meeting: opened.record.id }, "seat suggestions without channel energy");
            return undefined;
        }),
        opened.evidence().catch((error: unknown) => {
            log.warn({ error, meeting: opened.record.id }, "seat suggestions without source evidence");
            return undefined;
        }),
    ]);
    const stored = opened.record.evidence?.indicator;
    const source =
        !evidence?.speaking.length && stored?.length
            ? speakingEvidence(opened.record, {
                  files: [],
                  segments: [],
                  ...evidence,
                  speaking: stored,
                  mutedCarrySec: (await opened.config()).global.suggest.mutedCarrySec,
              })
            : evidence;
    const lines = lineEvidence(
        meeting?.transcript ?? [],
        source ?? { segments: [], speaking: [] },
        undefined,
        energy?.share
    );
    // A failed source read could hide a mute. Decided lines can still use the raw energy that was readable.
    return { meeting: evidence === undefined ? undefined : meeting, lines, calibration: energy?.calibration };
}

export async function seatSuggestion({
    store,
    record,
    linked,
    params,
}: {
    store: MeetingStore;
    record: MeetingRecord;
    linked?: LinkedSource;
    params: Pick<Parameters<typeof suggestSeats>[0], "room" | "remote">;
}) {
    const ranges = decidedSeatRanges(record);
    const opened = OpenedMeeting.of(store, record, linked);
    let evidence: ReturnType<typeof seatEvidence> | undefined;
    const readEvidence = () => (evidence ??= seatEvidence(opened));
    const source = sourceRefOf(record);
    const lines = source && ranges.length ? (await readEvidence()).lines : [];
    const suggestion = suggestSeats({ record, ranges, lines, room: params.room, remote: params.remote });
    if (source && record.project && suggestion.people.some((row) => row.seat === "unsure" && row.confidence === 0)) {
        const { readSeatVoiceHints } = await import("../seat-voice");
        try {
            const hints = await readSeatVoiceHints({
                opened,
                people: suggestion.people.map((row) => row.name),
                readEvidence,
                seats: explicitPreviewSeats({ saved: record.seats, edits: params, suggested: suggestion.seats }),
            });
            includeSeatVoiceHints({ record, suggestion, hints });
        } catch (error) {
            log.warn({ error, meeting: record.id }, "seat suggestions without voice matches");
        }
    }
    return {
        meeting: record.id,
        current: record.seats ?? null,
        suggestion,
    };
}
