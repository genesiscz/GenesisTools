import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { defineApi, defineMethod } from "@genesiscz/utils/api-descriptor";
import { MEETINGS_CONFLICT_CODES, MEETINGS_STATE_CODES } from "@genesiscz/utils/meetings/conflict";
import {
    type KnownPeople,
    type KnownPerson,
    MEETING_ROLES,
    type MergePlan,
    PERSON_RANKS,
    PERSON_SOURCE_KINDS,
} from "@genesiscz/utils/meetings/people-directory";
import { meetingRecordSchema, speakerAssignmentSchema } from "@genesiscz/utils/meetings/record";
import { dictionaryEntrySchema } from "@genesiscz/utils/transcribe/dictionary";
import type { SpeakerHint, SpeakerLeave } from "@genesiscz/utils/transcribe/speakers";
import { z } from "zod";
import { commentListenerSchema, meetingCommentSchema } from "../comment-schema";
import { decisionActionSchema, journalEntrySchema, skipSchema } from "../decision-actions";
import {
    configEditSchema,
    dictionaryShowSchema,
    matchPreviewRowSchema,
    pairedPersonRefSchema,
    phraseTestSchema,
    projectRemovalSchema,
    projectRenameSchema,
    unpairedSchema,
} from "../library-schema";
import { matchDraftSchema } from "../match-preview";
import { MOMENT_ERROR_CODES, MOMENT_STATE_CODES, momentSchema, momentTargetSchema } from "../moment-schema";
import type { MeetingsOverview } from "../overview";
import { reviewRowsSchema } from "../review-row-schema";

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
    /**
     * An `assign`'s other stretches (`AssignReachStretch`, speaker-assign.ts): the same label inside the hint range
     * around it (`hint-range`) or in the sections with the same people present (`present-set`), never "sounds the same".
     */
    stretches: z
        .array(
            z.object({
                label: z.string(),
                fromSec: z.number(),
                toSec: z.number(),
                lines: z.number().int().nonnegative(),
                why: z.enum(["hint-range", "present-set"]),
            })
        )
        .optional(),
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
        /** At most this long from the span's start (the window's "Clip 5s" on a selection: 5); the pad stays. */
        lengthSec: z.number().positive().max(600).optional(),
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
        /** The stretches given to a person (`assign`), each a label's lines; absent when the meeting has none. */
        assignments: z.array(speakerAssignmentSchema).optional(),
    }),
    resultName: "{ meeting, gapSec, timed, speakers: SpeakerStat[], hints: SpeakerHint[], assignments? }",
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

const configEdit = defineMethod({
    name: "config.edit",
    params: z.object({ edits: z.array(configEditSchema).min(1) }).strict(),
    result: z.array(configChangeResult),
    resultName: "{ path: string[], value }[]",
    doc: "Several meetings config changes in one write, all or none, as `config edit --json` does (the settings page saves a project's match rules, its source folders among them, this way). An edit with `expect` is refused with `config-stale` when another editor changed its value.",
    effect: "reversible",
});

const meetingRows = defineMethod({
    name: "meeting.rows",
    params: z
        .object({
            meeting: meetingRef,
            /** `show` keeps the open questions under `playback.listen.minPriority`; `hide` (the default) counts them. */
            lowPriority: z.enum(["hide", "show"]).optional(),
        })
        .strict(),
    result: reviewRowsSchema,
    resultName: "{ meeting, rows: ReviewRow[], hidden }",
    doc: "The review rows (`meetings rows --json`): one per item in the order `listen` asks, each with its question as parts (who, said, when, asks, settles, reason), its typed choices with confidence, its edit kind, what it needs, its sources, its Moment and its last decision. A decided row keeps its place.",
    effect: "read",
});

const commentStage = defineMethod({
    name: "comment.stage",
    params: z
        .object({
            meeting: meetingRef,
            /** What the comment is on: the selected words (`selection`), or any Moment target. */
            target: momentTargetSchema,
            text: z.string().trim().min(1),
            /** The selected words as the window shows them; the listening agent reads them with the comment. */
            quote: z.string().trim().min(1).optional(),
        })
        .strict(),
    result: meetingCommentSchema,
    resultName: "MeetingComment",
    doc: "Stages a comment for the agent that listens to the meeting, kept in the meeting's comments.ndjson until it is sent or unstaged (a closed window loses none). Its id is `c1`, `c2`, … in the order comments were staged.",
    effect: "reversible",
});

const commentList = defineMethod({
    name: "comment.list",
    params: z.object({ meeting: meetingRef }).strict(),
    result: z.object({
        meeting: z.string(),
        comments: z.array(meetingCommentSchema),
        /** The `listen --subscribe-answers --with-comments` processes that run now: who a send reaches (G60). */
        listeners: z.array(commentListenerSchema),
    }),
    resultName: "{ meeting, comments, listeners }",
    doc: "The meeting's staged and sent comments, in the order they were staged, and who listens now.",
    effect: "read",
});

const commentUnstage = defineMethod({
    name: "comment.unstage",
    params: z.object({ meeting: meetingRef, id: z.string().min(1) }).strict(),
    result: meetingCommentSchema,
    resultName: "MeetingComment",
    doc: "Takes a staged comment back and answers it as it was. Refused with `unknown-comment`, or `already-sent` for a sent one (the listening agent has it).",
    effect: "reversible",
});

const commentSend = defineMethod({
    name: "comment.send",
    params: z
        .object({
            meeting: meetingRef,
            /** Only these staged comments; absent: every staged one. */
            ids: z.array(z.string().min(1)).min(1).optional(),
            reason: z.string().optional(),
        })
        .strict(),
    result: z.object({
        sent: z.array(meetingCommentSchema),
        /** Who listened when they were sent; none: they wait in the file for the next listener with --from-start. */
        listeners: z.array(commentListenerSchema),
        /** The journal entry of the send (kind `comment`); absent when nothing was staged. */
        entry: journalEntrySchema.optional(),
    }),
    resultName: "{ sent, listeners, entry? }",
    doc: "Sends the staged comments to the listening agent: each `listen --subscribe-answers --with-comments` prints them, the journal keeps an entry of kind `comment` (it cannot be undone), and the subscribers hear `comment.sent`. Refused with `unknown-comment` or `already-sent` for an id it cannot send.",
    effect: "destructive",
});

/** A person of the people directory (`KnownPerson`, src/utils/meetings/people-directory.ts). */
export const knownPersonSchema = z.object({
    /** `email:<address>` or `name:<name tokens>`: what the other people methods take as a person. */
    id: z.string(),
    name: z.string(),
    email: z.string().optional(),
    self: z.literal(true).optional(),
    aliases: z.array(z.string()),
    sources: z.array(z.enum(PERSON_SOURCE_KINDS)),
    /** Why this place in the list: present at the moment, in the meeting, in other meetings, Contacts, own. */
    rank: z.enum(PERSON_RANKS),
    meetings: z.number().int().nonnegative(),
    lastSeen: z.string().optional(),
    projects: z.array(z.string()),
    organization: z.string().optional(),
    note: z.string().optional(),
    /** The merge it is made of: `people.unmerge` with this token splits it. */
    merge: z.string().optional(),
    hidden: z.literal(true).optional(),
}) satisfies z.ZodType<KnownPerson>;

/** A person as a people method names one: an id (`email:…`, `name:…`), an email, or a name. */
const personRef = z.string().trim().min(1);

const peopleKnown = defineMethod({
    name: "people.known",
    params: z
        .object({
            /** What was typed: case and accents do not matter. Empty lists everyone. */
            query: z.string().default(""),
            /** Rank for this meeting: its people first. */
            meeting: meetingRef.optional(),
            /** And for this moment of it: the people in the call then first of all. */
            atSec: z.number().min(0).optional(),
            limit: z.number().int().min(1).max(500).optional(),
            includeHidden: z.boolean().optional(),
        })
        .strict(),
    result: z.object({
        query: z.string(),
        people: z.array(knownPersonSchema),
        /** How many matched before the limit. */
        total: z.number().int().nonnegative(),
        /** Each source's state: `refused` and `off` carry the reason a picker shows (never an empty list). */
        sources: z.array(
            z.object({
                kind: z.enum(PERSON_SOURCE_KINDS),
                state: z.enum(["ok", "off", "refused", "failed"]),
                reason: z.string().optional(),
            })
        ),
    }) satisfies z.ZodType<KnownPeople>,
    resultName: "{ query, people: KnownPerson[], total, sources }",
    doc: "The people the directory knows from the meetings, the projects, Contacts and the people book, matching the query with case and accents folded, ranked: present at atSec in the meeting, then that meeting's people, then other meetings by count and recency, then Contacts, then own entries. Nothing is preselected. The person picker (R23, R44) and the Contacts view (R24) ask it.",
    effect: "read",
});

const ownEntryResultSchema = z.object({
    name: z.string(),
    email: z.string().optional(),
    note: z.string().optional(),
    addedAt: z.string(),
});

const peopleAdd = defineMethod({
    name: "people.add",
    params: z
        .object({
            name: z.string().trim().min(1),
            email: z.string().trim().min(1).optional(),
            note: z.string().optional(),
        })
        .strict(),
    result: z.object({
        person: knownPersonSchema,
        entry: ownEntryResultSchema,
        /** False when the book had them already: the email and note were added to their entry. */
        added: z.boolean(),
        /** True when they were hidden and adding showed them again. */
        shown: z.boolean(),
    }),
    resultName: "{ person, entry, added, shown }",
    doc: "Adds a person by hand to the people book (the picker's \"Add 'X' as new speaker\", `people add`). A person the book has gains the email and note instead.",
    effect: "reversible",
});

const peopleHide = defineMethod({
    name: "people.hide",
    params: z
        .object({
            person: personRef,
            /** False shows a hidden person again. */
            hidden: z.boolean().optional(),
        })
        .strict(),
    result: z.object({ person: knownPersonSchema, changed: z.boolean() }),
    resultName: "{ person, changed }",
    doc: "Hides a person from every list of the directory, or shows them again. Refused with `unknown-person` or `ambiguous-person`.",
    effect: "reversible",
});

const mergeParams = z
    .object({
        a: personRef,
        b: personRef,
        /** The name the merged person shows; the first person's when absent. */
        name: z.string().trim().min(1).optional(),
    })
    .strict();

const mergePlanSchema = z.object({
    people: z.tuple([knownPersonSchema, knownPersonSchema]),
    name: z.string(),
    /** The meetings that name either person; `people`: which of the two (0, 1) each names. */
    meetings: z.array(
        z.object({
            id: z.string(),
            title: z.string(),
            start: z.string(),
            people: z.array(z.union([z.literal(0), z.literal(1)])),
            as: z.array(z.enum(MEETING_ROLES)),
        })
    ),
    /** The speaker labels renamed to either person: they show as the merged person. */
    labels: z.array(z.object({ meeting: z.string(), label: z.string(), name: z.string() })),
}) satisfies z.ZodType<MergePlan>;

const peoplePlanMerge = defineMethod({
    name: "people.planMerge",
    params: mergeParams,
    result: mergePlanSchema,
    resultName: "{ people, name, meetings, labels }",
    doc: "What merging two people would do, without writing anything: the meetings that name either one and the speaker labels renamed to them (R24: a merge first asks, naming the meetings). No meeting record changes on a merge.",
    effect: "read",
});

const peopleMergeSchema = z.object({
    token: z.string(),
    people: z.tuple([
        z.object({ name: z.string(), email: z.string().optional() }),
        z.object({ name: z.string(), email: z.string().optional() }),
    ]),
    name: z.string(),
    at: z.string(),
});

const peopleMerge = defineMethod({
    name: "people.merge",
    params: mergeParams,
    result: z.object({ merge: peopleMergeSchema, plan: mergePlanSchema }),
    resultName: "{ merge: { token, people, name, at }, plan }",
    doc: "Merges two people into one in the people book: an alias every reader of the directory applies, so no meeting record changes. `people.unmerge` with its token splits them again.",
    effect: "reversible",
});

const peopleUnmerge = defineMethod({
    name: "people.unmerge",
    params: z.object({ token: z.string().trim().min(1) }).strict(),
    result: z.object({ merge: peopleMergeSchema }),
    resultName: "{ merge }",
    doc: "Splits a merge again by its token. Refused with `unknown-merge` for a token the book does not have.",
    effect: "reversible",
});

/**
 * A known project's name as a command takes it: the handler checks its letters with the config's schema, so a refusal
 * reads as the command's did.
 */
const projectName = z.string();

const projectsAdd = defineMethod({
    name: "projects.add",
    params: z.object({ name: projectName }).strict(),
    result: z.object({ name: z.string(), added: z.boolean() }),
    resultName: "{ name, added }",
    doc: "Adds a known project, as `projects add` does; added is false when it was known already.",
    effect: "reversible",
});

const projectsRename = defineMethod({
    name: "projects.rename",
    params: z.object({ from: projectName, to: projectName }).strict(),
    result: projectRenameSchema,
    resultName: "{ from, to, meetings }",
    doc: "Renames a project everywhere it is named (its settings, dictionary, source folder pairings and its meetings), as `projects rename --json` does. Renaming it back undoes it.",
    effect: "reversible",
});

const projectsRemove = defineMethod({
    name: "projects.remove",
    params: z
        .object({
            name: projectName,
            /** Leave the meetings that have it without a project; without it, such a project is refused. */
            unassign: z.boolean().optional(),
        })
        .strict(),
    result: projectRemovalSchema,
    resultName: "{ name, unassigned, backup }",
    doc: "Removes a project, kept in a backup file first, as `projects remove --json` does. Refused while meetings have it, unless unassign; a waiting folder question that names it is withdrawn from the decision inbox.",
    effect: "destructive",
    reaches: ["user"],
});

const projectsLabels = defineMethod({
    name: "projects.labels",
    params: z
        .object({
            project: projectName,
            add: z.array(z.string()).optional(),
            remove: z.array(z.string()).optional(),
        })
        .strict(),
    result: z.object({ project: z.string(), labels: z.array(z.string()) }),
    resultName: "{ project, labels }",
    doc: "A project's known labels; add and remove change them, as `projects labels` does. A project nobody knows is refused, unless add makes it.",
    effect: "reversible",
});

const projectsUnpair = defineMethod({
    name: "projects.unpair",
    params: z
        .object({
            /** A calendar entry id: the pairings it made, in every project (another source's pairing stays). */
            entry: z.string().min(1).optional(),
            /** With person: this person leaves this project, whatever paired them. */
            project: projectName.optional(),
            person: pairedPersonRefSchema.optional(),
        })
        .strict(),
    result: z.object({ removed: z.array(unpairedSchema) }),
    resultName: "{ removed: { project, name, email?, left }[] }",
    doc: "Removes project pairings, as `projects unpair` does: the ones a calendar entry made (entry), or one person from one project (project and person). Refused without either.",
    effect: "destructive",
});

const projectsPreview = defineMethod({
    name: "projects.preview",
    params: z
        .object({
            /** Match rules a person is editing, in place of the saved ones of the projects it names. */
            draft: matchDraftSchema.optional(),
            /** The newest meetings to check (20 when absent). */
            limit: z.number().int().min(1).optional(),
        })
        .strict(),
    result: z.array(matchPreviewRowSchema),
    resultName: "MatchPreviewRow[]",
    doc: "Which project each recent meeting matches by the saved rules and by a draft of them, as `projects preview --json` prints it. Reads only.",
    effect: "read",
});

/** A dictionary level: a project's, or the global one when absent. */
const dictionaryProject = projectName.optional();

const dictionaryShow = defineMethod({
    name: "dictionary.show",
    params: z.object({ project: dictionaryProject }).strict(),
    result: dictionaryShowSchema,
    resultName: "{ project, abbrExpansion, entries }",
    doc: "The merged dictionary (the global one, then the project's), each entry with its level, as `dictionary show --json` prints it. An unknown project is refused.",
    effect: "read",
});

const dictionaryAdd = defineMethod({
    name: "dictionary.add",
    params: z
        .object({
            entry: dictionaryEntrySchema,
            /** The project's dictionary instead of the global one; a new name joins the known projects. */
            project: dictionaryProject,
            /** A rename: the entry with this value is replaced in one write, in its place. */
            replace: z.string().optional(),
            /** Only add it: an entry with that value in the level is refused with `dictionary-exists` (an Undo's add). */
            ifAbsent: z.boolean().optional(),
        })
        .strict(),
    result: z.object({
        entry: dictionaryEntrySchema,
        /** `global` or `project <name>`. */
        level: z.string(),
        /** The project joined the known projects with this entry. */
        projectAdded: z.boolean(),
        /** The value of the entry it replaced (a rename). */
        replaced: z.string().optional(),
    }),
    resultName: "{ entry, level, projectAdded, replaced? }",
    doc: "Adds or replaces a dictionary entry, as `dictionary add` does. A refused entry changes nothing.",
    effect: "reversible",
});

const dictionaryRemove = defineMethod({
    name: "dictionary.remove",
    params: z.object({ value: z.string(), project: dictionaryProject }).strict(),
    result: z.object({ value: z.string(), level: z.string(), removed: z.boolean() }),
    resultName: "{ value, level, removed }",
    doc: "Removes a dictionary entry by its value, as `dictionary remove` does; removed is false when the level did not have it.",
    effect: "reversible",
});

const dictionaryTest = defineMethod({
    name: "dictionary.test",
    params: z.object({ phrase: z.string(), project: dictionaryProject }).strict(),
    result: phraseTestSchema,
    resultName: "{ phrase, text, fired, suggestions, counts }",
    doc: "What the scope's dictionary does to one phrase, with each entry that fired, as `dictionary test --json` prints it. Reads only.",
    effect: "read",
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
        configEdit,
        meetingRows,
        commentStage,
        commentList,
        commentUnstage,
        commentSend,
        peopleKnown,
        peopleAdd,
        peopleHide,
        peoplePlanMerge,
        peopleMerge,
        peopleUnmerge,
        projectsAdd,
        projectsRename,
        projectsRemove,
        projectsLabels,
        projectsUnpair,
        projectsPreview,
        dictionaryShow,
        dictionaryAdd,
        dictionaryRemove,
        dictionaryTest,
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
export const MEETINGS_EVENTS = ["meeting.changed", "decision.applied", "decision.reverted", "comment.sent"] as const;
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
    /** Comments went to the listening agent: the journal entry's token, the comments, and who listened (G61). */
    "comment.sent": z.object({
        meeting: z.string(),
        token: z.string(),
        comments: z.array(meetingCommentSchema),
        listeners: z.array(commentListenerSchema),
    }),
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
    /** No staged comment has that id. */
    "unknown-comment",
    /** The comment was sent: it cannot be unstaged or sent again. */
    "already-sent",
    /** A people method's person names nobody the directory knows. */
    "unknown-person",
    /** A people method's person names several people: data `{ code, candidates }`, each a KnownPerson. */
    "ambiguous-person",
    /** `people.unmerge` named a token the people book does not have. */
    "unknown-merge",
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
