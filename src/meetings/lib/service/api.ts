import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { defineApi, defineMethod } from "@genesiscz/utils/api-descriptor";
import { MEETINGS_CONFLICT_CODES, MEETINGS_STATE_CODES } from "@genesiscz/utils/meetings/conflict";
import { meetingRecordSchema } from "@genesiscz/utils/meetings/record";
import type { SpeakerHint, SpeakerLeave } from "@genesiscz/utils/transcribe/speakers";
import { z } from "zod";
import { decisionActionSchema, journalEntrySchema, skipSchema } from "../decision-actions";
import { MOMENT_ERROR_CODES, MOMENT_STATE_CODES, momentSchema, momentTargetSchema } from "../moment-schema";
import type { MeetingsOverview } from "../overview";

/**
 * The Meetings service's interface: one descriptor for the window, every `tools meetings` command, the REPL and an MCP
 * door (ArchitectureReview candidate 0). The service (`tools meetings serve`) answers it over newline-delimited
 * JSON-RPC 2.0 on a Unix socket; a command without a service answers the same methods in its own process
 * (`client.ts`). The protocol fixture `__fixtures__/meetings-protocol.json` holds one request and reply per method; the
 * Swift client decodes it, and `service.test.ts` checks it against these schemas.
 *
 * This module stays light (zod and the record schema): every `tools meetings` read imports it.
 */

/** The protocol number `hello` names; a client that speaks another one uses its in-process adapter. */
export const MEETINGS_PROTOCOL = 1;

/**
 * Who a connection is: the Meetings window, a `tools meetings` command, `tools meetings listen`, or an agent (the REPL,
 * an MCP door). A decision on the connection takes its actor from its `hello` (F5).
 */
export const MEETINGS_ROLES = ["window", "cli", "listen", "agent"] as const;
export type MeetingsRole = (typeof MEETINGS_ROLES)[number];

/** A meeting as a command names it: an id, a unique prefix, `last`, or `wisprflow:<id>`. */
const meetingRef = z.string().min(1);

export const helloParamsSchema = z.object({
    role: z.enum(MEETINGS_ROLES),
    /** The agent harness behind the caller (`claude-code`, `codex`), from `whoIsCalling`; absent for a person. */
    harness: z.string().min(1).optional(),
    /** The caller's agent session id, when it runs in one. */
    session: z.string().min(1).optional(),
    protocol: z.number().int(),
    /**
     * The caller's code stamp (`meetingsCodeStamp()`): the checkout its code runs from. A service of another checkout,
     * or one whose code changed since it started, refuses it with `code-mismatch`, and a CLI answers in-process then.
     * The window, which runs no TypeScript, sends none.
     */
    code: z.string().min(1).optional(),
    pid: z.number().int().positive().optional(),
});
export type MeetingsHello = z.output<typeof helloParamsSchema>;

export const helloResultSchema = z.object({
    protocol: z.number().int(),
    /** The service's code stamp. */
    code: z.string(),
    /** Every method the service answers, `subscribe` included. */
    methods: z.array(z.string()),
    /** The events `subscribe` can name. */
    events: z.array(z.string()),
    /** A fingerprint of the protocol number and the method list. */
    version: z.string(),
});

/** One meeting as `list --json` prints it (`meetingListRow`, src/meetings/lib/list-rows.ts). */
export const meetingListRowSchema = z.object({
    id: z.string(),
    title: z.string(),
    start: z.string(),
    end: z.string().optional(),
    project: z.string().optional(),
    labels: z.array(z.string()),
    sources: z.array(z.string()),
    context: z.number().int().nonnegative(),
    items: z.object({
        suggested: z.number().int().nonnegative(),
        confirmed: z.number().int().nonnegative(),
        rejected: z.number().int().nonnegative(),
    }),
    recording: z
        .object({ status: z.string().optional(), frames: z.number().nonnegative(), bytes: z.number().nonnegative() })
        .optional(),
});

/**
 * One corrected transcript line, as `transcript --format json` prints it; the service adds `endSec` (the next timed
 * line's start, at least a moment after its own), so a player highlights the line it hears (G-TR-1).
 */
export const transcriptLineSchema = z.object({
    id: z.string().optional(),
    startSec: z.number().optional(),
    endSec: z.number().optional(),
    speakerId: z.number().optional(),
    speaker: z.string(),
    text: z.string(),
});

/** The token per window part (`WindowRevisions`, window-reads.ts); null: the source cannot tell, read it again. */
export const revisionsResultSchema = z.object({
    meeting: z.string(),
    show: z.string(),
    transcript: z.string().nullable(),
    speakers: z.string().nullable(),
    timeline: z.string().nullable(),
});

const hello = defineMethod({
    name: "hello",
    params: helloParamsSchema,
    result: helloResultSchema,
    doc: "Says once who the connection is (role, harness, session). Another protocol is refused with `protocol-mismatch`, another checkout's code or a code change since the start with `code-mismatch`; a CLI then answers in its own process.",
    effect: "read",
});

const list = defineMethod({
    name: "meetings.list",
    params: z
        .object({
            /** Only this project's meetings. */
            project: z.string().min(1).optional(),
            /** Only the newest n, after `project`. */
            limit: z.number().int().positive().optional(),
            /** The whole records instead of the list rows. */
            full: z.boolean().optional(),
        })
        .strict(),
    result: z.union([z.array(meetingListRowSchema), z.array(meetingRecordSchema)]),
    resultName: "MeetingListRow[] | MeetingRecord[]",
    doc: "The meetings, newest first, as `list --json` prints them; full: true answers the whole records (`list --json --full`).",
    effect: "read",
});

const show = defineMethod({
    name: "meeting.show",
    params: z.object({ ref: meetingRef }).strict(),
    positional: ["ref"],
    result: meetingRecordSchema,
    resultName: "MeetingRecord",
    doc: "One meeting record, as `show <meeting> --json` prints it. No meeting: `meeting-not-found`; a prefix of two: `meeting-ref`.",
    effect: "read",
});

const transcript = defineMethod({
    name: "meeting.transcript",
    params: z
        .object({
            ref: meetingRef,
            /** Also apply the suggested items at or above the apply bar (a preview). */
            withSuggested: z.boolean().optional(),
            /** False leaves the dictionary out. */
            dictionary: z.boolean().optional(),
        })
        .strict(),
    positional: ["ref"],
    result: z.object({ meeting: z.string(), entries: z.array(transcriptLineSchema) }),
    resultName: "{ meeting, entries: { id?, startSec?, speakerId?, speaker, text }[] }",
    doc: "The corrected transcript, as `transcript <meeting> --format json` prints it. A meeting without a transcript source: `no-transcript-source`.",
    effect: "read",
});

const revisions = defineMethod({
    name: "meeting.revisions",
    params: z.object({ ref: meetingRef }).strict(),
    positional: ["ref"],
    result: revisionsResultSchema,
    resultName: "{ meeting, show, transcript, speakers, timeline }",
    doc: "One token per window part, as `revisions <meeting> --json` prints it: an equal token means the part would read the same. Reads no transcript and no frame.",
    effect: "read",
});

/** A decision's request: the meeting, one action, and the reason kept with it (one word for a comment and a reason). */
const decisionParams = z
    .object({
        meeting: meetingRef,
        action: decisionActionSchema,
        /** Why: kept on the journal entry and on each item it decides (`decision.entry.reason`). */
        reason: z.string().optional(),
    })
    .strict();

/** What a decision did: its journal entry (absent when it changed nothing) and each named item it left, with why. */
const decidedSchema = z.object({
    entry: journalEntrySchema.optional(),
    skipped: z.array(skipSchema),
    /** Notes besides the skips: an added finding whose transcript anchor did not match. */
    warnings: z.array(z.string()).optional(),
});

/** What a planned decision reaches beyond the items it names (`DecisionReach`, decision-journal.ts). */
export const decisionReachSchema = z.object({
    items: z.array(z.object({ id: z.string(), match: z.literal("same") })),
    lines: z.number().int().nonnegative().optional(),
    dictionary: z.array(
        z.object({
            project: z.string().optional(),
            heard: z.string(),
            fixed: z.string(),
            seenBefore: z.number().int().nonnegative(),
            teaches: z.boolean(),
        })
    ),
});

const decisionPlan = defineMethod({
    name: "decision.plan",
    params: decisionParams,
    result: decidedSchema.extend({ reach: decisionReachSchema }),
    resultName: "{ entry?, skipped, reach: { items, lines?, dictionary } }",
    doc: "The decision `decision.apply` would make now, and what it reaches beyond the named items (look-alikes it settles, the lines a spelling changes, the dictionary it teaches), without saving anything. The window asks it before an answer or a spelling with a reach (R22).",
    effect: "read",
});

const decisionApply = defineMethod({
    name: "decision.apply",
    params: decisionParams.extend({
        /**
         * `refuse`: an item someone else decided since the caller saw it refuses the call with `already-decided`, its
         * data naming the items and the entry that decided them (the window). `skip` (the default, the CLI's): such
         * an item is skipped with its reason.
         */
        onDecided: z.enum(["skip", "refuse"]).optional(),
    }),
    result: decidedSchema,
    resultName: "{ entry?, skipped, warnings? }",
    doc: "Makes one decision through the decision journal, as the connection's hello names the actor (window, listen, an agent and its session, or a command), and tells the subscribers `decision.applied` with the entry. Refused when an item is unknown (`failed`) or, with onDecided: refuse, decided already (`already-decided`).",
    effect: "reversible",
});

const decisionRevert = defineMethod({
    name: "decision.revert",
    params: z
        .object({
            meeting: meetingRef,
            /** The entry to undo: `decision.apply`'s entry token, `confirm --json`'s token, an item's `decision.token`. */
            token: z.string().min(1),
            /** Only these of its items (ids or Q12); all of them when absent. A question named brings back its whole answer. */
            items: z.array(z.string().min(1)).optional(),
            reason: z.string().optional(),
        })
        .strict(),
    result: decidedSchema,
    resultName: "{ entry?, skipped }",
    doc: "Undoes one journal entry, or only some of its items, and tells the subscribers `decision.reverted`. Refused with `item-changed` when a later decision changed one of them.",
    effect: "reversible",
});

const journalRead = defineMethod({
    name: "journal.read",
    params: z
        .object({
            meeting: meetingRef,
            /** Only the entries that changed this item (an id or Q12). */
            item: z.string().min(1).optional(),
            limit: z.number().int().positive().optional(),
        })
        .strict(),
    result: z.object({
        meeting: z.string(),
        entries: z.array(journalEntrySchema.extend({ revertedBy: z.string().optional() })),
    }),
    resultName: "{ meeting, entries: JournalEntry & { revertedBy? }[] }",
    doc: "A meeting's decision journal, newest first, as `journal <meeting> --json` prints it: who decided what, when and why, with every item before and after.",
    effect: "read",
});

/** A Moment's request: the meeting, what to play, and the pad around it (the setting's when absent). */
const momentParams = z
    .object({
        meeting: meetingRef,
        target: momentTargetSchema,
        /** Seconds of audio around an item, a range or a selection; `playback.listen.padSec` when absent. */
        padSec: z.number().min(0).max(60).optional(),
        /** False skips the screen frames at the spot. */
        screen: z.boolean().optional(),
    })
    .strict();

/** Why a Moment cannot play: the target's own refusal (then no Moment), or a state of this Mac or meeting. */
const momentCannotSchema = z.object({
    code: z.enum([...MOMENT_ERROR_CODES, ...MOMENT_STATE_CODES]),
    message: z.string(),
});

const momentPlan = defineMethod({
    name: "moment.plan",
    params: momentParams,
    result: z.object({ moment: momentSchema.optional(), cannot: momentCannotSchema.optional() }),
    resultName: "{ moment?: Moment, cannot?: { code, message } }",
    doc: "The Moment of a target (its span, pad, asked spot `spotSec`, tone at `tone.atSec`, and the screen frame with the OCR hit first), and why it cannot play when it cannot: a target refusal (unknown-item, too-long, past-the-end, …: no Moment) or a state (no-audio, recording, no-ffmpeg: the Moment stays). Cuts nothing.",
    effect: "read",
});

const momentClip = defineMethod({
    name: "moment.clip",
    params: momentParams,
    result: momentSchema.extend({ path: z.string() }),
    resultName: "Moment & { path }",
    doc: "The Moment cut to a WAV in the clip cache (a clip cut before for the same recording is used again). Reports `$/progress` while ffmpeg cuts and stops on `$/cancel`; a newer moment.clip on the same connection cancels the older cut (answered with 1013, cancelled). Refused with `unplayable` and data.reason (a moment.plan code). Writes only the cache.",
    effect: "read",
});

const tonePreview = defineMethod({
    name: "tone.preview",
    params: z
        .object({
            /** The sound to hear; the meetings config's `playback.listen.tone.sound` when absent. */
            sound: z
                .object({
                    hz: z.number().min(50).max(8000),
                    sec: z.number().min(0.02).max(2),
                    volume: z.number().min(0).max(1),
                })
                .optional(),
        })
        .strict(),
    result: z.object({ path: z.string(), sound: z.object({ hz: z.number(), sec: z.number(), volume: z.number() }) }),
    resultName: "{ path, sound }",
    doc: "The tone alone as a WAV in the clip cache, for a sound picker's Play button (a preset writes its hz, sec and volume).",
    effect: "read",
});

const meetingAudio = defineMethod({
    name: "meeting.audio",
    params: z.object({ meeting: meetingRef }).strict(),
    result: z.object({
        path: z.string(),
        /** Audio streams: one plays as the file; more are mixed into rolling Moments. */
        tracks: z.number().int().nonnegative(),
        channels: z.number().int().nonnegative(),
        durationSec: z.number().nonnegative(),
    }),
    resultName: "{ path, tracks, channels, durationSec }",
    doc: "The meeting's recording on this Mac, from ffprobe: the window plays it directly when it has one track (an instant seek, R3, R4). Refused with `unplayable` (no-audio) when no source keeps it.",
    effect: "read",
});

const speakerSpanSchema = z.object({ fromSec: z.number(), toSec: z.number(), turns: z.number() });

const meetingSpeakers = defineMethod({
    name: "meeting.speakers",
    params: z
        .object({
            meeting: meetingRef,
            /** A silence this long ends a span (`speakers stats --gap`); 120 s when absent. */
            gapSec: z.number().positive().optional(),
            /** The attendance source (`zoom`, `meet`…); the record's when absent. */
            attendance: z.string().min(1).optional(),
        })
        .strict(),
    result: z.object({
        meeting: z.string(),
        gapSec: z.number(),
        /** False when no line has a time: then the lanes show nothing, only counts. */
        timed: z.boolean(),
        speakers: z.array(
            z.object({
                label: z.string(),
                speakerId: z.number().optional(),
                origin: z.enum(["platform", "llm", "self", "unknown"]),
                turns: z.number(),
                lines: z.number(),
                words: z.number(),
                spokenSec: z.number(),
                firstSec: z.number().optional(),
                lastSec: z.number().optional(),
                spans: z.array(speakerSpanSchema),
                leaves: z.array(z.custom<SpeakerLeave>((value) => typeof value === "object" && value !== null)),
            })
        ),
        /**
         * Hints (`SpeakerHint`, src/utils/transcribe/speakers.ts): each names its kind, label and strength; the
         * attendance hints carry ranges with fromSec, toSec and present.
         */
        hints: z.array(z.custom<SpeakerHint>((value) => typeof value === "object" && value !== null)),
    }),
    resultName: "{ meeting, gapSec, timed, speakers: SpeakerStat[], hints: SpeakerHint[] }",
    doc: "Per label its turns, spoken time and spans, and the hints against labels with their ranges (fromSec, toSec, present), as `speakers stats --json` prints them: the Speakers tab's talk-time lanes and range chips.",
    effect: "read",
});

const meetingScreen = defineMethod({
    name: "meeting.screen",
    params: z
        .object({
            meeting: meetingRef,
            fromSec: z.number().min(0).optional(),
            toSec: z.number().min(0).optional(),
            /** Only this display's frames. */
            display: z.number().int().optional(),
        })
        .strict(),
    result: z.object({
        meeting: z.string(),
        /** False without a screen recording: no pane, and the dock keeps its height (G-SCR-2). */
        recorded: z.boolean(),
        displays: z.array(z.object({ id: z.number().optional(), name: z.string().optional(), frames: z.number() })),
        frames: z.array(
            z.object({
                file: z.string(),
                path: z.string(),
                meetingSec: z.number(),
                displayId: z.number().optional(),
                width: z.number(),
                height: z.number(),
                lineCount: z.number(),
            })
        ),
    }),
    resultName:
        "{ meeting, recorded, displays, frames: { file, path, meetingSec, displayId?, width, height, lineCount }[] }",
    doc: "The screen frames by time, oldest first, between fromSec and toSec (all without them): what the timeline shows beside the sound (R41).",
    effect: "read",
});

const meetingWaveform = defineMethod({
    name: "meeting.waveform",
    params: z
        .object({
            meeting: meetingRef,
            fromSec: z.number().min(0).optional(),
            toSec: z.number().min(0).optional(),
            /** How many peaks the span is cut into. */
            buckets: z.number().int().min(1).max(4000),
        })
        .strict(),
    result: z.object({
        meeting: z.string(),
        fromSec: z.number(),
        toSec: z.number(),
        /** The loudest 100 ms of each bucket, 0 to 1 of the recording's loudest; empty when `cannot`. */
        peaks: z.array(z.number()),
        cannot: z.object({ code: z.enum(["no-audio", "no-ffmpeg", "mono"]), message: z.string() }).optional(),
    }),
    resultName: "{ meeting, fromSec, toSec, peaks: number[], cannot? }",
    doc: "Peaks of the recording for the whole-conversation strip and the zoomed timeline (R47), from the channel energy kept per meeting (rebuilt only when the recording is newer).",
    effect: "read",
});

const overview = defineMethod({
    name: "meetings.overview",
    params: z.object({ days: z.number().positive().optional() }).strict(),
    result: z.custom<MeetingsOverview>((value) => typeof value === "object" && value !== null),
    resultName: "MeetingsOverview",
    doc: "The meetings of the last days (14 when absent) with what each waits for, as `overview --json` prints it.",
    effect: "read",
});

const configRead = defineMethod({
    name: "config.read",
    params: z.object({ path: z.string().min(1).optional() }).strict(),
    result: z.object({ path: z.string(), value: z.unknown() }),
    resultName: "{ path, value }",
    doc: "The meetings config file's path and the value at a dotted path (the whole config without one), as `config show --json` prints it. An unknown path is refused.",
    effect: "read",
});

const configChangeResult = z.object({ path: z.array(z.string()), value: z.unknown() });

const configSet = defineMethod({
    name: "config.set",
    params: z
        .object({
            path: z.string().min(1),
            value: z.unknown(),
            /** The value this change replaces; refused with `config-stale` when another editor changed it. */
            expect: z.unknown().optional(),
        })
        .strict(),
    result: configChangeResult,
    resultName: "{ path: string[], value }",
    doc: "Sets one meetings config value, as `config set --json` does; an engine value (pad, tone, longestClipSec) applies from the next clip.",
    effect: "reversible",
});

const configUnset = defineMethod({
    name: "config.unset",
    params: z.object({ path: z.string().min(1), expect: z.unknown().optional() }).strict(),
    result: configChangeResult,
    resultName: "{ path: string[], value }",
    doc: "Puts one meetings config value back to its default, as `config unset --json` does.",
    effect: "reversible",
});

export const meetingsApi = defineApi({
    id: "meetings-service",
    global: "meetings",
    title: "Meetings service",
    summary:
        "The one owner of the meetings store while it runs: typed reads for the Meetings window, the CLI and agents, and events for the open meeting.",
    methods: [
        hello,
        list,
        show,
        transcript,
        revisions,
        decisionPlan,
        decisionApply,
        decisionRevert,
        journalRead,
        momentPlan,
        momentClip,
        tonePreview,
        meetingAudio,
        meetingSpeakers,
        meetingScreen,
        meetingWaveform,
        overview,
        configRead,
        configSet,
        configUnset,
    ],
    notes: [
        "`subscribe { meeting?, events? }` (answered by the transport) starts the notifications; no events: all of them, no meeting: every meeting's.",
        "A refusal is JSON-RPC error 1100 with `data.code` naming why (MEETINGS_ERROR_CODES).",
    ],
});

export type MeetingsMethod = (typeof meetingsApi)["methods"][number]["name"];
type MethodNamed<M extends MeetingsMethod> = Extract<(typeof meetingsApi)["methods"][number], { name: M }>;
export type MeetingsParams<M extends MeetingsMethod> = z.input<MethodNamed<M>["params"]>;
/** A method's params as its handler gets them: parsed by the descriptor (defaults filled, times as seconds). */
export type MeetingsParsedParams<M extends MeetingsMethod> = z.output<MethodNamed<M>["params"]>;
export type MeetingsResult<M extends MeetingsMethod> = z.output<MethodNamed<M>["result"]>;

/** The method a name names. */
export function meetingsMethod<M extends MeetingsMethod>(name: M): MethodNamed<M> {
    const method = meetingsApi.methods.find((each) => each.name === name);

    if (!method) {
        throw new Error(`the meetings service has no method ${name}`);
    }

    return method as MethodNamed<M>;
}

/** The transport's subscription method, which every Meetings service answers besides its descriptor's methods. */
export const SUBSCRIBE = "subscribe";

/** The transport's end of a subscription: the connection hears no event until it subscribes again. */
export const UNSUBSCRIBE = "unsubscribe";

/**
 * The parts of a meeting a `meeting.changed` names: the window parts of `meeting.revisions`, so a subscriber reads
 * again only those.
 */
export const MEETING_PARTS = ["show", "transcript", "speakers", "timeline"] as const;

/**
 * The events a subscriber can name. A decision through the service tells `decision.applied` or `decision.reverted`
 * with its journal entry; a write by anyone else (the recorder, an import, a hand edit) tells `meeting.changed`.
 */
export const MEETINGS_EVENTS = ["meeting.changed", "decision.applied", "decision.reverted"] as const;
export type MeetingsEvent = (typeof MEETINGS_EVENTS)[number];

export const subscribeParamsSchema = z.object({
    /** Only this meeting's events (an exact id); absent: every meeting's. Anything else is refused (-32602). */
    meeting: z.string().min(1).optional(),
    /** Only these events; absent or empty: all of them. */
    events: z.array(z.string()).optional(),
});
export const subscribeResultSchema = z.object({ events: z.array(z.string()) });

export const NOTIFICATION_SCHEMAS = {
    /** A meeting's files changed: the parts whose `meeting.revisions` token would differ now. */
    "meeting.changed": z.object({ meeting: z.string(), parts: z.array(z.enum(MEETING_PARTS)).min(1) }),
    /** A decision was made through the service: its journal entry, with its actor, reason and every item it changed. */
    "decision.applied": z.object({ meeting: z.string(), entry: journalEntrySchema }),
    /** An entry was undone (`token`), whole or in part: the revert's own entry. */
    "decision.reverted": z.object({ meeting: z.string(), token: z.string(), entry: journalEntrySchema }),
} satisfies Record<MeetingsEvent, z.ZodType>;
export type MeetingsNotification<E extends MeetingsEvent> = z.output<(typeof NOTIFICATION_SCHEMAS)[E]>;

/** The JSON-RPC error code of every refusal of the Meetings service; `data.code` says which one. */
export const MEETINGS_REFUSED = 1100;

/**
 * Why the service refused a call, as `data.code` carries it. A conflict or a meeting state keeps its code from
 * `@genesiscz/utils/meetings/conflict`, so the CLI prints the same `[code] sentence` and the window shows its empty
 * state or its reload offer by the code.
 */
export const MEETINGS_ERROR_CODES = [
    ...MEETINGS_CONFLICT_CODES,
    ...MEETINGS_STATE_CODES,
    /** No meeting has that id, prefix or source. */
    "meeting-not-found",
    /** The reference names no meeting it can read: a prefix of two meetings, a source the store cannot reach. */
    "meeting-ref",
    /** `hello` named another protocol number. */
    "protocol-mismatch",
    /** `hello` named another checkout's code, or the service's code changed since it started. */
    "code-mismatch",
    /**
     * `decision.apply` with onDecided: refuse named an item someone decided since: data `{ code, items, entry? }`,
     * the entry that decided the first of them.
     */
    "already-decided",
    /** A Moment cannot be cut or the recording read: data `{ code, reason }`, reason a `moment.plan` code. */
    "unplayable",
    /** The first call on the connection was not `hello`. */
    "no-hello",
    /** Anything else: the message says what. */
    "failed",
] as const;
export type MeetingsErrorCode = (typeof MEETINGS_ERROR_CODES)[number];

export const meetingsErrorDataSchema = z.object({ code: z.enum(MEETINGS_ERROR_CODES) });

/** Every method `hello` lists: the descriptor's and the transport's `subscribe` and `unsubscribe`. */
export const MEETINGS_METHODS: readonly string[] = [
    ...meetingsApi.methods.map((method) => method.name),
    SUBSCRIBE,
    UNSUBSCRIBE,
];

/** The protocol's fingerprint, which `hello` answers: a change of the method or event list is a new version. */
export function meetingsProtocolVersion(): string {
    const text = `${MEETINGS_PROTOCOL}\n${[...MEETINGS_METHODS].sort().join("\n")}\n${[...MEETINGS_EVENTS].sort().join("\n")}`;
    return createHash("sha1").update(text).digest("hex").slice(0, 12);
}

/** The checkout this code runs from (src/meetings/lib/service/ is four levels below it), as a decoded path. */
export function meetingsSourceRoot(): string {
    // fileURLToPath, not `.pathname`: a checkout path with a space would stay `%20` and match no loaded module.
    return fileURLToPath(new URL("../../../../", import.meta.url));
}

/**
 * The code stamp `hello` compares: the checkout this code runs from. A worktree's CLI and the main checkout's service
 * differ, so the worktree answers in its own process with its own code; a change of the code inside one checkout is
 * the service's own check (it refuses and exits, `service.ts`).
 */
export function meetingsCodeStamp(root = meetingsSourceRoot()): string {
    return createHash("sha1").update(root).digest("hex").slice(0, 12);
}
