import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import { meetingsConfigSchema } from "@genesiscz/utils/meetings/config";
import { localVoiceBackend } from "@genesiscz/utils/meetings/voice";
import { addVoicePrint, readVoiceStore, type VoiceStore } from "@genesiscz/utils/meetings/voice-store";
import { genesisToolsDirIn } from "@genesiscz/utils/storage/root";
import { formatTable } from "@genesiscz/utils/table";
import { sameName } from "@genesiscz/utils/transcribe/speakers";
import { z } from "zod";
import { meetingSound } from "../../../src/meetings/lib/sound";
import { mergeLineLabels } from "../../../src/meetings/lib/speaker-labels";
import { seatLabeler } from "../../../src/meetings/lib/speaker-labels/seat";
import type { LabelContext, LineLabel } from "../../../src/meetings/lib/speaker-labels/types";
import { embedSeatLines } from "../../../src/meetings/lib/speaker-labels/voice";
import { nameByVoice, type VoiceLine } from "../../../src/meetings/lib/voice-names";

const seatSchema = z.enum(["mic", "call"]);
const spanSchema = z.object({
    index: z.number().int(),
    fromSec: z.number(),
    toSec: z.number(),
    seat: seatSchema,
    reference: z.string().optional(),
});
const meetingSchema = z.object({
    key: z.string(),
    id: z.string(),
    audio: z.string(),
    sourceSha: z.string(),
    micChannel: z.union([z.literal(0), z.literal(1)]),
    lines: z.array(spanSchema),
    attended: z.array(z.object({ person: z.string(), seat: seatSchema, fromSec: z.number(), toSec: z.number() })),
    scenario: z.object({ roomPerson: z.string(), owner: z.string(), lateJoiner: z.string() }).optional(),
});
type InputMeeting = z.infer<typeof meetingSchema>;
const sampleSchema = z.object({ meeting: z.string(), index: z.number().int(), person: z.string() });
const verdictSchema = z.object({
    meeting: z.string(),
    line: z.number().int(),
    heard: z.string().nullable().optional(),
    status: z.string().optional(),
    question: z.string().optional(),
});
type Verdict = z.infer<typeof verdictSchema>;

const args = parseArgs({
    options: {
        home: { type: "string" },
        verdicts: { type: "string" },
        seats: { type: "string" },
        samples: { type: "string" },
        meeting: { type: "string" },
        cache: { type: "string" },
        store: { type: "string" },
        "max-batches": { type: "string", default: "8" },
    },
}).values;
if (!args.home || !args.verdicts || !args.seats || !args.samples || !args.meeting || !args.cache) {
    throw new Error(
        "Use --home <isolated-home> --verdicts <json> --seats <json> --samples <json> --meeting <id> --cache <scratch-folder> [--store <scratch-home>]"
    );
}
const home = resolve(args.home);
const cache = resolve(args.cache);
const voiceHome = resolve(args.store ?? join(dirname(cache), "voice-store-home"));
if (voiceHome === home || !voiceHome.startsWith(`${dirname(cache)}/`)) {
    throw new Error("The voice store must be a separate home under the cache's scratch parent");
}
env.testing.set("GENESIS_TOOLS_HOME", home);
const read = (file: string): unknown => SafeJSON.parse(readFileSync(file, "utf8"));
const meetings = z.array(meetingSchema).parse(read(args.seats));
const samples = z.array(sampleSchema).parse(read(args.samples));
const ear = z
    .object({ verdicts: z.array(verdictSchema), gateVerdicts: z.array(verdictSchema) })
    .parse(read(args.verdicts));
const target = meetings.find((meeting) => meeting.id === args.meeting || meeting.key === args.meeting);
if (!target) {
    throw new Error("The meeting is absent from --seats");
}
for (const meeting of meetings) {
    if (!existsSync(genesisToolsDirIn(home, "meetings", meeting.id, "meeting.json"))) {
        throw new Error(`Meeting copy missing: ${meeting.id}`);
    }
}
mkdirSync(cache, { recursive: true });
const targetId = target.id;
const model = localVoiceBackend().model;
const settings = meetingsConfigSchema.parse({}).global.speakerLabels.voice;
const allEmbeddings = new Map<string, VoiceLine[]>();
let batches = 0;
const maxBatches = Number(args["max-batches"]);
if (!Number.isInteger(maxBatches) || maxBatches < 1) {
    throw new Error("--max-batches needs a positive integer");
}

async function embeddings(meeting: InputMeeting, onlySamples: boolean): Promise<VoiceLine[]> {
    const lines = onlySamples
        ? meeting.lines.filter((line) =>
              samples.some((sample) => sample.meeting === meeting.id && sample.index === line.index)
          )
        : meeting.lines;
    const stat = statSync(meeting.audio);
    const fingerprint = createHash("sha256")
        .update(
            SafeJSON.stringify({
                model,
                size: stat.size,
                mtime: stat.mtimeMs,
                audio: meeting.audio,
                channel: meeting.micChannel,
                lines,
            })
        )
        .digest("hex");
    const file = join(cache, `${fingerprint}.json`);
    if (existsSync(file)) {
        const cached: VoiceLine[] = SafeJSON.parse(readFileSync(file, "utf8"));
        return cached;
    }
    const sound = meetingSound({
        folder: genesisToolsDirIn(home, "meetings", meeting.id),
        timelineZeroMs: 0,
        rows: [],
        tracks: "source",
        source: {
            source: "wisprflow",
            path: meeting.audio,
            layout: meeting.micChannel === 0 ? "left-mic" : "right-mic",
            durationSec: Infinity,
        },
    });
    const result: VoiceLine[] = [];
    for (let start = 0; start < lines.length; start += 25) {
        const batchFile = join(cache, `${fingerprint}-${start}.json`);
        if (existsSync(batchFile)) {
            const cached: VoiceLine[] = SafeJSON.parse(readFileSync(batchFile, "utf8"));
            result.push(...cached);
            continue;
        }
        if (batches >= maxBatches) {
            throw new Error("Embedding checkpoint saved; repeat the same command to continue");
        }
        const batch = await embedSeatLines({ lines: lines.slice(start, start + 25), sound });
        writeFileSync(batchFile, SafeJSON.stringify(batch));
        result.push(...batch);
        batches++;
        out.print(`cached ${meeting.key} lines ${start + 1}-${Math.min(start + 25, lines.length)}\n`);
    }
    writeFileSync(file, SafeJSON.stringify(result));
    return result;
}

let store: VoiceStore = { version: 1, model, people: {} };
await env.testing.withOverrides({ GENESIS_TOOLS_HOME: voiceHome }, async () => {
    for (const meeting of meetings) {
        const embedded = await embeddings(meeting, meeting.id !== target.id);
        allEmbeddings.set(meeting.id, embedded);
        for (const sample of samples.filter((sample) => sample.meeting === meeting.id)) {
            const line = embedded.find((line) => line.index === sample.index);
            const channel = line?.channels[0];
            if (!line || channel?.quality !== "ready") {
                continue;
            }
            addVoicePrint(
                "benchmark",
                sample.person,
                {
                    meeting: meeting.id,
                    sourceSha: meeting.sourceSha,
                    seat: line.seat,
                    track: line.track,
                    fromSec: line.fromSec!,
                    toSec: line.toSec!,
                    embedding: channel.embedding,
                    confirmedAt: "ear-confirmed-input",
                },
                channel.model
            );
        }
    }
    store = readVoiceStore("benchmark");
});

const targetLines = allEmbeddings.get(target.id)!;
function labelsFor(attended: LabelContext["attended"], training = store): LineLabel[] {
    // Leave the target line out of its own prototype, including the five-confirmation scenario.
    return targetLines.flatMap((line) => {
        const withoutSelf: VoiceStore = {
            ...training,
            people: Object.fromEntries(
                Object.entries(training.people).map(([person, value]) => [
                    person,
                    {
                        samples: value.samples.filter(
                            (sample) =>
                                sample.meeting !== targetId ||
                                sample.fromSec !== line.fromSec ||
                                sample.toSec !== line.toSec
                        ),
                    },
                ])
            ),
        };
        return nameByVoice({ ...settings, lines: [line], attended, store: withoutSelf });
    });
}
const labels = labelsFor(target.attended);
const context: LabelContext = {
    lines: target.lines,
    attended: target.attended,
    project: "benchmark",
    sound: { tracks: [], slice: () => undefined },
};
const merged = mergeLineLabels(
    new Map([
        ["voice", labels],
        ["seat", await seatLabeler.propose(context)],
    ])
);
const judged = (verdicts: Verdict[], label: LineLabel): string | undefined => {
    const verdict = verdicts.findLast(
        (verdict) => verdict.meeting === target.id && verdict.line === label.index && verdict.status !== "not-judged"
    );
    if (!verdict || !label.person) {
        return undefined;
    }
    if (verdict.status === "doubtful" && verdict.heard !== label.person) {
        return "doubtful";
    }
    return verdict.heard === label.person ? "right" : "wrong";
};
const union = [...ear.verdicts, ...ear.gateVerdicts];
const people = [...new Set(target.attended.map((stay) => stay.person))];
const table = people.map((person) => {
    const named = labels.filter((label) => label.person === person);
    return [
        person,
        named.length,
        merged.filter((label) => label.person === person).length,
        named.filter((label) => judged(ear.verdicts, label) === "right").length,
        named.filter((label) => judged(ear.verdicts, label) === "wrong").length,
        named.filter((label) => judged(ear.gateVerdicts, label) === "right").length,
        named.filter((label) => judged(ear.gateVerdicts, label) === "wrong").length,
        target.lines.filter(
            (line) => line.reference === person && !labels.find((label) => label.index === line.index)?.person
        ).length,
    ];
});
out.print(
    `${formatTable(
        table.map((row) => row.map(String)),
        ["person", "voice named", "all named", "ear right", "ear wrong", "gate right", "gate wrong", "ref left open"]
    )}\n`
);
const beforeJoin = labels.filter(
    (label) =>
        label.person &&
        !target.attended.some(
            (stay) =>
                sameName(stay.person, label.person!) &&
                stay.fromSec <= target.lines.find((line) => line.index === label.index)!.fromSec &&
                stay.toSec >= target.lines.find((line) => line.index === label.index)!.toSec
        )
).length;
const summary = {
    meeting: target.key,
    lines: target.lines.length,
    named: labels.filter((label) => label.person).length,
    allNamed: merged.filter((label) => label.person).length,
    right: labels.filter((label) => judged(union, label) === "right").length,
    wrong: labels.filter((label) => judged(union, label) === "wrong").length,
    doubtful: labels.filter((label) => judged(union, label) === "doubtful").length,
    leftOpen: labels.filter((label) => !label.person).length,
    beforeJoin,
    scenario: {} as Record<string, number>,
};
if (target.scenario) {
    const scenario = target.scenario;
    const attended = target.attended.filter((stay) => stay.person !== scenario.roomPerson);
    const vetoes = labelsFor(attended).filter((label) => label.reason === "not-the-seat-person");
    const roomLines = target.lines.filter(
        (line) =>
            line.reference === scenario.roomPerson &&
            targetLines.find((embedded) => embedded.index === line.index)?.channels[0]?.quality === "ready"
    );
    const extra = roomLines
        .filter((line) =>
            union.some(
                (verdict) =>
                    verdict.meeting === target.id &&
                    verdict.line === line.index &&
                    verdict.heard === scenario.roomPerson
            )
        )
        .slice(0, 5);
    const training = structuredClone(store);
    training.people[scenario.roomPerson] = {
        samples: extra.flatMap((line) => {
            const embedded = targetLines.find((embedded) => embedded.index === line.index)!;
            const channel = embedded.channels[0];
            return channel?.quality === "ready"
                ? [
                      {
                          meeting: target.id,
                          sourceSha: target.sourceSha,
                          seat: embedded.seat,
                          track: embedded.track,
                          fromSec: line.fromSec,
                          toSec: line.toSec,
                          embedding: channel.embedding,
                          confirmedAt: "five-confirmation-simulation",
                      },
                  ]
                : [];
        }),
    };
    const after = labelsFor(target.attended, training);
    summary.scenario = {
        lateJoinerNamed: labels.filter((label) => label.person === scenario.lateJoiner).length,
        roomUsable: roomLines.length,
        roomVetoes: vetoes.filter((label) => roomLines.some((line) => line.index === label.index)).length,
        ownerVetoes: vetoes.filter(
            (label) => target.lines.find((line) => line.index === label.index)?.reference === scenario.owner
        ).length,
        confirmed: extra.length,
        roomNamedAfterFive: after.filter(
            (label) => label.person === scenario.roomPerson && roomLines.some((line) => line.index === label.index)
        ).length,
    };
}
writeFileSync(join(cache, `summary-${target.key}.json`), SafeJSON.stringify(summary));
out.print(`SUMMARY ${SafeJSON.stringify(summary)}\n`);
