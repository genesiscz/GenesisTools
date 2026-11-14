import { nameKey } from "@genesiscz/utils/meetings/people";
import {
    activeSeatPeople,
    type MeetingSeats,
    type MicrophoneGroup,
    meetingSeatsSchema,
    remoteSeatSchema,
} from "@genesiscz/utils/meetings/seats";
import { z } from "zod";
import type { Finding } from "./findings";

export const byChannelOptionsSchema = z
    .object({
        label: z.string().trim().min(1),
        room: z.array(z.string().trim().min(1)).optional(),
        remote: z.array(z.union([z.string().trim().min(1), remoteSeatSchema])).optional(),
        micMax: z.number().min(0).max(1).default(0.2),
        micMin: z.number().min(0).max(1).default(0.85),
        minChars: z.number().int().nonnegative().default(25),
        dryRun: z.boolean().default(true),
        replace: z
            .object({
                kinds: z.array(z.enum(["speaker-range", "question", "label", "join", "term"])).min(1),
                by: z.literal("agent"),
            })
            .optional(),
        askRoom: z
            .object({ minSec: z.number().nonnegative().default(8), max: z.number().int().nonnegative().default(6) })
            .optional(),
    })
    .strict()
    .refine((options) => options.micMax < options.micMin, { message: "micMax must be below micMin" });
export type ByChannelOptions = z.input<typeof byChannelOptionsSchema>;

export interface ChannelLine {
    index: number;
    fromSec: number;
    toSec?: number;
    label: string;
    text: string;
    channel?: { micShare?: number | null };
}
export interface ChannelRun {
    from: number;
    to: number;
    label: string;
    lines: number[];
    micShares: number[];
    candidates: string[];
}
export interface ChannelRange extends ChannelRun {
    kind: "speaker-range";
    speaker: string;
    confidence: number;
    reason: string;
}
export interface ByChannelPlan {
    ranges: ChannelRange[];
    roomOnly: ChannelRun[];
    mixed: ChannelLine[];
    unresolved: ChannelRun[];
    questions: Extract<Finding, { kind: "question" }>[];
    /** The range each room question decides, with no speaker until the question is answered. */
    targets: Extract<Finding, { kind: "speaker-range" }>[];
}

/** The people of a microphone group whose members all hold seats of one kind (`seated`), or none. */
function groupPeople(group: MicrophoneGroup | undefined, seated: readonly string[]): string[] | undefined {
    const keys = new Set(seated.map(nameKey));
    return group?.people.every((person) => keys.has(nameKey(person))) ? group.people.map(nameKey) : undefined;
}

/** A remote seat starts or ends inside the line: one person is not eligible for all of it. */
function seatChangesWithin(seats: MeetingSeats, line: ChannelLine): boolean {
    const toSec = line.toSec;
    return (
        toSec !== undefined &&
        seats.remote.some((seat) =>
            [seat.fromSec, seat.toSec].some((at) => at !== undefined && at > line.fromSec && at < toSec)
        )
    );
}

/** Channel evidence settles a person only when explicit seats leave one candidate. It never judges words. */
export function planByChannel(options: {
    lines: readonly ChannelLine[];
    input: ByChannelOptions;
    seats?: MeetingSeats;
}): ByChannelPlan {
    const input = byChannelOptionsSchema.parse(options.input);
    const seats = meetingSeatsSchema.parse({
        room: input.room ?? options.seats?.room ?? [],
        remote: input.remote ?? options.seats?.remote ?? [],
        ...(options.seats?.microphones ? { microphones: options.seats.microphones } : {}),
    });
    const groups = seats.microphones ?? [];
    const remoteNames = seats.remote.map((seat) => seat.name);
    // The microphone channel is the owner's microphone (group `self`), else a group under this label; the system
    // channel narrows to a remote device group under this label. Without a group every seated person stays possible.
    const labelGroup = groups.find((group) => group.label === input.label);
    const roomGroup =
        groupPeople(
            groups.find((group) => group.id === "self"),
            seats.room
        ) ?? groupPeople(labelGroup, seats.room);
    const remoteGroup = groupPeople(labelGroup, remoteNames);
    const result: ByChannelPlan = {
        ranges: [],
        roomOnly: [],
        mixed: [],
        unresolved: [],
        questions: [],
        targets: [],
    };
    // `run.to` is the last line's start, as a range endpoint; `endSec` is where that line ends, for the duration check.
    let open: { kind: "remote" | "room"; run: ChannelRun; confidence: number; endSec: number } | undefined;
    const flush = () => {
        if (!open) {
            return;
        }

        const { run, kind, confidence, endSec } = open;
        const speaker = run.candidates.length === 1 ? run.candidates[0] : undefined;

        if (speaker) {
            result.ranges.push({
                ...run,
                kind: "speaker-range",
                speaker,
                confidence,
                reason: `${kind === "remote" ? "Remote" : "Room"} voice under ${input.label}: microphone share ${run.micShares.map((value) => Math.round(value * 100)).join(", ")} %. ${kind === "remote" ? `Share <= ${input.micMax * 100}%; one active remote person without an independent label` : `Share >= ${input.micMin * 100}%; one person at the microphone`}.`,
            });
        } else if (kind === "room") {
            result.roomOnly.push(run);

            if (
                input.askRoom &&
                run.candidates.length > 1 &&
                endSec - run.from >= input.askRoom.minSec &&
                result.questions.length < input.askRoom.max
            ) {
                const ref = `room-run-${result.questions.length + 1}`;
                const reason = `Microphone share identifies the room, shared by ${run.candidates.join(", ")}.`;
                // The answer names the speaker of this range, so the run's lines take the person answered.
                result.targets.push({
                    kind: "speaker-range",
                    ref,
                    from: run.from,
                    to: run.to,
                    label: input.label,
                    candidates: run.candidates,
                    confidence,
                    reason,
                });
                result.questions.push({
                    kind: "question",
                    about: "speaker",
                    from: run.from,
                    to: run.to,
                    question: `Who at the microphone speaks under ${input.label} in this range?`,
                    choices: [...run.candidates, "Cannot tell"],
                    decides: [ref],
                    reason,
                });
            }
        } else {
            result.unresolved.push(run);
        }

        open = undefined;
    };

    for (const line of options.lines) {
        // Other labels do not interrupt a room-label run, matching the original worked script.
        if (line.label !== input.label) {
            continue;
        }

        const share = line.channel?.micShare;

        if (share == null || !Number.isFinite(share) || share < 0 || share > 1 || line.text.length < input.minChars) {
            flush();
            continue;
        }

        const kind = share <= input.micMax ? "remote" : share >= input.micMin ? "room" : undefined;

        if (!kind) {
            flush();
            result.mixed.push(line);
            continue;
        }

        const active = activeSeatPeople({ seats, atSec: line.fromSec });
        const candidates =
            kind === "room"
                ? active.room.filter((person) => !roomGroup || roomGroup.includes(nameKey(person)))
                : seatChangesWithin(seats, line)
                  ? []
                  : active.remote
                        .filter((person) =>
                            remoteGroup
                                ? remoteGroup.includes(nameKey(person.name))
                                : !person.label || person.label === input.label
                        )
                        .map((person) => person.name);
        const confidence = kind === "room" ? 0.85 : active.remote.length === 1 ? 0.8 : 0.7;

        if (
            open &&
            (open.kind !== kind ||
                open.confidence !== confidence ||
                open.run.candidates.join("\0") !== candidates.join("\0"))
        ) {
            flush();
        }

        open ??= {
            kind,
            confidence,
            run: { from: line.fromSec, to: line.fromSec, label: input.label, lines: [], micShares: [], candidates },
            endSec: line.fromSec,
        };
        open.run.to = line.fromSec;
        open.endSec = Math.max(open.endSec, line.toSec ?? line.fromSec);
        open.run.lines.push(line.index);
        open.run.micShares.push(share);
    }

    flush();
    return result;
}
