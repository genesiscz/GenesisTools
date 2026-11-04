import { findingItems, findingProblems, findingSchema } from "@app/meetings/lib/findings";
import { OpenedMeeting } from "@app/meetings/lib/opened-meeting";
import { defineApi, defineMethod } from "@genesiscz/utils/api-descriptor";
import { MeetingStore } from "@genesiscz/utils/meetings/record";
import { ReplToolset } from "@genesiscz/utils/repl/toolset";
import { z } from "zod";

const ref = z.object({ ref: z.string().min(1) });
const open = defineMethod({
    name: "open",
    params: ref,
    result: z.unknown(),
    resultName: "Meeting",
    effect: "read",
    doc: "Open a stored meeting by id or unambiguous reference.",
});
const evidence = defineMethod({
    name: "evidence",
    params: z.object({}),
    result: z.unknown(),
    effect: "read",
    doc: "Read the meeting's platform-filtered evidence.",
});
const transcript = defineMethod({
    name: "transcript",
    params: z.object({}),
    result: z.unknown(),
    effect: "read",
    doc: "Read the linked source transcript.",
});
const add = defineMethod({
    name: "items.add",
    params: z.object({ findings: z.array(findingSchema).min(1) }),
    result: z.unknown(),
    effect: "reversible",
    doc: "Add validated findings under the meeting store lock.",
});

export class MeetingsToolset extends ReplToolset {
    readonly api = defineApi({
        id: "meetings",
        global: "meetings",
        title: "Meetings",
        summary: "Open meetings, read evidence and transcripts, and add findings.",
        methods: [open],
        handles: [{ name: "Meeting", summary: "An opened meeting.", methods: [evidence, transcript, add] }],
    });

    async bootstrap(): Promise<Record<string, unknown>> {
        const store = new MeetingStore();
        return {
            meetings: {
                open: (input: z.input<typeof ref>) => {
                    const record = store.resolve(ref.parse(input).ref);

                    if (!record) {
                        throw new Error("No matching meeting");
                    }

                    const meeting = OpenedMeeting.of(store, record);
                    return {
                        record,
                        evidence: () => meeting.evidence(),
                        transcript: async () => (await meeting.meeting()).transcript,
                        items: {
                            add: (input: z.input<typeof add.params>) => {
                                const { findings } = add.params.parse(input);
                                return store.update(
                                    record.id,
                                    { command: "items add", change: `${findings.length} findings` },
                                    (current) => {
                                        const problems = findingProblems(findings, current.items);

                                        if (problems.length > 0) {
                                            throw new Error(problems.join("; "));
                                        }

                                        current.items.push(
                                            ...findingItems(findings, current.items, new Date().toISOString())
                                        );
                                    }
                                );
                            },
                        },
                    };
                },
            },
        };
    }
}
