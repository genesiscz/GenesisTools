import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { watchFileFeed } from "@genesiscz/utils/fs/file-feed-watcher";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { isProcessAliveSince } from "@genesiscz/utils/process-identity";
import { LockTimeoutError, withFileLock } from "@genesiscz/utils/storage/file-lock";
import { toolDataDir } from "@genesiscz/utils/storage/root";
import { z } from "zod";
import {
    type NoticeInput,
    REQUEST_ID_PATTERN,
    type RequestOutcome,
    requestOutcomeSchema,
    requestSchema,
} from "./request";

const at = z.string().datetime();
const via = z.string();
export const askerSchema = z.object({
    agent: z.string().optional(),
    session: z.string().optional(),
    project: z.string().optional(),
    branch: z.string().optional(),
});
export type Asker = z.infer<typeof askerSchema>;
export const requestEventSchema = z.discriminatedUnion("type", [
    z.object({ type: z.literal("posted"), at, request: requestSchema, asker: askerSchema.nullable() }),
    z.object({
        type: z.literal("delivered"),
        at,
        channel: z.enum(["dialog", "notification", "terminal"]),
        noticeId: z.string().nullable(),
    }),
    z.object({
        type: z.literal("accepted"),
        at,
        via,
        elevation: z.string().nullable(),
        method: z.enum(["click", "touch-id", "password", "terminal"]),
    }),
    z.object({ type: z.literal("declined"), at, via, note: z.string().nullable() }),
    z.object({
        type: z.literal("started"),
        at,
        runnerPid: z.number().int().positive(),
        where: z.enum(["terminal", "background"]),
    }),
    z.object({
        type: z.literal("finished"),
        at,
        exitCode: z.number().int(),
        outputTail: z.string(),
        verified: z.boolean().nullable(),
    }),
    z.object({ type: z.literal("obsolete"), at, reason: z.string() }),
    z.object({ type: z.literal("withdrawn"), at, reason: z.string() }),
]);
export type RequestEvent = z.infer<typeof requestEventSchema>;
export const requestStateSchema = z.enum([
    "waiting",
    "accepted",
    "running",
    "interrupted",
    "done",
    "failed",
    "declined",
    "obsolete",
    "withdrawn",
]);
export const requestViewSchema = z.object({
    id: z.string(),
    request: requestSchema,
    state: requestStateSchema,
    events: z.array(requestEventSchema),
    outcome: requestOutcomeSchema,
});
export type RequestView = z.infer<typeof requestViewSchema>;

type PostedEvent = Extract<RequestEvent, { type: "posted" }>;
type RequestState = RequestView["state"];
const TERMINAL_STATES: ReadonlySet<RequestState> = new Set(["done", "failed", "declined", "obsolete", "withdrawn"]);

/** The state a request has after a run of events; `step` advances it by one event, so a replay never starts over. */
interface Fold {
    posted: PostedEvent;
    state: RequestState;
    outcome: RequestOutcome;
    runner: { pid: number; since: number } | null;
    ended: boolean;
}

function startFold(posted: PostedEvent): Fold {
    return {
        posted,
        state: "waiting",
        outcome: { id: posted.request.id, status: "pending", reason: null },
        runner: null,
        ended: false,
    };
}

function step(fold: Fold, entry: RequestEvent): void {
    if (fold.ended) {
        return;
    }

    switch (entry.type) {
        case "posted":
        case "delivered":
            break;
        case "accepted":
            fold.state = "accepted";
            fold.outcome = { ...fold.outcome, via: entry.via, elevation: entry.elevation, method: entry.method };
            break;
        case "started":
            fold.state = "running";
            fold.runner = { pid: entry.runnerPid, since: Date.parse(entry.at) };
            break;
        case "finished":
            fold.state = entry.exitCode === 0 ? "done" : "failed";
            fold.outcome = {
                ...fold.outcome,
                status: fold.state,
                exitCode: entry.exitCode,
                outputTail: entry.outputTail,
                verified: entry.verified,
            };
            fold.ended = true;
            break;
        case "declined":
            fold.state = "declined";
            fold.outcome = { ...fold.outcome, status: "declined", via: entry.via, note: entry.note };
            fold.ended = true;
            break;
        case "obsolete":
            fold.state = "obsolete";
            fold.outcome = { ...fold.outcome, status: "obsolete", reason: entry.reason };
            fold.ended = true;
            break;
        case "withdrawn":
            fold.state = "withdrawn";
            fold.outcome = { ...fold.outcome, status: "obsolete", reason: entry.reason };
            fold.ended = true;
            break;
    }
}

function viewOfFold(fold: Fold, events: RequestEvent[], alive: (pid: number, since: number) => boolean): RequestView {
    if (fold.state === "running" && fold.runner !== null && !alive(fold.runner.pid, fold.runner.since)) {
        return {
            id: fold.posted.request.id,
            request: fold.posted.request,
            state: "interrupted",
            events,
            outcome: {
                ...fold.outcome,
                status: "failed",
                reason: "The request runner ended before recording its result.",
            },
        };
    }

    return {
        id: fold.posted.request.id,
        request: fold.posted.request,
        state: fold.state,
        events,
        outcome: fold.outcome,
    };
}

/** Every prefix has a state; an empty/torn post has no request yet. The first terminal event wins. */
export function stateOf(
    events: readonly RequestEvent[],
    alive: (pid: number, since: number) => boolean
): RequestView | null {
    const posted = events.find((entry) => entry.type === "posted");
    if (posted?.type !== "posted") {
        return null;
    }

    const fold = startFold(posted);
    for (const entry of events) {
        step(fold, entry);
    }

    return viewOfFold(fold, [...events], alive);
}

/**
 * The view after each of `events.length - after` trailing events, oldest first, folded in one pass. A prefix before
 * the posted event has no view and is skipped.
 */
function prefixViews(
    events: readonly RequestEvent[],
    after: number,
    alive: (pid: number, since: number) => boolean
): RequestView[] {
    const views: RequestView[] = [];
    let fold: Fold | null = null;
    for (let index = 0; index < events.length; index++) {
        const entry = events[index];
        if (!fold && entry.type === "posted") {
            fold = startFold(entry);
        }

        if (fold) {
            step(fold, entry);
            if (index + 1 > after) {
                views.push(viewOfFold(fold, events.slice(0, index + 1), alive));
            }
        }
    }

    return views;
}

/** What `claim` found: it ran the work, or another worker holds the request or the request is already settled. */
export type RequestClaim<T> = { claimed: true; value: T } | { claimed: false; view: RequestView };

export interface RequestJournal {
    postOnce(options: { input: NoticeInput; timeoutMs?: number }): Promise<{ view: RequestView; created: boolean }>;
    post(options: { input: NoticeInput; timeoutMs?: number }): Promise<RequestView>;
    get(id: string): RequestView | null;
    /** The newest `limit` requests by post time, oldest first. A journal that cannot be read is logged and left out. */
    list(options?: { limit?: number }): RequestView[];
    /** The requests that still wait for an answer, without replaying the histories of settled ones. */
    pending(): RequestView[];
    append(id: string, event: RequestEvent): void;
    settle(
        id: string,
        status: "done" | "failed" | "declined" | "obsolete" | "unreachable",
        reason?: string | null,
        detail?: { via?: string; method?: "click" | "terminal" | "touch-id" | "password" }
    ): Promise<RequestOutcome>;
    withdraw(id: string): Promise<RequestOutcome>;
    /**
     * Run `work` as the only presenter of a waiting request, across processes. It does not wait: when another worker
     * presents the request, or it is no longer waiting, `work` does not run.
     */
    claim<T>(id: string, work: (view: RequestView) => Promise<T>): Promise<RequestClaim<T>>;
    wait(id: string, timeoutMs: number): Promise<RequestOutcome>;
    onChange(listener: (view: RequestView) => void): () => void;
}

interface FileRequestJournal extends RequestJournal {
    followChanges(listener: (view: RequestView) => void, pollFallbackMs: number): () => void;
}

/** The longest file name the common file systems accept (ext4, APFS, NTFS). */
const MAX_NAME_BYTES = 255;

/** A file name that fits every file system and keeps ids that differ only in letter case apart. */
function fileStem(id: string): string {
    if (!REQUEST_ID_PATTERN.test(id)) {
        throw new Error("Invalid request id");
    }

    return createHash("sha256").update(id).digest("hex");
}

/** The journal file name of a request id. */
export function requestFileName(id: string): string {
    return `${fileStem(id)}.jsonl`;
}

export function createRequestJournal(
    options: { dir?: string; now?: () => Date; alive?: (pid: number) => boolean } = {}
): FileRequestJournal {
    const dir = options.dir ?? toolDataDir("genesis-tools", "requests");
    const now = options.now ?? (() => new Date());
    const alive = (pid: number, since: number) =>
        options.alive ? options.alive(pid) : isProcessAliveSince(pid, since);
    const listeners = new Set<(view: RequestView) => void>();
    /** Settled views by file name: a settled journal never changes state again, so it is read once. */
    const settled = new Map<string, RequestView>();

    function eventsAt(file: string): RequestEvent[] {
        if (!existsSync(file)) {
            return [];
        }

        return readFileSync(file, "utf8")
            .split("\n")
            .filter(Boolean)
            .flatMap((line) => {
                let raw: unknown;
                try {
                    raw = SafeJSON.parse(line, { strict: true });
                } catch (error) {
                    logger.debug({ error, file }, "request journal: skipping a torn line without rewriting it");
                    return [];
                }

                // A complete line that is not a known event is not skipped: it may be a terminal event this build
                // does not know, and reading past it could answer a settled request again.
                return [requestEventSchema.parse(raw)];
            });
    }

    /** An earlier build named the file after the encoded id; it is still read when it holds exactly this id. */
    function legacyFileOf(id: string): string | null {
        const name = `${encodeURIComponent(id)}.jsonl`;
        if (Buffer.byteLength(name) > MAX_NAME_BYTES) {
            return null;
        }

        const file = join(dir, name);
        if (!existsSync(file)) {
            return null;
        }

        const posted = eventsAt(file).find((event) => event.type === "posted");
        return posted?.type === "posted" && posted.request.id === id ? file : null;
    }

    function fileOf(id: string): string {
        const file = join(dir, requestFileName(id));
        return existsSync(file) ? file : (legacyFileOf(id) ?? file);
    }

    function lockOf(id: string, purpose: "write" | "present"): string {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        return join(dir, `${fileStem(id)}.${purpose}.lock`);
    }

    /** Every terminal transition and every first post of one id runs under this lock, in every process. */
    function serialized<T>(id: string, work: () => Promise<T>): Promise<T> {
        return withFileLock(lockOf(id, "write"), work);
    }

    function viewOf(id: string, all: RequestEvent[]): RequestView | null {
        const first = all.find((event) => event.type === "posted");
        if (first?.type === "posted" && first.request.id !== id) {
            throw new Error("The journal belongs to another request");
        }

        return stateOf(all, alive);
    }

    function read(id: string): RequestView | null {
        return viewOf(id, eventsAt(fileOf(id)));
    }

    /** A listener observes a change that is already written: its failure must not stop the others or fail the write. */
    function notify(listener: (view: RequestView) => void, view: RequestView): void {
        try {
            listener(view);
        } catch (error) {
            logger.warn({ error, id: view.id }, "request journal: a change listener threw");
        }
    }

    function emit(id: string): void {
        let view: RequestView | null;
        try {
            view = read(id);
        } catch (error) {
            logger.warn({ error, id }, "request journal: cannot read a request to report its change");
            return;
        }

        if (view) {
            for (const listener of listeners) {
                notify(listener, view);
            }
        }
    }

    function writeEvents(id: string, events: RequestEvent[]): void {
        for (const event of events) {
            if (event.type === "posted" && event.request.id !== id) {
                throw new Error("Cannot append a different request id");
            }
        }

        mkdirSync(dir, { recursive: true, mode: 0o700 });
        const lines = events.map((event) => SafeJSON.stringify(requestEventSchema.parse(event))).join("\n");
        // A leading newline separates any torn tail. Existing bytes are never edited. One write keeps the lines of
        // one transition together.
        appendFileSync(fileOf(id), `\n${lines}\n`, { mode: 0o600 });
        emit(id);
    }

    /** Every readable request, with settled ones from memory. One that cannot be read costs only its own entry. */
    function views(): RequestView[] {
        if (!existsSync(dir)) {
            settled.clear();
            return [];
        }

        const names = readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
        const present = new Set(names);
        for (const name of settled.keys()) {
            if (!present.has(name)) {
                settled.delete(name);
            }
        }

        return names.flatMap((name) => {
            const known = settled.get(name);
            if (known) {
                return [known];
            }

            try {
                const view = stateOf(eventsAt(join(dir, name)), alive);
                if (!view || !belongsTo(name, view.id)) {
                    return [];
                }

                if (TERMINAL_STATES.has(view.state)) {
                    settled.set(name, view);
                }

                return [view];
            } catch (error) {
                logger.warn({ error, name }, "request journal: leaving out a journal that cannot be read");
                return [];
            }
        });
    }

    function belongsTo(name: string, id: string): boolean {
        return name === requestFileName(id) || name === `${encodeURIComponent(id)}.jsonl`;
    }

    function postedAt(view: RequestView): string {
        const posted = view.events.find((event) => event.type === "posted");
        return posted?.at ?? view.request.createdAt;
    }

    function followChanges(listener: (view: RequestView) => void, pollFallbackMs: number): () => void {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        const reported = new Map<string, number>();

        // Local appends and coalesced folder events share one cursor per append-only journal.
        function publish(view: RequestView): void {
            const previous = reported.get(view.id) ?? 0;
            if (view.events.length <= previous) {
                return;
            }

            const next = prefixViews(view.events, previous, alive);
            reported.set(view.id, view.events.length);
            for (const prefix of next) {
                notify(listener, prefix.events.length === view.events.length ? view : prefix);
            }
        }

        for (const view of views()) {
            reported.set(view.id, view.events.length);
        }

        const off = journal.onChange(publish);
        const controller = new AbortController();
        void watchFileFeed({
            path: dir,
            signal: controller.signal,
            pollFallbackMs,
            onChange: () => {
                for (const view of views()) {
                    publish(view);
                }
            },
        });
        return () => {
            controller.abort();
            off();
        };
    }

    const journal: FileRequestJournal = {
        followChanges,
        post: async (options) => (await journal.postOnce(options)).view,
        postOnce: async ({ input }) => {
            const request = requestSchema.parse({ ...input, createdAt: now().toISOString() });
            const current = read(request.id);
            if (current) {
                return { view: current, created: false };
            }

            return serialized(request.id, async () => {
                const rival = read(request.id);
                if (rival) {
                    return { view: rival, created: false };
                }

                const event = requestEventSchema.parse({
                    type: "posted",
                    at: now().toISOString(),
                    request,
                    asker: null,
                });
                const file = fileOf(request.id);
                if (existsSync(file)) {
                    // Every post holds the lock, so a file without a posted event was torn by a writer that exited.
                    writeEvents(request.id, [event]);
                } else {
                    mkdirSync(dir, { recursive: true, mode: 0o700 });
                    writeFileSync(file, `${SafeJSON.stringify(event)}\n`, { flag: "wx", mode: 0o600 });
                    emit(request.id);
                }

                return { view: read(request.id)!, created: true };
            });
        },
        get: read,
        list: (query?: { limit?: number }) => {
            const all = views().sort((a, b) => postedAt(a).localeCompare(postedAt(b)));
            return query?.limit === undefined ? all : all.slice(-query.limit);
        },
        pending: () => views().filter((view) => view.outcome.status === "pending"),
        append: (id, event) => writeEvents(id, [event]),
        settle: (id, status, reason = null, detail = {}) =>
            serialized(id, async () => {
                const current = read(id);
                if (!current) {
                    throw new Error(`request ${id} does not exist`);
                }

                if (current.outcome.status !== "pending") {
                    return current.outcome;
                }

                const stamp = now().toISOString();
                if (status === "done") {
                    const accepted: RequestEvent = {
                        type: "accepted",
                        at: stamp,
                        via: detail.via ?? "notice",
                        elevation: null,
                        method: detail.method ?? "click",
                    };
                    // An acceptance whose finish was lost is completed, never accepted a second time.
                    writeEvents(id, [
                        ...(current.state === "accepted" ? [] : [accepted]),
                        { type: "finished", at: stamp, exitCode: 0, outputTail: "", verified: null },
                    ]);
                } else if (status === "declined") {
                    writeEvents(id, [{ type: "declined", at: stamp, via: detail.via ?? "notice", note: reason }]);
                } else if (status === "obsolete") {
                    writeEvents(id, [{ type: "obsolete", at: stamp, reason: reason ?? "The condition went away." }]);
                } else {
                    writeEvents(id, [
                        { type: "finished", at: stamp, exitCode: 1, outputTail: reason ?? status, verified: null },
                    ]);
                }

                return read(id)!.outcome;
            }),
        withdraw: (id) =>
            serialized(id, async () => {
                const current = read(id);
                if (!current) {
                    throw new Error(`request ${id} does not exist`);
                }

                if (current.outcome.status === "pending") {
                    writeEvents(id, [
                        { type: "withdrawn", at: now().toISOString(), reason: "Withdrawn by its caller." },
                    ]);
                }

                return read(id)!.outcome;
            }),
        claim: async (id, work) => {
            let entered = false;
            try {
                return await withFileLock(
                    lockOf(id, "present"),
                    async () => {
                        entered = true;
                        const view = read(id);
                        if (!view) {
                            throw new Error(`request ${id} does not exist`);
                        }

                        if (view.outcome.status !== "pending") {
                            return { claimed: false, view };
                        }

                        return { claimed: true, value: await work(view) };
                    },
                    0
                );
            } catch (error) {
                if (entered || !(error instanceof LockTimeoutError)) {
                    throw error;
                }

                const view = read(id);
                if (!view) {
                    throw new Error(`request ${id} does not exist`);
                }

                return { claimed: false, view };
            }
        },
        wait: (id, timeoutMs) =>
            new Promise((resolve, reject) => {
                const controller = new AbortController();
                let settledWait = false;
                const end = (result: { view: RequestView } | { error: unknown }) => {
                    if (settledWait) {
                        return;
                    }

                    settledWait = true;
                    clearTimeout(timer);
                    controller.abort();
                    off();
                    if ("error" in result) {
                        reject(result.error);
                    } else {
                        resolve(result.view.outcome);
                    }
                };
                const readNow = (): RequestView | null => {
                    try {
                        const view = read(id);
                        if (!view) {
                            end({ error: new Error(`request ${id} does not exist`) });
                        }

                        return view;
                    } catch (error) {
                        end({ error });
                        return null;
                    }
                };
                const finish = (view: RequestView | null) => {
                    if (view?.id === id && view.outcome.status !== "pending") {
                        end({ view });
                    }
                };
                const off = journal.onChange(finish);
                const timer = setTimeout(() => {
                    const view = readNow();
                    if (view) {
                        end({ view });
                    }
                }, timeoutMs);
                finish(readNow());
                if (settledWait) {
                    return;
                }

                void watchFileFeed({
                    path: fileOf(id),
                    signal: controller.signal,
                    deadlineAt: Date.now() + timeoutMs,
                    debounceMs: 100,
                    pollFallbackMs: 60_000,
                    onChange: () => {
                        finish(readNow());
                        return { done: settledWait };
                    },
                });
            }),
        onChange: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
    };
    return journal;
}
