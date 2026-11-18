import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import { type MeetingRecord, MeetingStore } from "@genesiscz/utils/meetings/record";
import type { TranscriptSource } from "@genesiscz/utils/meetings/sources";
import { z } from "zod";
import { ANSWER_LOG_FILE } from "../../answer-log";
import { ListenSession } from "../../listen-session";
import { GivenAnswerAdapter } from "../../listen-session-answer";
import { reviewRows } from "../../review-rows";
import { helloParamsSchema, meetingsMethod } from "../api";
import { InProcessMeetingsClient } from "../client";

// The XCTest socket fake supplies the request unchanged. Only the transcript and the people are invented.
// Each invocation opens the fixture's store again, including the independent terminal answer.
const id = z.string().regex(/^window-writes-[a-f0-9-]+$/);
const request = z.discriminatedUnion("method", [
    z.object({ method: z.literal("meeting.show"), params: z.object({ ref: id }) }),
    z.object({ method: z.literal("meeting.rows"), params: z.object({ meeting: id }) }),
    z.object({
        method: z.literal("decision.apply"),
        hello: helloParamsSchema,
        params: meetingsMethod("decision.apply").params,
    }),
    z.object({
        method: z.literal("listen"),
        params: z.object({ meeting: id, question: z.string(), answer: z.string() }),
    }),
]);

const transcript = [{ startSec: 0, speaker: "Speaker 1", text: "The glimmer is visible." }];

function source(record: MeetingRecord): TranscriptSource {
    const unused = async (): Promise<never> => {
        throw new Error("Unexpected transcript provider read");
    };
    return {
        id: "wisprflow",
        label: "Practice transcript",
        load: async () => ({
            sourceMeetingId: record.id,
            title: record.title,
            start: record.start,
            transcript,
            participants: record.participants,
            speakers: [],
            folders: [],
        }),
        revision: unused,
        describe: () => ({}),
        dictionary: unused,
        recordingClock: unused,
        evidence: unused,
        liveRecording: unused,
        calendarEntries: unused,
        folders: unused,
        meetingsBetween: unused,
        meetingFolders: unused,
        folderWrite: { supported: false, reason: "Fixture", manualStep: "None" },
    };
}

async function reply(call: z.infer<typeof request>) {
    const store = new MeetingStore();
    const meetingId = id.parse(call.method === "meeting.show" ? call.params.ref : call.params.meeting);
    const record = store.read(meetingId);

    if (!record) {
        throw new Error(`Missing invented meeting ${meetingId}`);
    }

    switch (call.method) {
        case "meeting.show":
            return record;
        case "meeting.rows":
            return reviewRows(record, { transcript, minPriority: 0, lowPriority: "show" });
        case "decision.apply": {
            const client = new InProcessMeetingsClient({
                hello: call.hello,
                deps: {
                    store: () => store,
                    linkedSource: (row) => ({ source: source(row), sourceMeetingId: row.id }),
                    ledger: () => {},
                },
            });
            try {
                return await client.call("decision.apply", call.params);
            } finally {
                client.close();
            }
        }
        case "listen":
            return new ListenSession({
                store,
                split: { transcript: async () => transcript },
                listenBelow: 0.6,
                ledger: () => {},
                meeting: record,
                logPath: join(store.folder(record.id), ANSWER_LOG_FILE),
                adapter: new GivenAnswerAdapter({ answer: call.params.answer }, () => {}),
                only: call.params.question,
                budget: 1,
                minPriority: 0,
            }).run();
    }
}

if (!env.tools.hasExplicitHome() || env.tools.getHome() !== process.argv[2]) {
    throw new Error("The window write fixture requires its own store");
}

const result = await reply(request.parse(SafeJSON.parse(process.argv[3])));
out.result(SafeJSON.stringify(result));
