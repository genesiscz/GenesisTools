import type { AgentSessionRow } from "@app/ai/lib/sessions/agent-session-rows";
import { logger } from "@genesiscz/utils/logger";
import type { AgentsTree } from "../agents/types";
import { newestRosterRows, WIDGET_EXACT_PATHS_LIMIT, type WidgetRoster, type WidgetRosterScope } from "./roster-index";
import type { RosterPage } from "./roster-pages";

/**
 * A roster read, after refreshing the named parts of the shared index when `index` is not empty. With
 * `onlyIfChanged`, a refresh that changed no index row ends without the read when no other process wrote the index
 * since the worker's last read either: nothing the roster shows moved.
 */
export interface WidgetRosterRequest {
    id: number;
    index?: WidgetRosterScope[];
    /** The changed transcripts of a scope in `index`; a scope without an entry refreshes its whole listing. */
    paths?: Partial<Record<WidgetRosterScope, string[]>>;
    /** A listed parent whose sub-agent changed without changing the parent's own index row. */
    parentPaths?: string[];
    onlyIfChanged?: boolean;
}

export type WidgetRosterReply =
    | { id: number; ok: true; revision: string; page: RosterPage }
    | { id: number; ok: true; rows: AgentSessionRow[]; agents: AgentsTree }
    | { id: number; ok: true; unchanged: true }
    | { id: number; ok: false; error: string };

type RosterWorker = Pick<Worker, "postMessage" | "terminate" | "onmessage" | "onerror">;

/** Schedules `callback` after `ms` and returns its cancel function. */
export type RosterTimer = (callback: () => void, ms: number) => () => void;

const realTimer: RosterTimer = (callback, ms) => {
    const handle = setTimeout(callback, ms);
    return () => clearTimeout(handle);
};

/** How long a change waits for the rest of its burst before a requested run starts. */
const SETTLE_MS = 250;
/** The shortest pause between two requested runs, and the longest a steady stream of changes can stretch it to. */
const MIN_GAP_MS = 4000;
const MAX_GAP_MS = 15_000;
/**
 * The pause after a run is at least this many times the run's wall time (a loaded machine backs off) and its CPU
 * time (a steady stream of changes keeps the roster under 5% of a core: a warm run costs 0.1-0.5 s of CPU).
 */
const GAP_PER_WALL = 10;
const GAP_PER_CPU = 20;

function processCpuMs(): number {
    const { user, system } = process.cpuUsage();
    return (user + system) / 1000;
}

/** Keeps the transcript byte caches alive off the inbox event loop. */
export class WidgetRosterReader {
    rows: AgentSessionRow[] = [];
    agents: AgentsTree = { generatedAt: "", parents: [], orphans: [] };
    loading = true;
    error: string | undefined;
    backfill?: WidgetRoster["backfill"];
    private worker?: RosterWorker;
    private timer?: ReturnType<typeof setTimeout>;
    private pending?: number;
    private sequence = 0;
    private lastAttempt = -Infinity;
    private again = false;
    private stopped = false;
    /** Index scopes requested since the last run started. */
    private readonly waiting = new Set<WidgetRosterScope>();
    /** Their changed transcripts; null once a request asked for the scope's whole listing. */
    private readonly waitingPaths = new Map<WidgetRosterScope, Set<string> | null>();
    private wanted = false;
    /** A requested run must read the roster even when its index refresh changes nothing. */
    private readWanted = false;
    private readonly parents = new Set<string>();
    private fullRead = false;
    private immediate = false;
    private scheduled: (() => void) | undefined;
    private startedAt = 0;
    private cpuAtStart = 0;
    private lastCpu = 0;
    private lastFinish = -Infinity;
    private lastDuration = 0;

    constructor(
        private readonly options: {
            changed: () => void | Promise<void>;
            createWorker?: () => RosterWorker;
            now?: () => number;
            /** CPU milliseconds this process has used; the whole process, since the worker thread does the work. */
            cpuMs?: () => number;
            timeoutMs?: number;
            timer?: RosterTimer;
        }
    ) {}

    private now(): number {
        return this.options.now?.() ?? Date.now();
    }

    /**
     * Shows a roster read earlier (the previous watch's cache) until the first run of this one completes. It does
     * not count as a run: the first read still starts, and its result replaces this one.
     */
    seed(roster: WidgetRoster): void {
        if (this.stopped || this.agents.generatedAt) {
            return;
        }
        this.rows = roster.rows;
        this.agents = roster.agents;
        this.backfill = roster.backfill;
    }

    /** A plain roster read, at most once per 15 s unless forced; a requested run that is already scheduled covers it. */
    refresh(force = false): void {
        if (this.stopped) {
            return;
        }
        if (this.pending !== undefined) {
            this.again ||= force;
            return;
        }
        if (!force && (this.scheduled !== undefined || this.now() - this.lastAttempt < 15_000)) {
            return;
        }
        this.start();
    }

    /**
     * A run caused by a change: refresh these index scopes, then read the roster. Changes coalesce into one run per
     * pause, the pause grows with the cost of the previous run, and a run is never started while another is
     * pending. A run whose refresh changes no index row skips the read unless a request asked for one (`read`, or
     * no scope at all). `immediate` skips the pause (the first full refresh after start-up). `paths` names the
     * transcripts that changed in a scope, so the run refreshes only those; a scope requested without them, by any
     * request of the pause, refreshes its whole listing.
     */
    request(
        scopes: Iterable<WidgetRosterScope>,
        {
            immediate = false,
            read = false,
            paths,
            parentPaths,
        }: {
            immediate?: boolean;
            read?: boolean;
            paths?: ReadonlyMap<WidgetRosterScope, Iterable<string>>;
            parentPaths?: Iterable<string>;
        } = {}
    ): void {
        if (this.stopped) {
            return;
        }
        let any = false;
        for (const scope of scopes) {
            const known = this.waiting.has(scope) ? this.waitingPaths.get(scope) : new Set<string>();
            const changed = paths?.get(scope);
            if (known === null || known === undefined || changed === undefined) {
                this.waitingPaths.set(scope, null);
            } else {
                for (const path of changed) {
                    known.add(path);
                    if (known.size > WIDGET_EXACT_PATHS_LIMIT) {
                        break;
                    }
                }
                this.waitingPaths.set(scope, known.size > WIDGET_EXACT_PATHS_LIMIT ? null : known);
            }
            this.waiting.add(scope);
            any = true;
        }
        this.wanted = true;
        this.readWanted ||= read || !any;
        if (read || !any) {
            this.fullRead ||= !parentPaths;
            if (parentPaths && !this.fullRead) {
                for (const file of parentPaths) {
                    this.parents.add(file);
                    if (this.parents.size > WIDGET_EXACT_PATHS_LIMIT) {
                        this.fullRead = true;
                        break;
                    }
                }
            }
        }
        this.immediate ||= immediate;
        this.schedule();
    }

    private schedule(): void {
        if (this.stopped || !this.wanted || this.pending !== undefined || this.scheduled !== undefined) {
            return;
        }
        const cost = Math.max(MIN_GAP_MS, this.lastDuration * GAP_PER_WALL, this.lastCpu * GAP_PER_CPU);
        const gap = this.immediate ? 0 : Math.min(MAX_GAP_MS, cost);
        const delay = Math.max(SETTLE_MS, this.lastFinish + gap - this.now());
        this.scheduled = (this.options.timer ?? realTimer)(() => {
            this.scheduled = undefined;
            if (!this.stopped && this.pending === undefined) {
                this.start();
            }
        }, delay);
    }

    private start(): void {
        if (this.scheduled !== undefined) {
            this.scheduled();
            this.scheduled = undefined;
        }
        const index = [...this.waiting];
        const onlyIfChanged = index.length > 0 && !this.readWanted && !index.includes("all");
        const paths: Partial<Record<WidgetRosterScope, string[]>> = {};
        for (const [scope, changed] of this.waitingPaths) {
            if (changed && changed.size > 0) {
                paths[scope] = [...changed];
            }
        }
        const withPaths = Object.keys(paths).length > 0 ? { paths } : {};
        const withParents = !this.fullRead && this.parents.size ? { parentPaths: [...this.parents] } : {};
        this.parents.clear();
        this.fullRead = false;
        this.waiting.clear();
        this.waitingPaths.clear();
        this.wanted = false;
        this.readWanted = false;
        this.immediate = false;
        const now = this.now();
        this.lastAttempt = now;
        this.startedAt = now;
        this.cpuAtStart = (this.options.cpuMs ?? processCpuMs)();
        const id = ++this.sequence;
        this.pending = id;
        this.loading = true;
        try {
            if (!this.worker) {
                const worker =
                    this.options.createWorker?.() ?? new Worker(new URL("./roster-worker.ts", import.meta.url));
                this.worker = worker;
                worker.onmessage = (event: MessageEvent<WidgetRosterReply>) => {
                    if (this.stopped || this.worker !== worker || event.data.id !== this.pending) {
                        return;
                    }
                    if (event.data.ok && "page" in event.data) {
                        this.armTimeout();
                        // A complete warm seed stays visible until a complete replacement lands.
                        if (
                            !this.backfill &&
                            (this.rows.length || this.agents.parents.length || this.agents.orphans.length)
                        ) {
                            worker.postMessage({ id: event.data.id, received: true });
                            return;
                        }
                        const { page, revision } = event.data;
                        const resume = this.backfill?.revision === revision;
                        if (page.offset !== (resume ? this.backfill?.cursor : 0)) {
                            this.fail("Missing widget roster page");
                            return;
                        }
                        this.rows =
                            page.rows.length || !resume
                                ? newestRosterRows([...(resume ? this.rows : []), ...page.rows])
                                : this.rows;
                        this.agents =
                            page.agents ??
                            (resume
                                ? this.agents
                                : { generatedAt: new Date().toISOString(), parents: [], orphans: [] });
                        this.backfill = { revision, cursor: page.next };
                        this.error = undefined;
                        const id = event.data.id;
                        void Promise.resolve(this.options.changed())
                            .then(() => {
                                if (!this.stopped && this.worker === worker && id === this.pending) {
                                    worker.postMessage({ id, received: true });
                                }
                            })
                            .catch((error) => {
                                if (!this.stopped && this.worker === worker && id === this.pending) {
                                    this.fail(error instanceof Error ? error.message : String(error));
                                }
                            });
                    } else if (event.data.ok && "unchanged" in event.data) {
                        this.error = undefined;
                        this.finish(false);
                    } else if (event.data.ok) {
                        this.backfill = undefined;
                        this.rows = event.data.rows;
                        this.agents = event.data.agents;
                        this.error = undefined;
                        this.finish();
                    } else {
                        this.fail(event.data.error);
                    }
                };
                worker.onerror = (event) => {
                    if (!this.stopped && this.worker === worker) {
                        this.fail(event.message || "Agent roster worker failed");
                    }
                };
            }
            this.armTimeout();
            const request: WidgetRosterRequest =
                index.length === 0
                    ? { id }
                    : onlyIfChanged
                      ? { id, index, ...withPaths, onlyIfChanged }
                      : { id, index, ...withPaths };
            this.worker.postMessage({ ...request, ...withParents });
        } catch (error) {
            this.fail(error instanceof Error ? error.message : String(error));
        }
    }

    private armTimeout(): void {
        clearTimeout(this.timer);
        this.timer = setTimeout(() => this.fail("Agent roster refresh timed out"), this.options.timeoutMs ?? 120_000);
    }

    stop(): void {
        this.stopped = true;
        clearTimeout(this.timer);
        if (this.scheduled !== undefined) {
            this.scheduled();
            this.scheduled = undefined;
        }
        this.pending = undefined;
        this.worker?.terminate();
        this.worker = undefined;
    }

    private fail(message: string): void {
        this.error = message;
        logger.warn({ error: message }, "Widget roster refresh failed; retaining the last completed roster");
        this.worker?.terminate();
        this.worker = undefined;
        this.finish();
    }

    /** `notify` false: the run found nothing new, so no snapshot is rebuilt for it. */
    private finish(notify = true): void {
        clearTimeout(this.timer);
        this.pending = undefined;
        this.loading = false;
        this.lastFinish = this.now();
        this.lastDuration = this.lastFinish - this.startedAt;
        this.lastCpu = Math.max(0, (this.options.cpuMs ?? processCpuMs)() - this.cpuAtStart);
        if (notify) {
            this.options.changed();
        }
        if (this.again) {
            this.again = false;
            this.refresh(true);
        } else {
            this.schedule();
        }
    }
}
