import type { MeetingRecord, MeetingStore } from "@genesiscz/utils/meetings/record";
import { seatsFingerprint } from "@genesiscz/utils/meetings/seats";
import { lineEvidence } from "@genesiscz/utils/transcribe/evidence";
import { type ByChannelOptions, byChannelOptionsSchema, type ChannelLine, planByChannel } from "./by-channel";
import { callerActor, DecisionJournal } from "./decision-journal";
import { OpenedMeeting } from "./opened-meeting";
import { rawMeeting } from "./raw";

/** The channel evidence of a meeting; with a window, only the lines that start in it are measured. */
export async function channelEvidence(opened: OpenedMeeting, window?: { fromSec: number; toSec: number }) {
    const config = await opened.config();
    return rawMeeting({
        record: opened.record,
        meeting: await opened.meeting(),
        evidence: await opened.evidence(),
        points: [],
        people: config.projects[opened.record.project ?? ""]?.match?.people,
        ...(window ? { window } : {}),
    });
}

/**
 * The lines a channel plan reads, with the microphone share at full precision: `rawMeeting` rounds it for display,
 * and a rounded 0.2004 would pass a 0.2 threshold the measured share fails.
 */
export async function channelLines(opened: OpenedMeeting): Promise<ChannelLine[]> {
    const [meeting, evidence] = await Promise.all([opened.meeting(), opened.evidence()]);
    return lineEvidence(meeting.transcript, evidence ?? { segments: [], speaking: [] }).map((line) => ({
        index: line.index,
        fromSec: line.startSec,
        toSec: line.endSec,
        label: line.label,
        text: line.text,
        channel: { micShare: line.micShare ?? null },
    }));
}

export async function attributeByChannel(options: {
    store: MeetingStore;
    record: MeetingRecord;
    input: ByChannelOptions;
}) {
    const input = byChannelOptionsSchema.parse(options.input);
    const lines = await channelLines(OpenedMeeting.of(options.store, options.record));
    const plan = planByChannel({ lines, seats: options.record.seats, input });
    if (input.dryRun) {
        return { ...plan, dryRun: true };
    }
    const findings = [...plan.ranges, ...plan.targets, ...plan.questions];
    // A replacement applies even when the new plan found nothing: the old suggestions of this label go.
    if (findings.length === 0 && !input.replace) {
        return { ...plan, dryRun: false };
    }
    const decision = await new DecisionJournal({ store: options.store }).apply({
        meeting: options.record.id,
        actor: callerActor(),
        action: {
            kind: "add",
            findings,
            ...(input.replace ? { replace: { ...input.replace, label: input.label } } : {}),
            fence: { seats: seatsFingerprint(options.record.seats) },
        },
    });
    return { ...plan, dryRun: false, decision };
}
