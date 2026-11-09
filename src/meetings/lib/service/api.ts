import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { defineApi, defineMethod } from "@genesiscz/utils/api-descriptor";
import { MEETINGS_CONFLICT_CODES, MEETINGS_STATE_CODES } from "@genesiscz/utils/meetings/conflict";
import { meetingRecordSchema } from "@genesiscz/utils/meetings/record";
import { z } from "zod";
import { decisionActionSchema, journalEntrySchema, skipSchema } from "../decision-actions";

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

/** One corrected transcript line, as `transcript --format json` prints it. */
export const transcriptLineSchema = z.object({
    id: z.string().optional(),
    startSec: z.number().optional(),
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

export const meetingsApi = defineApi({
    id: "meetings-service",
    global: "meetings",
    title: "Meetings service",
    summary:
        "The one owner of the meetings store while it runs: typed reads for the Meetings window, the CLI and agents, and events for the open meeting.",
    methods: [hello, list, show, transcript, revisions, decisionPlan, decisionApply, decisionRevert, journalRead],
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
