import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { watchFileFeed } from "@genesiscz/utils/fs/file-feed-watcher";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { isProcessAliveSince } from "@genesiscz/utils/process-identity";
import { toolDataDir } from "@genesiscz/utils/storage/root";
import { z } from "zod";
import { type NoticeInput, type RequestOutcome, requestOutcomeSchema, requestSchema } from "./request";

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

/** Every prefix has a state; an empty/torn post has no request yet. The first terminal event wins. */
export function stateOf(events: readonly RequestEvent[], alive: (pid: number) => boolean): RequestView | null {
    const posted = events.find((entry) => entry.type === "posted");
    if (posted?.type !== "posted") {
        return null;
    }
    let state: RequestView["state"] = "waiting";
    let outcome: RequestOutcome = { id: posted.request.id, status: "pending", reason: null };
    let runner: number | null = null;
    let ended = false;
    for (const entry of events) {
        if (ended) {
            break;
        }
        switch (entry.type) {
            case "posted":
            case "delivered":
                break;
            case "accepted":
                state = "accepted";
                outcome = { ...outcome, via: entry.via, elevation: entry.elevation, method: entry.method };
                break;
            case "started":
                state = "running";
                runner = entry.runnerPid;
                break;
            case "finished":
                state = entry.exitCode === 0 ? "done" : "failed";
                outcome = {
                    ...outcome,
                    status: state,
                    exitCode: entry.exitCode,
                    outputTail: entry.outputTail,
                    verified: entry.verified,
                };
                ended = true;
                break;
            case "declined":
                state = "declined";
                outcome = { ...outcome, status: state, via: entry.via, note: entry.note };
                ended = true;
                break;
            case "obsolete":
                state = "obsolete";
                outcome = { ...outcome, status: state, reason: entry.reason };
                ended = true;
                break;
            case "withdrawn":
                state = "withdrawn";
                outcome = { ...outcome, status: "obsolete", reason: entry.reason };
                ended = true;
                break;
        }
    }
    if (state === "running" && runner !== null && !alive(runner)) {
        state = "interrupted";
        outcome = { ...outcome, status: "failed", reason: "The request runner ended before recording its result." };
    }
    return { id: posted.request.id, request: posted.request, state, events: [...events], outcome };
}

export interface RequestJournal {
    postOnce(options: { input: NoticeInput; timeoutMs?: number }): Promise<{ view: RequestView; created: boolean }>;
    post(options: { input: NoticeInput; timeoutMs?: number }): Promise<RequestView>;
    get(id: string): RequestView | null;
    list(): RequestView[];
    append(id: string, event: RequestEvent): void;
    settle(
        id: string,
        status: "done" | "failed" | "declined" | "obsolete" | "unreachable",
        reason?: string | null,
        detail?: { via?: string; method?: "click" | "terminal" | "touch-id" | "password" }
    ): Promise<RequestOutcome>;
    withdraw(id: string): Promise<RequestOutcome>;
    wait(id: string, timeoutMs: number): Promise<RequestOutcome>;
    onChange(listener: (view: RequestView) => void): () => void;
}

interface FileRequestJournal extends RequestJournal {
    followChanges(listener: (view: RequestView) => void, pollFallbackMs: number): () => void;
}

export function createRequestJournal(
    options: { dir?: string; now?: () => Date; alive?: (pid: number) => boolean } = {}
): FileRequestJournal {
    const dir = options.dir ?? toolDataDir("genesis-tools", "requests");
    const now = options.now ?? (() => new Date());
    const listeners = new Set<(view: RequestView) => void>();
    function fileOf(id: string): string {
        if (!/^[a-zA-Z0-9:._-]{1,500}$/.test(id)) {
            throw new Error("Invalid request id");
        }
        return join(dir, `${encodeURIComponent(id)}.jsonl`);
    }
    function events(id: string): RequestEvent[] {
        const file = fileOf(id);
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
                return [requestEventSchema.parse(raw)];
            });
    }
    function viewOf(id: string, all: RequestEvent[]): RequestView | null {
        const first = all.find((event) => event.type === "posted");
        if (first?.type === "posted" && first.request.id !== id) {
            throw new Error("The journal belongs to another request");
        }
        const started = all.findLast((event) => event.type === "started");
        return stateOf(all, options.alive ?? ((pid) => isProcessAliveSince(pid, started ? Date.parse(started.at) : 0)));
    }
    function read(id: string): RequestView | null {
        return viewOf(id, events(id));
    }
    function emit(id: string): void {
        const view = read(id);
        if (view) {
            for (const listener of listeners) {
                listener(view);
            }
        }
    }
    function journalFiles(): string[] {
        return existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith(".jsonl")) : [];
    }
    function idFromFile(name: string): string {
        return decodeURIComponent(name.slice(0, -".jsonl".length));
    }
    function followChanges(listener: (view: RequestView) => void, pollFallbackMs: number): () => void {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        const reported = new Map<string, number>();
        const scannedSizes = new Map<string, number>();

        // Local appends and coalesced folder events share one cursor per append-only journal.
        function publish(view: RequestView): void {
            const count = view.events.length;
            const previous = reported.get(view.id) ?? 0;
            for (let length = previous + 1; length <= count; length++) {
                const next = length === count ? view : viewOf(view.id, view.events.slice(0, length));
                reported.set(view.id, length);

                if (next) {
                    listener(next);
                }
            }
        }

        function scan(visit: (view: RequestView) => void): void {
            for (const name of journalFiles()) {
                try {
                    const size = statSync(join(dir, name)).size;
                    if (scannedSizes.get(name) === size) {
                        continue;
                    }

                    const view = read(idFromFile(name));
                    if (view) {
                        visit(view);
                    }

                    scannedSizes.set(name, size);
                } catch (error) {
                    logger.warn({ error, name }, "Could not follow a request journal");
                }
            }
        }

        scan((view) => reported.set(view.id, view.events.length));
        const off = journal.onChange(publish);
        const controller = new AbortController();
        void watchFileFeed({ path: dir, signal: controller.signal, pollFallbackMs, onChange: () => scan(publish) });
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
            mkdirSync(dir, { recursive: true, mode: 0o700 });
            const event = requestEventSchema.parse({ type: "posted", at: now().toISOString(), request, asker: null });
            try {
                writeFileSync(fileOf(request.id), `${SafeJSON.stringify(event)}\n`, { flag: "wx", mode: 0o600 });
            } catch (error) {
                if (!existsSync(fileOf(request.id))) {
                    throw error;
                }
                const rival = read(request.id);
                if (rival) {
                    return { view: rival, created: false };
                }
                journal.append(request.id, event);
            }
            emit(request.id);
            return { view: read(request.id)!, created: true };
        },
        get: read,
        list: () =>
            journalFiles().flatMap((name) => {
                const view = read(idFromFile(name));
                return view ? [view] : [];
            }),
        append: (id, event) => {
            if (event.type === "posted" && event.request.id !== id) {
                throw new Error("Cannot append a different request id");
            }
            mkdirSync(dir, { recursive: true, mode: 0o700 });
            // A leading newline separates any torn tail. Existing bytes are never edited.
            appendFileSync(fileOf(id), `\n${SafeJSON.stringify(requestEventSchema.parse(event))}\n`, { mode: 0o600 });
            emit(id);
        },
        settle: async (id, status, reason = null, detail = {}) => {
            const current = read(id);
            if (!current) {
                throw new Error(`request ${id} does not exist`);
            }
            if (current.outcome.status !== "pending") {
                return current.outcome;
            }
            const stamp = now().toISOString();
            if (status === "done") {
                journal.append(id, {
                    type: "accepted",
                    at: stamp,
                    via: detail.via ?? "notice",
                    elevation: null,
                    method: detail.method ?? "click",
                });
                journal.append(id, { type: "finished", at: stamp, exitCode: 0, outputTail: "", verified: null });
            } else if (status === "declined") {
                journal.append(id, { type: "declined", at: stamp, via: detail.via ?? "notice", note: reason });
            } else if (status === "obsolete") {
                journal.append(id, { type: "obsolete", at: stamp, reason: reason ?? "The condition went away." });
            } else {
                journal.append(id, {
                    type: "finished",
                    at: stamp,
                    exitCode: 1,
                    outputTail: reason ?? status,
                    verified: null,
                });
            }
            return read(id)!.outcome;
        },
        withdraw: async (id) => {
            const current = read(id);
            if (!current) {
                throw new Error(`request ${id} does not exist`);
            }
            if (current.outcome.status === "pending") {
                journal.append(id, { type: "withdrawn", at: now().toISOString(), reason: "Withdrawn by its caller." });
            }
            return read(id)!.outcome;
        },
        wait: (id, timeoutMs) =>
            new Promise((resolve, reject) => {
                const controller = new AbortController();
                const finish = (view: RequestView | null) => {
                    if (view?.id === id && view.outcome.status !== "pending") {
                        clearTimeout(timer);
                        controller.abort();
                        off();
                        resolve(view.outcome);
                    }
                };
                const off = journal.onChange(finish);
                const timer = setTimeout(() => {
                    controller.abort();
                    off();
                    const view = read(id);
                    if (view) {
                        resolve(view.outcome);
                    } else {
                        reject(new Error(`request ${id} does not exist`));
                    }
                }, timeoutMs);
                finish(read(id));
                void watchFileFeed({
                    path: fileOf(id),
                    signal: controller.signal,
                    deadlineAt: Date.now() + timeoutMs,
                    debounceMs: 100,
                    pollFallbackMs: 60_000,
                    onChange: () => {
                        const view = read(id);
                        finish(view);
                        return { done: view?.outcome.status !== "pending" };
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
