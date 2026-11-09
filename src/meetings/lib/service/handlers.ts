import { type RpcHandlers, type RpcTable, toRpcTable } from "@genesiscz/utils/api-descriptor";
import type { MeetingsConfig } from "@genesiscz/utils/meetings/config";
import {
    MEETINGS_CONFLICT_CODES,
    MEETINGS_STATE_CODES,
    MeetingsConflictError,
    MeetingsStateError,
} from "@genesiscz/utils/meetings/conflict";
import type { Correction } from "@genesiscz/utils/meetings/corrections";
import { type MeetingRecord, MeetingStore } from "@genesiscz/utils/meetings/record";
import { RpcError } from "@genesiscz/utils/rpc/errors";
import { meetingListRow, selectMeetings } from "../list-rows";
import { TOOL } from "../shared";
import type { LinkedSource } from "../sources";
import { correctedTranscriptRead, revisionsRead, transcriptJsonView } from "../window-reads";
import {
    MEETINGS_REFUSED,
    type MeetingsErrorCode,
    type MeetingsEvent,
    type MeetingsHello,
    type MeetingsNotification,
    type MeetingsResult,
    meetingsApi,
    meetingsErrorDataSchema,
} from "./api";

/**
 * The handlers of the Meetings service's methods, one set for both adapters: the service runs them for its
 * connections, a command without a service runs them in its own process (`InProcessMeetingsClient`). `hello` is the
 * adapter's own, since only it knows the connection.
 */

/** What a handler knows of its call. */
export interface MeetingsCallContext {
    /** Who the connection said it is; set by `hello`. */
    caller?: MeetingsHello;
    signal?: AbortSignal;
    /** `hello` answers through the adapter that owns the connection. */
    hello: (hello: MeetingsHello) => MeetingsResult<"hello">;
    /**
     * True when the handler runs in the caller's own process (the in-process adapter): a caller without a harness in
     * its hello is then this process, whose agent identity a decision reads itself.
     */
    local?: boolean;
    /** Tells the subscribers (the service's connections, or this process's listeners) what a write did. */
    emit?: <E extends MeetingsEvent>(event: E, params: MeetingsNotification<E>) => void;
}

export interface MeetingsHandlerDeps {
    /** The meetings store (a test passes a scratch one). */
    store?: () => MeetingStore;
    /** The transcript source of a record; tests pass a fake one, production asks the record's linked source. */
    linkedSource?: (record: MeetingRecord) => LinkedSource | undefined;
    /** Where a decision's corrections go (tests keep them); the corrections ledger by default. */
    ledger?: (corrections: Correction[]) => void;
    /** The corrections ledger a plan's dictionary reach reads (tests pass lines); the ledger file by default. */
    readLedger?: () => Correction[];
    /** The meetings config (tests pass one); the config file by default. */
    config?: () => Promise<MeetingsConfig>;
    /** The clock of a decision's time (tests fix it). */
    now?: () => Date;
}

/** A refusal: JSON-RPC error 1100 with `data.code`, the same through the socket and in-process. */
export function refusal(code: MeetingsErrorCode, message: string): RpcError {
    return new RpcError(MEETINGS_REFUSED, message, { code });
}

/**
 * Any error a handler threw, as the service answers it: an RpcError as it is, a conflict or a meeting state with its
 * own code (the CLI prints `[code] sentence` from it), anything else as `fallback`.
 */
export function asRefusal(error: unknown, fallback: MeetingsErrorCode = "failed"): RpcError {
    if (error instanceof RpcError) {
        return error;
    }

    if (error instanceof MeetingsConflictError || error instanceof MeetingsStateError) {
        return refusal(error.code, error.message);
    }

    return refusal(fallback, error instanceof Error ? error.message : String(error));
}

/** The code of a refusal (`data.code`); undefined for a transport error (a bad param, an unknown method). */
export function refusalCode(error: RpcError): MeetingsErrorCode | undefined {
    if (error.code !== MEETINGS_REFUSED) {
        return undefined;
    }

    const data = meetingsErrorDataSchema.safeParse(error.data);
    return data.success ? data.data.code : undefined;
}

/** A refusal the service did not class as a conflict or a meeting state; `code` names it, `data` is its error data. */
export class MeetingsServiceError extends Error {
    constructor(
        readonly code: MeetingsErrorCode,
        message: string,
        readonly data?: unknown
    ) {
        super(message);
        this.name = "MeetingsServiceError";
    }
}

const isConflictCode = (code: string): code is MeetingsConflictError["code"] =>
    (MEETINGS_CONFLICT_CODES as readonly string[]).includes(code);
const isStateCode = (code: string): code is MeetingsStateError["code"] =>
    (MEETINGS_STATE_CODES as readonly string[]).includes(code);

/**
 * The error a client throws for a failed call: a conflict or a meeting state as its own class, so the CLI's
 * `errorText` prints the same `[code] sentence` it printed before the service; anything else as a
 * `MeetingsServiceError` with the service's sentence.
 */
export function clientError(error: unknown): Error {
    if (!(error instanceof RpcError)) {
        return error instanceof Error ? error : new Error(String(error));
    }

    const code = refusalCode(error) ?? "failed";

    if (isConflictCode(code)) {
        return new MeetingsConflictError(code, error.message);
    }

    if (isStateCode(code)) {
        return new MeetingsStateError(code, error.message);
    }

    return new MeetingsServiceError(code, error.message, error.data);
}

/** The record a command names, or the refusal the CLI printed for it before the service. */
export function recordOf(store: MeetingStore, ref: string): MeetingRecord {
    let record: MeetingRecord | undefined;

    try {
        record = store.resolve(ref);
    } catch (error) {
        throw asRefusal(error, "meeting-ref");
    }

    if (!record) {
        throw refusal("meeting-not-found", `No meeting "${ref}". List them: ${TOOL} list`);
    }

    return record;
}

const decisions = () => import("./decision-handlers");

/** The handlers of every method but `hello`'s own work, which the context's adapter does. */
export function meetingsHandlers(deps: MeetingsHandlerDeps = {}): RpcHandlers<typeof meetingsApi, MeetingsCallContext> {
    const storeOf = deps.store ?? (() => new MeetingStore());

    return {
        hello: (params, context) => context.hello(params),
        "meetings.list": (params) => {
            const records = selectMeetings(storeOf().list(), { project: params.project, limit: params.limit });
            return params.full ? records : records.map(meetingListRow);
        },
        "meeting.show": (params) => recordOf(storeOf(), params.ref),
        "meeting.transcript": async (params) => {
            const store = storeOf();
            const record = recordOf(store, params.ref);
            const { applied } = await correctedTranscriptRead({
                store,
                record,
                format: "json",
                // As commander hands `transcript --format json` its flags: the dictionary is on unless turned off.
                flags: {
                    dictionary: params.dictionary ?? true,
                    frontmatter: true,
                    ...(params.withSuggested !== undefined ? { withSuggested: params.withSuggested } : {}),
                },
                linked: deps.linkedSource?.(record),
            });
            return transcriptJsonView(record, applied);
        },
        "meeting.revisions": (params) => {
            const store = storeOf();
            const record = recordOf(store, params.ref);
            return revisionsRead({ store, record, linked: deps.linkedSource?.(record) });
        },
        // The decisions load the journal and its rules (about 40 ms) only when a call decides.
        "decision.plan": async (params, context) => (await decisions()).planDecision(params, context, storeOf(), deps),
        "decision.apply": async (params, context) =>
            (await decisions()).applyDecision(params, context, storeOf(), deps),
        "decision.revert": async (params, context) =>
            (await decisions()).revertDecision(params, context, storeOf(), deps),
        "journal.read": async (params) => (await decisions()).readJournal(params, storeOf()),
    };
}

/** The method table both adapters call: params checked against the descriptor, then the handler. */
export function meetingsTable(deps: MeetingsHandlerDeps = {}): RpcTable<MeetingsCallContext> {
    return toRpcTable<typeof meetingsApi, MeetingsCallContext>(meetingsApi, meetingsHandlers(deps));
}
