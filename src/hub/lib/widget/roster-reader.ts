import type { AgentSessionRow } from "@app/ai/lib/sessions/agent-session-rows";
import { logger } from "@genesiscz/utils/logger";
import type { AgentsTree } from "../agents/types";

export type WidgetRosterReply =
    | { id: number; ok: true; rows: AgentSessionRow[]; agents: AgentsTree }
    | { id: number; ok: false; error: string };

type RosterWorker = Pick<Worker, "postMessage" | "terminate" | "onmessage" | "onerror">;

/** Keeps the transcript byte caches alive off the inbox event loop. */
export class WidgetRosterReader {
    rows: AgentSessionRow[] = [];
    agents: AgentsTree = { generatedAt: "", parents: [], orphans: [] };
    loading = true;
    error: string | undefined;
    private worker?: RosterWorker;
    private timer?: ReturnType<typeof setTimeout>;
    private pending?: number;
    private sequence = 0;
    private lastAttempt = -Infinity;
    private again = false;
    private stopped = false;

    constructor(
        private readonly options: {
            changed: () => void;
            createWorker?: () => RosterWorker;
            now?: () => number;
            timeoutMs?: number;
        }
    ) {}

    refresh(force = false): void {
        if (this.stopped) {
            return;
        }
        if (this.pending !== undefined) {
            this.again ||= force;
            return;
        }
        const now = this.options.now?.() ?? Date.now();
        if (!force && now - this.lastAttempt < 15_000) {
            return;
        }
        this.lastAttempt = now;
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
                    if (event.data.ok) {
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
            this.timer = setTimeout(
                () => this.fail("Agent roster refresh timed out"),
                this.options.timeoutMs ?? 120_000
            );
            this.worker.postMessage({ id });
        } catch (error) {
            this.fail(error instanceof Error ? error.message : String(error));
        }
    }

    stop(): void {
        this.stopped = true;
        clearTimeout(this.timer);
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

    private finish(): void {
        clearTimeout(this.timer);
        this.pending = undefined;
        this.loading = false;
        this.options.changed();
        if (this.again) {
            this.again = false;
            this.refresh(true);
        }
    }
}
