import { logger } from "@genesiscz/utils/logger";
import { MeetingsConfigStore } from "@genesiscz/utils/meetings/config";
import { readCorrections, teachesDictionary } from "@genesiscz/utils/meetings/corrections";
import type { DecisionActor, MeetingRecord, MeetingStore } from "@genesiscz/utils/meetings/record";
import { DEFAULT_SPAN_GAP_SEC, speakerStats } from "@genesiscz/utils/transcribe/speakers";
import type { Decided, DecisionAction, JournalEntry } from "../decision-actions";
import {
    actorText,
    callerActor,
    DecisionJournal,
    type DecisionReach,
    decisionReach,
    itemIdOf,
    type SplitInputs,
} from "../decision-journal";
import { CORRECTION_REPEATS } from "../dictionary-suggest";
import { setMeetingFields } from "../meeting-fields";
import { reviewRow, reviewRowsPatch } from "../review-rows";
import { type AssignReachStretch, assignmentReach } from "../speaker-assign";
import type { MeetingsParsedParams, MeetingsResult } from "./api";
import { type MeetingsCallContext, type MeetingsHandlerDeps, recordOf, refusal } from "./handlers";

/**
 * The Meetings service's decision methods (`decision.plan`, `decision.apply`, `decision.revert`, `journal.read`): the
 * decision journal behind the service, its actor taken from the connection's hello. Loaded by handlers.ts only when a
 * call decides, so a read pays nothing for the journal's rules.
 */

const { log } = logger.scoped("meetings-service");

export async function planDecision(
    params: MeetingsParsedParams<"decision.plan">,
    context: MeetingsCallContext,
    store: MeetingStore,
    deps: MeetingsHandlerDeps
): Promise<MeetingsResult<"decision.plan">> {
    const record = recordOf(store, params.meeting);
    const journal = await journalOf(store, deps);
    const planned = await journal.plan({
        meeting: record.id,
        action: params.action,
        actor: actorOfCall(context),
        ...(params.reason ? { reason: params.reason } : {}),
    });
    return { ...planned, reach: await reachOf(store, record, planned, params.action, deps) };
}

export async function applyDecision(
    params: MeetingsParsedParams<"decision.apply">,
    context: MeetingsCallContext,
    store: MeetingStore,
    deps: MeetingsHandlerDeps
): Promise<MeetingsResult<"decision.apply">> {
    const record = recordOf(store, params.meeting);

    if (params.onDecided === "refuse") {
        refuseDecided(store, record, params.action);
    }

    const captured: { value?: { before: MeetingRecord; after: MeetingRecord } } = {};
    const onApplied = (snapshot: { before: MeetingRecord; after: MeetingRecord }): void => {
        captured.value = snapshot;
    };
    const { OpenedMeeting } = await import("../opened-meeting");
    const opened = OpenedMeeting.of(store, record, deps.linkedSource?.(record));
    const config = await (deps.config ? deps.config() : opened.config()).catch((error: unknown) => {
        log.warn({ error, meeting: record.id }, "decision rows unavailable because the meetings config does not read");
        return undefined;
    });
    const transcript = await opened
        .meeting()
        .then((meeting) => meeting.transcript)
        .catch((error: unknown) => {
            log.debug({ error, meeting: record.id }, "decision rows without transcript words");
            return undefined;
        });
    const actor = actorOfCall(context);
    const reason = params.reason ? { reason: params.reason } : {};
    const { action } = params;
    // A `set` also teaches the project its new labels, as `tools meetings set` does.
    const decided =
        action.kind === "set"
            ? (
                  await setMeetingFields({
                      store,
                      config: new MeetingsConfigStore(),
                      record,
                      change: {
                          ...(action.project ? { project: action.project } : {}),
                          ...(action.title ? { title: action.title } : {}),
                          ...(action.labels ? { labels: action.labels } : {}),
                          ...(action.unlabel ? { unlabel: action.unlabel } : {}),
                      },
                      quiet: true,
                      onApplied,
                      actor,
                      ...reason,
                  })
              ).decided
            : await (await journalOf(store, deps, onApplied)).apply({ meeting: record.id, action, actor, ...reason });

    if (decided.entry) {
        context.emit?.("decision.applied", { meeting: record.id, entry: decided.entry });
    }

    return {
        ...decided,
        ...(captured.value && config
            ? {
                  rows: reviewRowsPatch({
                      ...captured.value,
                      ...(transcript ? { transcript } : {}),
                      minPriority: config.global.playback.listen.minPriority,
                      ...(params.lowPriority ? { lowPriority: params.lowPriority } : {}),
                  }),
              }
            : {}),
    };
}

export async function revertDecision(
    params: MeetingsParsedParams<"decision.revert">,
    context: MeetingsCallContext,
    store: MeetingStore,
    deps: MeetingsHandlerDeps
): Promise<Decided> {
    const record = recordOf(store, params.meeting);
    const journal = await journalOf(store, deps);
    const decided = await journal.revert({
        meeting: record.id,
        token: params.token,
        ...(params.items ? { items: params.items } : {}),
        actor: actorOfCall(context),
        ...(params.reason ? { reason: params.reason } : {}),
    });

    if (decided.entry) {
        context.emit?.("decision.reverted", { meeting: record.id, token: params.token, entry: decided.entry });
    }

    return decided;
}

export function readJournal(
    params: MeetingsParsedParams<"journal.read">,
    store: MeetingStore
): MeetingsResult<"journal.read"> {
    const record = recordOf(store, params.meeting);
    const item = params.item ? itemIdOf(record, params.item) : undefined;
    const entries = new DecisionJournal({ store }).read(record.id, {
        ...(item ? { item } : {}),
        ...(params.limit ? { limit: params.limit } : {}),
    });
    return { meeting: record.id, entries };
}

/**
 * Who decides on this call: the window or a listen round as their role says; a caller in an agent session (its hello
 * names the harness) as that agent; a command without a harness in its hello as this process when it runs here (it
 * reads its own agent identity, as the CLI did before the service), else as a person at the command line.
 */
export function actorOfCall(context: Pick<MeetingsCallContext, "caller" | "local">): DecisionActor {
    const hello = context.caller;

    if (hello?.harness) {
        return { kind: "agent", harness: hello.harness, session: hello.session ?? null };
    }

    if (hello?.role === "window" || hello?.role === "listen") {
        return { kind: hello.role };
    }

    if (context.local || !hello) {
        return callerActor();
    }

    return hello.role === "agent"
        ? { kind: "agent", harness: "unknown", session: hello.session ?? null }
        : { kind: "cli" };
}

/** The journal a call decides through: the store's, with the config's look-alike bar and the inputs a split needs. */
async function journalOf(
    store: MeetingStore,
    deps: MeetingsHandlerDeps,
    onApplied?: (snapshot: { before: MeetingRecord; after: MeetingRecord }) => void
): Promise<DecisionJournal> {
    // A config that does not read keeps the default bar: a confirm worked without the config before the service.
    const config = await (deps.config ?? (() => new MeetingsConfigStore().read()))().catch((error: unknown) => {
        log.warn({ error }, "the meetings config does not read; decisions use the default look-alike bar");
        return undefined;
    });
    return new DecisionJournal({
        store,
        ...(config ? { listenBelow: config.global.suggest.listenBelow } : {}),
        ...(deps.ledger ? { ledger: deps.ledger } : {}),
        ...(deps.now ? { now: deps.now } : {}),
        split: splitInputsOf(store, deps),
        ownRound: true,
        ...(onApplied ? { onApplied } : {}),
    });
}

/** The transcript and microphone share of a record, read only when a split or an add asks for them. */
function splitInputsOf(store: MeetingStore, deps: MeetingsHandlerDeps): SplitInputs {
    const opened = async (record: MeetingRecord) => {
        const { OpenedMeeting } = await import("../opened-meeting");
        return OpenedMeeting.of(store, record, deps.linkedSource?.(record));
    };
    return {
        transcript: async (record) => (await (await opened(record)).meeting()).transcript,
        micShare: async (record) => (await (await opened(record)).energy()).share,
    };
}

/** The reach of a plan: its other items, and for a spelling fixed everywhere its lines and the dictionary it teaches. */
async function reachOf(
    store: MeetingStore,
    record: MeetingRecord,
    planned: Decided,
    action: DecisionAction,
    deps: MeetingsHandlerDeps
): Promise<DecisionReach> {
    const empty: DecisionReach = { items: [], dictionary: [] };

    if (!planned.entry) {
        return empty;
    }

    if (action.kind === "assign") {
        return { ...empty, stretches: await assignReachOf(store, record, planned.entry, deps) };
    }

    const { entry } = planned;
    const teaches = entry.corrections.some(teachesDictionary);
    const spelling =
        (action.kind === "confirm" || action.kind === "respell") &&
        entry.changes.some((change) => change.after?.kind === "term");
    const named = namedItems(record, action);
    // Each reached item shows its own quote and time, so the transcript is read whenever there is one to show.
    const reaches = [...entry.settled, ...entry.decided].some((id) => !named.includes(id) && id !== entry.question);
    const transcript =
        teaches || reaches || spelling
            ? await splitInputsOf(store, deps)
                  .transcript(record)
                  .catch((error: unknown) => {
                      log.debug({ error, meeting: record.id }, "a plan's reach reads no transcript lines");
                      return undefined;
                  })
            : undefined;
    const replaced =
        action.kind === "answer" && action.replaces
            ? new DecisionJournal({ store }).read(record.id).find((one) => one.token === action.replaces)
            : undefined;
    const struck = replaced?.action.kind === "answer" ? (replaced.action.except ?? []) : [];
    return decisionReach({
        entry,
        named,
        record,
        rowOf: (item) => reviewRow(record, item, transcript),
        ...(struck.length > 0 ? { struck: struck.map((ref) => itemIdOf(record, ref)) } : {}),
        ...(transcript && (teaches || spelling) ? { transcript } : {}),
        ledger: teaches ? (deps.readLedger ?? readCorrections)() : [],
        repeats: CORRECTION_REPEATS,
    });
}

/**
 * The other stretches an assignment may reach (G-SPK-5): the same label in the hint range around it or in the sections
 * with the same people present. A meeting whose transcript or attendance does not read offers none.
 */
async function assignReachOf(
    store: MeetingStore,
    record: MeetingRecord,
    entry: JournalEntry,
    deps: MeetingsHandlerDeps
): Promise<AssignReachStretch[]> {
    const assigned = (entry.assignments ?? []).flatMap((change) => (change.after ? [change.after] : []));

    if (assigned.length === 0) {
        return [];
    }

    try {
        const { OpenedMeeting } = await import("../opened-meeting");
        const opened = OpenedMeeting.of(store, record, deps.linkedSource?.(record));
        const meeting = await opened.meeting();
        const { hints } = speakerStats(meeting.transcript, {
            gapSec: DEFAULT_SPAN_GAP_SEC,
            participants: meeting.speakers,
            presence: await opened.presence(),
        });
        return assignmentReach({ record, transcript: meeting.transcript, hints, assigned });
    } catch (error) {
        log.debug({ error, meeting: record.id }, "an assignment's reach reads no transcript or attendance");
        return [];
    }
}

/** The item ids an action names itself (a question by `Q12` too). */
function namedItems(record: MeetingRecord, action: DecisionAction): string[] {
    switch (action.kind) {
        case "confirm":
        case "reject":
        case "reopen":
            return action.items.map((ref) => itemIdOf(record, ref));
        case "respell":
            return [itemIdOf(record, action.item)];
        case "answer":
        case "rephrase":
        case "skip":
        case "split":
            return [itemIdOf(record, action.question)];
        case "rename":
        case "assign":
        case "add":
        case "set":
            return [];
    }
}

/**
 * `onDecided: "refuse"`: a decision on an item someone else decided since the caller saw it is refused with
 * `already-decided`, its data naming the items and the entry that decided the first of them (G47), instead of the
 * quiet skip a command gets. Only actions on items that can be decided once (confirm, reject, respell, an answer, a
 * skip, a split) are checked.
 */
function refuseDecided(store: MeetingStore, record: MeetingRecord, action: DecisionAction): void {
    if (action.kind === "confirm" || action.kind === "reject") {
        if (action.minConfidence !== undefined) {
            return;
        }
    } else if (action.kind === "answer" && action.replaces) {
        // A changed answer names the decision it replaces; the journal refuses it when that is no longer the one.
        return;
    } else if (!["respell", "answer", "skip", "split"].includes(action.kind)) {
        return;
    }

    const ids = namedItems(record, action);
    const decided = record.items.filter((item) => ids.includes(item.id) && item.status !== "suggested");

    if (decided.length === 0) {
        return;
    }

    const token = decided[0]?.decision?.token;
    const entry = token
        ? new DecisionJournal({ store }).read(record.id, { item: decided[0]?.id }).find((one) => one.token === token)
        : undefined;
    const by = entry ? ` by ${actorText(entry.actor)}` : "";
    throw refusal(
        "already-decided",
        `${decided.map((item) => `${item.id} is ${item.status}`).join(", ")} already${by}; nothing was decided`,
        { items: decided.map((item) => item.id), ...(entry ? { entry } : {}) }
    );
}
