import { jsonSchemaOf, typeDeclarations, undeclaredKeys } from "@genesiscz/utils/api-descriptor";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { SafeJSON } from "@genesiscz/utils/json";
import { echoMetricSchema } from "@genesiscz/utils/meetings/echo";
import { meetingItemSchema, meetingRecordSchema } from "@genesiscz/utils/meetings/record";
import { storedMeetingSeatsSchema } from "@genesiscz/utils/meetings/seats";
import { lineVoiceSchema } from "@genesiscz/utils/meetings/voice-features";
import { z } from "zod";
import { reviewRowsSchema } from "./review-row-schema";
import { meetingsMethod, voicesPreview } from "./service/api";

/**
 * The JSON each `tools meetings` command prints for an agent, declared once: `tools meetings schema <name>` prints
 * these as TypeScript or JSON Schema, and the command tests check that the printed JSON has no key they lack. A title
 * (`.meta({ title })`) makes a part a named type of its own.
 */

const stay = z
    .object({
        fromSec: z.number(),
        toSec: z.number(),
        source: z.string().optional(),
        leaveSource: z.string().optional(),
        confidence: z.number().optional(),
    })
    .meta({ title: "Stay" });

const person = z
    .object({
        name: z.string(),
        origin: z.string().optional(),
        role: z.string().optional(),
        aliases: z.array(z.string()).optional(),
        self: z.boolean().optional(),
        firstSeenSec: z.number().optional(),
        stays: z.array(stay),
    })
    .meta({ title: "Person" });

const indicatorReason = z.enum(["meeting-dominance", "stretch-stuck"]);

const line = z
    .object({
        index: z.number().int(),
        fromSec: z.number(),
        toSec: z.number(),
        label: z.string(),
        labelOrigin: z.string().optional(),
        text: z.string(),
        /** Calibrated microphone energy, falling back to the capture segments; null when neither covers the line. */
        channel: z.object({ micShare: z.number().nullable() }),
        energyMicShare: z.number().optional(),
        rawEnergyMicShare: z.number().optional(),
        acoustic: echoMetricSchema.meta({ title: "EchoMetric" }).optional(),
        acousticQuality: z.union([echoMetricSchema.shape.quality, z.literal("unknown")]).optional(),
        liveName: z.string().optional(),
        /** Everyone the platform showed speaking during the line, most often first. */
        speaking: z.array(z.string()),
        speakingUnknown: z.boolean().optional(),
        indicatorIgnored: indicatorReason.optional(),
        indicatorReason: indicatorReason.optional(),
        speakingSignal: z.literal("no-signal").optional(),
        speakingSignalReason: indicatorReason.optional(),
        muted: z.array(z.string()),
        localSpeechOutput: z.literal(true).optional(),
        present: z.array(z.string()),
        /** `--voices`, `--voice-features`: the line's measured voice. */
        voiceFeatures: lineVoiceSchema.meta({ title: "LineVoice" }).optional(),
        /** The people the line's device can name. */
        deviceCandidates: z.array(z.string()),
    })
    .meta({ title: "Line" });

const span = z.object({ fromSec: z.number(), toSec: z.number() });

const evidenceMeeting = z
    .object({
        id: z.string(),
        seats: storedMeetingSeatsSchema.meta({ title: "Seats" }).optional(),
        indicator: z
            .object({ signal: z.literal("no-signal"), dominant: z.object({ name: z.string(), share: z.number() }) })
            .optional(),
        title: z.string(),
        start: z.string(),
        end: z.string().optional(),
        platform: z.string().optional(),
        channelLayout: z.string().optional(),
        callSilent: z.array(span).optional(),
        indicatorGaps: z.array(span.extend({ reason: z.string() })).optional(),
        labels: z
            .array(
                z.object({
                    label: z.string(),
                    firstOwnIndicatorSec: z.number().optional(),
                    firstJoinSec: z.number().optional(),
                    fromSec: z.number().optional(),
                    toSec: z.number().optional(),
                    lines: z.number().int(),
                })
            )
            .optional(),
    })
    .meta({ title: "EvidenceMeeting" });

const screenRecord = z
    .union([
        z.object({ recorded: z.literal(false), note: z.string() }),
        z.object({
            recorded: z.literal(true),
            ocr: z.string(),
            frames: z.number().int(),
            pending: z.number().int(),
            fromSec: z.number(),
            toSec: z.number(),
            leads: z.object({ windowSec: z.number(), linesPerLead: z.number().int() }).optional(),
            read: z.string(),
        }),
    ])
    .meta({ title: "ScreenRecord" });

/** The term part keeps its own shapes; this names its parts, and their entries are not described here yet. */
const terms = z
    .object({
        wordCheck: z.object({
            available: z.boolean(),
            provider: z.string().optional(),
            language: z.string().optional(),
            reason: z.string().optional(),
        }),
        vocabulary: z.array(z.unknown()),
        runs: z.array(z.unknown()),
        unknown: z.array(z.unknown()),
        documents: z.object({ readAloud: z.array(z.unknown()), identifiers: z.array(z.unknown()) }).optional(),
    })
    .meta({ title: "Terms" });

const voiceReadiness = z
    .object({
        seats: z.boolean(),
        samples: z.number().int(),
        people: z.record(z.string(), z.number().int()),
        ready: z.boolean(),
        hints: z.array(z.string()),
    })
    .meta({ title: "VoiceReadiness" });

/** `evidence --raw`: the facts of a meeting for an agent to reason over, per line and per person. */
export const evidenceOutputSchema = z.object({
    indicator: z.object({ knownLines: z.number().int(), unknownLines: z.number().int() }).optional(),
    meeting: evidenceMeeting,
    people: z.array(person),
    lines: z.array(line),
    terms: terms.optional(),
    screen: screenRecord.optional(),
    context: z.array(z.object({ kind: z.string(), ref: z.string() })),
    summary: z
        .object({
            text: z.string(),
            points: z.array(
                z.object({
                    kind: z.enum(["action", "decision"]),
                    person: z.string().optional(),
                    text: z.string(),
                    keyWords: z.array(z.string()),
                })
            ),
        })
        .optional(),
    voice: voiceReadiness,
});

const item = meetingItemSchema.meta({ title: "Item" });

const seatsRpc = meetingsMethod("meeting.seats.suggest");

/** One output: the command that prints it and its declared shape. */
export interface MeetingOutput {
    command: string;
    schema: z.ZodType;
}

export const MEETING_OUTPUT_NAMES = [
    "evidence",
    "items",
    "suggest",
    "rows",
    "voices-preview",
    "seats",
    "show",
] as const;
export type MeetingOutputName = (typeof MEETING_OUTPUT_NAMES)[number];

export const MEETING_OUTPUTS = {
    evidence: { command: toolCommand("meetings", "evidence") + " <meeting> --raw", schema: evidenceOutputSchema },
    items: { command: toolCommand("meetings", "items") + " <meeting> --json", schema: z.array(item) },
    suggest: { command: toolCommand("meetings", "suggest") + " <meeting> --json", schema: z.array(item) },
    rows: { command: toolCommand("meetings", "rows") + " <meeting> --json", schema: reviewRowsSchema },
    "voices-preview": {
        command: toolCommand("meetings", "voices", "preview") + " <meeting> --json",
        schema: voicesPreview.result,
    },
    seats: {
        command: toolCommand("meetings", "seats") + " <meeting> --json",
        schema: seatsRpc.result.extend({
            saved: z.boolean(),
            unresolved: z.array(z.object({ name: z.string(), room: z.string(), remote: z.string() })),
        }),
    },
    show: {
        command: toolCommand("meetings", "show") + " <meeting> --json",
        schema: meetingRecordSchema.extend({ voice: voiceReadiness }),
    },
} satisfies Record<MeetingOutputName, MeetingOutput>;

export const SCHEMA_FORMATS = ["ts", "json-schema"] as const;
export type SchemaFormat = (typeof SCHEMA_FORMATS)[number];

function typeName(name: MeetingOutputName): string {
    return `${name
        .split("-")
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join("")}Output`;
}

/**
 * `schema`: the declared shape of one command's JSON, as TypeScript declarations (each named part once) or as JSON
 * Schema; without a name, the names and the commands they describe.
 */
export function outputSchemaText(options: { name?: MeetingOutputName; format?: SchemaFormat } = {}): string {
    const { name, format = "ts" } = options;

    if (!name) {
        return MEETING_OUTPUT_NAMES.map((one) => `${one}: ${MEETING_OUTPUTS[one].command}`).join("\n");
    }

    const output: MeetingOutput = MEETING_OUTPUTS[name];
    const schema = jsonSchemaOf(output.schema, "output");

    if (format === "json-schema") {
        return SafeJSON.stringify(schema, null, 2);
    }

    return `// ${output.command}\n${typeDeclarations(typeName(name), schema)}`;
}

/** The keys of a command's printed JSON that its declared shape lacks (`$.lines[0].extra`); empty when none. */
export function undeclaredOutputKeys(name: MeetingOutputName, json: unknown): string[] {
    return undeclaredKeys(json, jsonSchemaOf(MEETING_OUTPUTS[name].schema, "output"));
}

export type EvidenceOutput = z.input<typeof evidenceOutputSchema>;
export type ItemsOutput = z.input<(typeof MEETING_OUTPUTS)["items"]["schema"]>;
export type SeatsOutput = z.input<(typeof MEETING_OUTPUTS)["seats"]["schema"]>;
