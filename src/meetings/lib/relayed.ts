import { callerRecordLine } from "@genesiscz/utils/agent/identity/caller-record";
import type { AgentInstructionSeverity, AgentInstructions } from "@genesiscz/utils/ai/agent-instructions";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { env } from "@genesiscz/utils/env";
import type { AreaClients } from "@genesiscz/utils/genesis-tools";
import type { RequestJournal, RequestView } from "@genesiscz/utils/genesis-tools/areas/person/journal";
import type { NoticeInput, RequestOutcome, RequestRow } from "@genesiscz/utils/genesis-tools/areas/person/request";
import { sha256Json } from "@genesiscz/utils/hash";
import { logger } from "@genesiscz/utils/logger";
import type { AgentActor, DecisionActor, MeetingRecord, MeetingStore } from "@genesiscz/utils/meetings/record";
import { sandboxInstalled } from "@genesiscz/utils/storage/real-home-guard";
import { formatClock } from "@genesiscz/utils/transcribe/render";
import type { DecisionAction, JournalReadEntry } from "./decision-actions";
import { itemIdOf, shownValue, spanOf } from "./decision-journal";
import { questionLabel } from "./questions";
import type { MeetingsClient } from "./service/client";
import { errorText } from "./shared";

/**
 * An answer an agent relayed from the user (D443, 2026-11-24): the agent wrote what the user said in chat, so the
 * journal names the agent, and voice learning and backfill use only a person's decisions. One confirmation request
 * asks the user whether those answers are theirs: each row an answer with the user's quoted words and a Play button,
 * ticked on its own. Each ticked row is decided again as the user's (`request` actor, `relayedBy` the agent), in one
 * journal entry that replaces the agent's, so its Undo brings the agent's answer back. Anything else leaves the
 * agent's answers as they are.
 */

/** The decisions a confirmation can adopt: what carries an answer a person gave. */
export const RELAYED_ACTIONS: ReadonlySet<string> = new Set<DecisionAction["kind"]>(["answer", "confirm", "reject"]);

const CONFIRM_AS_MINE = "Confirm as mine";
const NOT_NOW = "Not now";

/** The part of the person area a relayed confirmation calls. */
export type RelayedConfirmDoor = { person: Pick<AreaClients["person"], "confirm"> };

/** The person area's request journal as a confirmation reads it: the newest attempt's state, and its withdrawal. */
export type RelayedRequests = Pick<RequestJournal, "get" | "withdraw" | "claim">;

/**
 * How long a request may wait after its post for the worker that shows its window: a rerun inside it treats the
 * window as on screen, so a quick rerun does not withdraw a window that is about to open.
 */
export const RELAYED_WINDOW_START_MS = 30_000;

/** One meeting's items to confirm; an item is an id (`i42`) or a question label (`Q12`). */
export interface RelayedGroup {
    meeting: string;
    items: string[];
}

/** One agent decision the user may adopt: the item, the entry that decided it, and what the row shows. */
export interface RelayedRow {
    meeting: Pick<MeetingRecord, "id" | "title">;
    /** The item the journal decides again: an answer's own question, else the named item. */
    item: string;
    label: string;
    entry: JournalReadEntry;
    relayer: AgentActor;
}

/** An item that is not an agent's standing decision, and why. */
export interface RelayedSkip {
    meeting: string;
    item: string;
    reason: string;
}

export interface RelayedResult {
    request?: string;
    /** The journal entries that made the user's decisions, one per adopted agent entry. */
    adopted: { meeting: string; items: string[]; token: string }[];
    /** Rows the user unticked: they stay the agent's. */
    left: { meeting: string; item: string }[];
    skipped: RelayedSkip[];
    /** For an agent: what to tell the user and what to run next. Absent when every ticked row was adopted. */
    instructions?: AgentInstructions;
}

/** The row of an agent's entry for one item: the request's rows and the service's check share it. */
export function relayedRowId(meeting: string, item: string, token: string): string {
    return `${meeting}/${item}/${token}`;
}

/**
 * One request family per set of rows: the same items again read the answer to the newest attempt at asking about them
 * ({@link relayedAttemptId}).
 */
export function relayedRequestId(rows: readonly Pick<RelayedRow, "meeting" | "item" | "entry">[]): string {
    const ids = rows.map((row) => relayedRowId(row.meeting.id, row.item, row.entry.token)).sort();
    return `relayed:${sha256Json(ids)}`;
}

/**
 * The id of the `attempt`th request about one set of rows: the first keeps the family id, each later one adds its
 * number, so the request journal keeps every attempt and a rerun finds the newest.
 */
export function relayedAttemptId(family: string, attempt: number): string {
    return attempt <= 1 ? family : `${family}:${attempt}`;
}

/** The items of `--confirm-relayed`: `i42` in the named meeting, `<meeting>:Q2` in another one. */
export function relayedGroups(meeting: string, refs: readonly string[]): RelayedGroup[] {
    const groups = new Map<string, string[]>([[meeting, []]]);

    for (const ref of refs) {
        const cut = ref.lastIndexOf(":");
        const [where, item] = cut > 0 ? [ref.slice(0, cut), ref.slice(cut + 1)] : [meeting, ref];
        groups.set(where, [...(groups.get(where) ?? []), item]);
    }

    return [...groups].filter(([, items]) => items.length > 0).map(([where, items]) => ({ meeting: where, items }));
}

/**
 * The quoted words as the user wrote them: an agent that passed the reason through a shell left a backslash before
 * each quote mark or backslash in them, once or several times over (`\\\"Word\\\"`), and a run of backslashes at the
 * end escaped the closing quote mark.
 */
function unescapedWords(words: string): string {
    let text = words.replace(/\\+$/u, "");

    for (;;) {
        const next = text.replace(/\\(["\\\u201C\u201D])/gu, "$1");

        if (next === text) {
            return text;
        }

        text = next;
    }
}

/** The words the user said, as the agent quoted them in the decision's reason; the whole reason when it quotes none. */
export function relayedQuote(entry: Pick<JournalReadEntry, "reason" | "action">): string | undefined {
    const reason = entry.reason?.trim();
    const comment = entry.action.kind === "answer" ? entry.action.comment?.trim() : undefined;
    const text = reason || comment;

    if (!text) {
        return undefined;
    }

    const first = text.search(/["\u201C]/u);
    const last = Math.max(text.lastIndexOf('"'), text.lastIndexOf("\u201D"));
    return first >= 0 && last > first ? unescapedWords(text.slice(first + 1, last)).trim() || text : text;
}

/** Who relayed it, in the words a row has room for: "Claude Code, session f94af8c6 · opus · GenesisTools on feat/x". */
function relayerText(actor: AgentActor): string {
    return actor.caller
        ? callerRecordLine(actor.caller)
        : `${actor.harness}${actor.session ? `, session ${actor.session.slice(0, 8)}` : ""}`;
}

/**
 * The standing decision of one item, when it is an agent's answer, confirm or reject: the entry its `decision.token`
 * names. An open item, a person's decision, a rule's and an undone one are skipped with the reason.
 */
export function relayedOf(options: {
    record: MeetingRecord;
    ref: string;
    entries: readonly JournalReadEntry[];
}): { row: RelayedRow } | { skip: string } {
    const { record, ref, entries } = options;
    let id: string;

    try {
        id = itemIdOf(record, ref);
    } catch (error) {
        return { skip: errorText(error) };
    }

    const item = record.items.find((each) => each.id === id);

    if (!item) {
        return { skip: `there is no item ${ref}` };
    }

    const token = item.decision?.token;

    if (item.status === "suggested" || !token) {
        return { skip: "it is not decided" };
    }

    const entry = entries.find((each) => each.token === token);

    if (!entry || entry.revertedBy) {
        return { skip: "the decision that set it is not in the journal" };
    }

    if (!RELAYED_ACTIONS.has(entry.action.kind)) {
        return { skip: `it was decided by a ${entry.action.kind}, which carries no answer of the user` };
    }

    if (entry.actor.kind !== "agent") {
        return {
            skip:
                entry.actor.kind === "rule"
                    ? "a rule decided it, not an agent"
                    : "it is a person's decision already, so nothing is relayed",
        };
    }

    const decided = entry.action.kind === "answer" ? (entry.question ?? id) : id;
    const label = item.kind === "question" ? questionLabel(record, decided) : decided;
    return {
        row: { meeting: { id: record.id, title: record.title }, item: decided, label, entry, relayer: entry.actor },
    };
}

/** A stretch of the meeting a row's Play button plays, in transcript seconds. */
export interface RelayedPlay {
    fromSec: number;
    toSec: number;
}

/**
 * What one row shows: the item and its decision, the user's words, where it is, and Play for exactly its range: the
 * item's own range, or for an item at one instant the stretch its Moment plans (`play`).
 */
function requestRow(row: RelayedRow, record: MeetingRecord, play?: RelayedPlay): RequestRow {
    const item = record.items.find((each) => each.id === row.item);
    const action = row.entry.action;
    const decision =
        action.kind === "answer"
            ? action.answer
            : action.kind === "reject"
              ? `rejected: ${shownValue(item) ?? row.item}`
              : (shownValue(item) ?? "confirmed");
    const span = item ? spanOf(item) : undefined;
    const heard = span && span.toSec > span.fromSec ? span : play;
    const quote = relayedQuote(row.entry);
    const where = [
        record.title || record.id,
        span ? formatClock(span.fromSec) : undefined,
        `relayed by ${relayerText(row.relayer)}`,
    ];
    return {
        id: relayedRowId(row.meeting.id, row.item, row.entry.token),
        title: `${row.label} · ${decision}`.slice(0, 200),
        ...(quote ? { quote: quote.slice(0, 2000) } : {}),
        detail: where.filter(Boolean).join(" · ").slice(0, 500),
        ...(heard && heard.toSec > heard.fromSec
            ? {
                  action: {
                      kind: "play-meeting" as const,
                      label: "Play clip",
                      meeting: row.meeting.id,
                      fromSec: Math.max(0, heard.fromSec),
                      toSec: heard.toSec,
                  },
              }
            : {}),
    };
}

/**
 * The stretch to play for each row whose item sits at one instant (a speaker range of one line, a question asked at one
 * second): the span of the item's Moment, which hears the line or the lines the decision names. Keyed by
 * `relayedRowId`; a row whose Moment cannot be planned keeps its own span.
 */
export async function relayedPlays(
    rows: readonly RelayedRow[],
    records: ReadonlyMap<string, MeetingRecord>,
    client: Pick<MeetingsClient, "call">
): Promise<Map<string, RelayedPlay>> {
    const plays = new Map<string, RelayedPlay>();

    await Promise.all(
        rows.map(async (row) => {
            const item = records.get(row.meeting.id)?.items.find((each) => each.id === row.item);
            const span = item ? spanOf(item) : undefined;

            if (!item || (span && span.toSec > span.fromSec)) {
                return;
            }

            try {
                const { moment, cannot } = await client.call("moment.plan", {
                    meeting: row.meeting.id,
                    target: { kind: "item", id: row.item },
                    tone: false,
                    screen: false,
                });

                if (moment) {
                    plays.set(relayedRowId(row.meeting.id, row.item, row.entry.token), {
                        fromSec: moment.fromSec,
                        toSec: moment.toSec,
                    });
                } else {
                    logger.debug({ meeting: row.meeting.id, item: row.item, cannot }, "relayed row: no Moment to play");
                }
            } catch (error) {
                logger.debug(
                    { error, meeting: row.meeting.id, item: row.item },
                    "relayed row: its Moment did not plan"
                );
            }
        })
    );

    return plays;
}

/** The window (D443): who asks, what a confirmation changes, one row per answer, and Confirm as mine / Not now. */
export function relayedRequest(
    rows: readonly RelayedRow[],
    records: ReadonlyMap<string, MeetingRecord>,
    plays: ReadonlyMap<string, RelayedPlay> = new Map()
): NoticeInput {
    const first = rows[0]!;
    const meetings = [...new Map(rows.map((row) => [row.meeting.id, row.meeting])).values()];
    const title =
        rows.length === 1
            ? `Confirm the answer you gave: ${first.label}`
            : `Confirm ${rows.length} answers you gave in chat`;
    return {
        kind: "notice",
        id: relayedRequestId(rows),
        title: title.slice(0, 200),
        reason: `An agent (${relayerText(first.relayer)}) recorded ${rows.length === 1 ? "this answer" : "these answers"} from what you said in chat, so the meeting counts ${rows.length === 1 ? "it" : "them"} as the agent's. ${CONFIRM_AS_MINE} makes each ticked one your own decision: voice samples and the meeting's learning then use it. ${NOT_NOW} leaves them as the agent's answers.`,
        fields: meetings.slice(0, 12).map((meeting) => ({
            label: "Meeting",
            value: (meeting.title || meeting.id).slice(0, 500),
            help: meeting.id,
        })),
        rows: rows
            .slice(0, 40)
            .map((row) =>
                requestRow(
                    row,
                    records.get(row.meeting.id)!,
                    plays.get(relayedRowId(row.meeting.id, row.item, row.entry.token))
                )
            ),
        buttons: { confirm: CONFIRM_AS_MINE, decline: NOT_NOW },
    };
}

/**
 * The action that decides an agent's entry again for `items`, unchanged, as its replacement: the user confirms the
 * answer the window showed, never a new one.
 */
export function adoptionAction(entry: JournalReadEntry, items: string[]): DecisionAction {
    const action = entry.action;

    if (action.kind === "answer") {
        const { knownAnswer: _replayed, replaces: _earlier, ...answer } = action;
        return { ...answer, replaces: entry.token };
    }

    if (action.kind === "confirm") {
        return {
            kind: "confirm",
            items,
            ...(action.speaker === undefined ? {} : { speaker: action.speaker }),
            ...(action.proposed === undefined ? {} : { proposed: action.proposed }),
            ...(action.reach === undefined ? {} : { reach: action.reach }),
            replaces: entry.token,
        };
    }

    if (action.kind === "reject") {
        return { kind: "reject", items, replaces: entry.token };
    }

    throw new Error(`A ${action.kind} carries no answer of the user, so a confirmation cannot adopt it.`);
}

function stopped(severity: AgentInstructionSeverity, lines: string[]): AgentInstructions {
    return { text: lines.join("\n"), severity, stop: true };
}

/** What the newest attempt at asking about these rows means for this run. */
type PriorAttempt =
    | { kind: "answered"; view: RequestView }
    | { kind: "declined"; view: RequestView }
    | { kind: "waiting"; view: RequestView }
    | { kind: "post"; attempt: number; why: string[] };

/** The newest attempt in the journal at asking about one set of rows, or null when none was posted. */
function newestAttempt(requests: RelayedRequests, family: string): { attempt: number; view: RequestView } | null {
    let newest: { attempt: number; view: RequestView } | null = null;

    for (let attempt = 1; ; attempt++) {
        const view = requests.get(relayedAttemptId(family, attempt));

        if (!view) {
            return newest;
        }

        newest = { attempt, view };
    }
}

/** Why a request that ended without the user's answer does not stop the next one. */
function endedWithoutAnswer(view: RequestView): string {
    const reason = view.outcome.reason ? ` (${view.outcome.reason})` : "";

    if (view.state === "withdrawn") {
        return `Request ${view.id} was withdrawn before the user answered it${reason}.`;
    }

    if (view.state === "obsolete") {
        return `Request ${view.id} ended obsolete before the user answered it${reason}.`;
    }

    return `Request ${view.id} ended without the user's answer, because no window reached the user${reason}.`;
}

/** A settled attempt: the user's answer, the user's Not now, or an end without an answer that a new attempt follows. */
function settledAttempt(view: RequestView, next: number, askAgain: boolean): PriorAttempt {
    if (view.outcome.status === "done") {
        return { kind: "answered", view };
    }

    if (view.outcome.status === "declined") {
        return askAgain
            ? {
                  kind: "post",
                  attempt: next,
                  why: [`The user answered ${NOT_NOW} to request ${view.id} and then asked for the window again.`],
              }
            : { kind: "declined", view };
    }

    return { kind: "post", attempt: next, why: [endedWithoutAnswer(view)] };
}

/**
 * Reads the newest attempt at asking about these rows. A done or declined one is the user's answer. One that ended
 * without an answer (withdrawn, obsolete, failed) gets a new attempt. A waiting one is never posted twice while its
 * window is on screen or about to open; it is withdrawn and asked again when it shows an older rendering of the rows
 * (`renders` false) or when no worker shows it any more (its window timed out, or none opened).
 */
async function priorAttempt(options: {
    requests: RelayedRequests;
    family: string;
    renders: (posted: NoticeInput) => boolean;
    askAgain: boolean;
}): Promise<PriorAttempt> {
    const { requests, family, askAgain } = options;
    const newest = newestAttempt(requests, family);

    if (!newest) {
        return { kind: "post", attempt: 1, why: [] };
    }

    const { view } = newest;
    const next = newest.attempt + 1;

    if (view.outcome.status !== "pending") {
        return settledAttempt(view, next, askAgain);
    }

    const withdrawn = (why: string): PriorAttempt => {
        const after = requests.get(view.id) ?? view;
        // The user can have answered between the read and the withdrawal: that answer stands.
        return after.state === "withdrawn"
            ? { kind: "post", attempt: next, why: [why] }
            : settledAttempt(after, next, askAgain);
    };
    const older = async (): Promise<PriorAttempt> => {
        await requests.withdraw(view.id);
        return withdrawn(
            `Request ${view.id} showed these answers as an older version of this command rendered them, so it was withdrawn. Its window can stay on screen until its deadline; an answer there no longer counts.`
        );
    };
    const changed = !options.renders(view.request);

    // Its worker may not show the window yet: a probe of the claim now could make that worker give up.
    if (Date.now() - Date.parse(view.request.createdAt) < RELAYED_WINDOW_START_MS) {
        return changed ? older() : { kind: "waiting", view };
    }

    // The worker that shows a window holds the request's claim while the window is on screen: a claim taken here
    // means no window shows the request any more, and the withdrawal under it keeps a late worker from showing it.
    const probe = await requests.claim(view.id, (current) => requests.withdraw(current.id));

    if (probe.claimed) {
        return withdrawn(
            `Request ${view.id} was still waiting, but no window showed it any more (its window timed out or never opened), so it was withdrawn.`
        );
    }

    if (probe.view.outcome.status !== "pending") {
        return settledAttempt(probe.view, next, askAgain);
    }

    return changed ? older() : { kind: "waiting", view: probe.view };
}

/** Makes each row the user left ticked in `request` the user's decision; the unticked ones stay the agent's. */
async function adoptTicked(options: {
    rows: readonly RelayedRow[];
    client: Pick<MeetingsClient, "call">;
    request: { id: string; rows?: RequestRow[] };
    picked: RequestOutcome["picked"];
    skipped: RelayedSkip[];
    stay: string;
}): Promise<RelayedResult> {
    const { rows, client, request, skipped, stay } = options;
    const picked = new Set(options.picked ?? (request.rows ?? []).map((row) => row.id));
    const adopted: RelayedResult["adopted"] = [];
    const left: RelayedResult["left"] = [];
    const groups = new Map<string, RelayedRow[]>();

    for (const row of rows) {
        if (!picked.has(relayedRowId(row.meeting.id, row.item, row.entry.token))) {
            left.push({ meeting: row.meeting.id, item: row.label });
            continue;
        }

        const key = `${row.meeting.id}\u0000${row.entry.token}`;
        groups.set(key, [...(groups.get(key) ?? []), row]);
    }

    for (const group of groups.values()) {
        const { meeting, entry } = group[0]!;
        const items = group.map((row) => row.item);

        try {
            const decided = await client.call("decision.apply", {
                meeting: meeting.id,
                action: adoptionAction(entry, items),
                ...(entry.reason ? { reason: entry.reason } : {}),
                confirmedBy: { request: request.id },
            });

            if (decided.entry) {
                adopted.push({ meeting: meeting.id, items: group.map((row) => row.label), token: decided.entry.token });
            } else {
                skipped.push(
                    ...group.map((row) => ({
                        meeting: meeting.id,
                        item: row.label,
                        reason: decided.skipped[0]?.reason ?? "the journal changed nothing",
                    }))
                );
            }
        } catch (error) {
            skipped.push(...group.map((row) => ({ meeting: meeting.id, item: row.label, reason: errorText(error) })));
        }
    }

    const failed = skipped.length > 0 && adopted.length < groups.size;
    const notes = [
        ...(left.length
            ? [
                  `The user left out ${left.map((row) => `${row.meeting} ${row.item}`).join(", ")}: ${stay.charAt(0).toLowerCase()}${stay.slice(1)} Do not ask again for them unless the user tells you to.`,
              ]
            : []),
        ...(failed ? skipped.map((skip) => `${skip.meeting} ${skip.item}: ${skip.reason}`) : []),
    ];
    return {
        request: request.id,
        adopted,
        left,
        skipped,
        ...(notes.length ? { instructions: { text: notes.join("\n"), severity: "warning", stop: false } } : {}),
    };
}

/**
 * Asks the user, in one confirmation window, whether the answers an agent relayed are theirs, and makes each ticked
 * one the user's decision. The person area never makes an agent wait, so an agent's first run posts the window and
 * returns instructions to stop; the same run again reads the answer to the newest attempt and adopts the ticked rows.
 * An attempt that ended without the user's answer, or whose window no longer shows it, is asked again as a new
 * attempt with the rows this code renders; after the user's Not now only `askAgain` asks again. Through `client`,
 * so the Meetings window hears each decision; the service checks the request before it names the user.
 */
export async function confirmRelayed(options: {
    groups: readonly RelayedGroup[];
    store: MeetingStore;
    client: Pick<MeetingsClient, "call">;
    /** The command or call that runs this again. */
    rerun: string;
    /** The same command for when the user asks for the window again after answering Not now. */
    rerunAskingAgain: string;
    /** The user asked for the window again: an earlier Not now no longer stops a new request. */
    askAgain?: boolean;
    gt?: RelayedConfirmDoor;
    /** The person area's request journal; the default is the one the person area writes. */
    requests?: RelayedRequests;
}): Promise<RelayedResult> {
    const { store, client, rerun } = options;
    const rows: RelayedRow[] = [];
    const skipped: RelayedSkip[] = [];
    const records = new Map<string, MeetingRecord>();

    for (const group of options.groups) {
        const record = store.resolve(group.meeting);

        if (!record) {
            skipped.push(...group.items.map((item) => ({ meeting: group.meeting, item, reason: "no such meeting" })));
            continue;
        }

        records.set(record.id, record);
        const { entries } = await client.call("journal.read", { meeting: record.id });

        for (const ref of group.items) {
            const found = relayedOf({ record, ref, entries });

            if ("skip" in found) {
                skipped.push({ meeting: record.id, item: ref, reason: found.skip });
            } else if (!rows.some((row) => row.meeting.id === record.id && row.item === found.row.item)) {
                rows.push(found.row);
            }
        }
    }

    const skippedLines = skipped.map((skip) => `${skip.meeting} ${skip.item}: ${skip.reason}`);

    if (rows.length === 0) {
        return {
            adopted: [],
            left: [],
            skipped,
            instructions: stopped("info", [
                "No answer an agent relayed is left to confirm; nothing changed.",
                ...skippedLines,
            ]),
        };
    }

    const stay = "They stay the agent's answers: voice samples and the meeting's learning do not use them.";

    if (rows.length > 40) {
        throw new Error(`One window holds at most 40 answers; ${rows.length} were named. Confirm them in parts.`);
    }

    // A sandbox home (GENESIS_TOOLS_HOME elsewhere: probes, measures, copies) must not reach the real person.
    if (!options.gt && sandboxInstalled()) {
        return {
            adopted: [],
            left: [],
            skipped,
            instructions: stopped("error", [
                `This run uses the sandbox home ${env.tools.getHome()}, so no confirmation window reached the user. ${stay}`,
            ]),
        };
    }

    const fresh = relayedRequest(rows, records, await relayedPlays(rows, records, client));
    const [{ createRequestJournal }, { noticeInputSchema }] = await Promise.all([
        import("@genesiscz/utils/genesis-tools/areas/person/journal"),
        import("@genesiscz/utils/genesis-tools/areas/person/request"),
    ]);
    const requests = options.requests ?? createRequestJournal();
    // What a window shows, apart from its id: a stored request reads back through the same schema.
    const rendering = (input: NoticeInput): string | null => {
        const parsed = noticeInputSchema.safeParse({ ...input, id: fresh.id });
        return parsed.success ? sha256Json(parsed.data) : null;
    };
    const current = rendering(fresh);
    const prior = await priorAttempt({
        requests,
        family: fresh.id,
        renders: (posted) => rendering(posted) === current,
        askAgain: options.askAgain === true,
    });
    const these = rows.length === 1 ? "this answer is" : `these ${rows.length} answers are`;
    const waiting = (id: string, lead: string[]): RelayedResult => ({
        request: id,
        adopted: [],
        left: [],
        skipped,
        instructions: stopped("info", [
            ...lead,
            "Ask the user to answer that window; each row has its quote and a Play button.",
            `After the user answers, run the same command again; it records the ticked answers as the user's: ${rerun}`,
            `The answer so far: ${toolCommand("genesis-tools", "request", "show", id)}`,
            ...skippedLines,
        ]),
    });
    const declined = (id: string): RelayedResult => ({
        request: id,
        adopted: [],
        left: [],
        skipped,
        instructions: stopped("error", [
            `The user answered ${NOT_NOW} (request ${id}). ${stay}`,
            "Do not ask again for these answers unless the user tells you to.",
            `When the user asks for the window again, run: ${options.rerunAskingAgain}`,
        ]),
    });

    if (prior.kind === "answered") {
        const { view } = prior;
        return adoptTicked({ rows, client, request: view.request, picked: view.outcome.picked, skipped, stay });
    }

    if (prior.kind === "declined") {
        return declined(prior.view.id);
    }

    if (prior.kind === "waiting") {
        return waiting(prior.view.id, [
            `A confirmation window still asks the user whether ${these} theirs (request ${prior.view.id}). Nothing changed yet.`,
        ]);
    }

    const request: NoticeInput = { ...fresh, id: relayedAttemptId(fresh.id, prior.attempt) };
    let outcome: Awaited<ReturnType<RelayedConfirmDoor["person"]["confirm"]>>;

    try {
        const gt = options.gt ?? (await import("@genesiscz/utils/genesis-tools")).gt;
        outcome = await gt.person.confirm(request);
    } catch (error) {
        logger.warn({ error, request: request.id }, "relayed answers: the confirmation request could not be posted");
        return {
            request: request.id,
            adopted: [],
            left: [],
            skipped,
            instructions: stopped("error", [
                ...prior.why,
                `The confirmation request could not be posted (${errorText(error)}). ${stay}`,
            ]),
        };
    }

    if (outcome.status === "unreachable") {
        const why = outcome.manual ?? outcome.skipped.map((skip) => skip.reason).join("; ");
        return {
            request: request.id,
            adopted: [],
            left: [],
            skipped,
            instructions: stopped("error", [
                ...prior.why,
                `No confirmation window could reach the user (${why}). ${stay}`,
            ]),
        };
    }

    const answer = outcome.value;

    if (answer.status === "pending") {
        return waiting(request.id, [
            ...prior.why,
            `${prior.why.length ? "A new" : "A"} confirmation window asks the user now whether ${these} theirs (request ${request.id}). Nothing changed yet.`,
        ]);
    }

    if (answer.status === "declined") {
        return declined(request.id);
    }

    if (answer.status !== "done") {
        return {
            request: request.id,
            adopted: [],
            left: [],
            skipped,
            instructions: stopped("error", [
                `The request ended ${answer.status}${answer.reason ? `: ${answer.reason}` : ""} (request ${request.id}). ${stay}`,
                `It ended without the user's answer, so it does not stop a new window: when the user can answer one, run the same command again: ${rerun}`,
            ]),
        };
    }

    return adoptTicked({ rows, client, request, picked: answer.picked, skipped, stay });
}

/** Who may name the user in a decision: the actor of a request the user answered with this row ticked. */
export function relayedActor(options: {
    request: { id: string; rows?: RequestRow[]; status: string; picked?: string[]; via?: string | null } | null;
    meeting: string;
    items: readonly string[];
    earlier: JournalReadEntry | undefined;
    action: DecisionAction;
}): DecisionActor {
    const { request, meeting, items, earlier, action } = options;

    if (!request || request.status !== "done") {
        throw new Error(
            `The user has not confirmed request ${request?.id ?? "(none)"}, so the decision cannot name the user.`
        );
    }

    if (!earlier || earlier.actor.kind !== "agent" || !("replaces" in action) || action.replaces !== earlier.token) {
        throw new Error("A confirmed relay decides again the agent's own entry: give its token as replaces.");
    }

    const expected = adoptionAction(earlier, [...items]);

    if (sha256Json(expected) !== sha256Json(action)) {
        throw new Error(
            "A confirmed relay must decide exactly what the agent decided; the user confirmed that answer."
        );
    }

    const rows = new Set((request.rows ?? []).map((row) => row.id));
    const picked = new Set(request.picked ?? rows);

    for (const item of items) {
        const id = relayedRowId(meeting, item, earlier.token);

        if (!rows.has(id) || !picked.has(id)) {
            throw new Error(`The user did not confirm ${item} in request ${request.id}.`);
        }
    }

    return { kind: "request", request: request.id, via: request.via ?? null, relayedBy: earlier.actor };
}
