import type { MeetingRecord, MeetingStore } from "@genesiscz/utils/meetings/record";
import { type ByChannelOptions, byChannelOptionsSchema, planByChannel } from "./by-channel";
import { callerActor, DecisionJournal } from "./decision-journal";
import { OpenedMeeting } from "./opened-meeting";
import { rawMeeting } from "./raw";

export async function channelEvidence(opened: OpenedMeeting) {
    const config = await opened.config();
    return rawMeeting({
        record: opened.record,
        meeting: await opened.meeting(),
        evidence: await opened.evidence(),
        points: [],
        people: config.projects[opened.record.project ?? ""]?.match?.people,
    });
}

export async function attributeByChannel(options: {
    store: MeetingStore;
    record: MeetingRecord;
    input: ByChannelOptions;
}) {
    const input = byChannelOptionsSchema.parse(options.input);
    const raw = await channelEvidence(OpenedMeeting.of(options.store, options.record));
    const plan = planByChannel({ lines: raw.lines, seats: options.record.seats, input });
    if (input.dryRun) {
        return { ...plan, dryRun: true };
    }
    const findings = [...plan.ranges, ...plan.questions];
    if (findings.length === 0) {
        return { ...plan, dryRun: false };
    }
    const decision = await new DecisionJournal({ store: options.store }).apply({
        meeting: options.record.id,
        actor: callerActor(),
        action: { kind: "add", findings, ...(input.replace ? { replace: input.replace } : {}) },
    });
    return { ...plan, dryRun: false, decision };
}
