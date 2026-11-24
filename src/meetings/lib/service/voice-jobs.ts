import { randomUUID } from "node:crypto";
import { KeyedRerun } from "@genesiscz/utils/async";
import { JobRegistry } from "@genesiscz/utils/jobs";
import { logger } from "@genesiscz/utils/logger";
import { MeetingsConfigStore } from "@genesiscz/utils/meetings/config";
import type { MeetingRecord } from "@genesiscz/utils/meetings/record";
import type { SampleId } from "@genesiscz/utils/meetings/voice-library";
import { PathLockBusyError, waitForPathArbitration } from "@genesiscz/utils/storage/file-lock";
import { DecisionJournal } from "../decision-journal";
import { recordPeople } from "../listen-answers";
import { errorText } from "../shared";
import { StaleSuggestionError } from "../suggest";
import { type BackfillRow, backfillRecords, type LearningRun, learnMeetingVoices } from "../voice-backfill";
import { answeredVoiceTargets } from "../voice-samples";
import { applyVoices, type VoicesAccess } from "../voices";
import type { VoiceJob, VoicesParams } from "./api";

const { log } = logger.scoped("meetings-voice-jobs");
const LIBRARY_LOCK_WAIT_MS = 5_000;

interface Options extends VoicesAccess {
    notify: (job: VoiceJob) => void;
    named?: (meeting: string) => void;
    nameMeeting?: typeof applyVoices;
}

interface Run {
    row: VoiceJob;
    controller: AbortController;
    suppressRetry?: () => void;
}

/** One queue per service. The journal survives the process and tells its successor what a human actually decided. */
export class MeetingVoiceJobs {
    private readonly registry = new JobRegistry();
    private readonly runs = new Map<string, Run>();
    private readonly seen = new Map<string, Map<string, string>>();
    private readonly cancelledTokens = new Map<string, Set<string>>();
    /** One naming pass per meeting: `reproposeDelaySec` after its last new sample, and one more after a pass that a
     * newer sample or a newer record write overtook. */
    private readonly naming = new KeyedRerun<string>({
        run: (meeting, started) => this.nameAgain(meeting, started),
        onError: (meeting, error) => log.debug({ error, meeting }, "voice naming job ended"),
    });
    private readonly namingFor = new Map<string, { project: string; delaySec: number }>();
    private tail: Promise<void> = Promise.resolve();
    private closed = false;

    constructor(private readonly options: Options) {}

    list(project?: string): VoiceJob[] {
        return [...this.runs.values()]
            .filter(({ row }) => !project || project === row.project)
            .map(({ row }) => structuredClone(row));
    }

    get busy(): boolean {
        return (
            this.naming.busy ||
            [...this.runs.values()].some(({ row }) => row.state === "queued" || row.state === "running")
        );
    }

    cancel(id: string): VoiceJob | null {
        const run = this.runs.get(id);
        if (!run) {
            return null;
        }
        if (run.row.state === "queued" || run.row.state === "running") {
            run.suppressRetry?.();
            run.controller.abort(new Error("Voice job cancelled"));
            this.update(run, { state: "cancelled" });
        }
        return structuredClone(run.row);
    }

    stop(): void {
        this.closed = true;
        this.naming.stop();
        for (const id of this.runs.keys()) {
            this.cancel(id);
        }
    }

    discover(
        record: MeetingRecord,
        kind: VoiceJob["kind"] = "backfill",
        token?: string
    ): Promise<BackfillRow[]> | undefined {
        const { project } = record;
        if (!project || this.closed) {
            return;
        }
        const active = new Map(
            record.items
                .filter(
                    (item) =>
                        item.status === "confirmed" &&
                        item.decision?.token &&
                        (item.kind === "speaker-range" || (item.kind === "question" && item.about === "speaker"))
                )
                .map((item) => [item.id, item.decision!.token])
        );
        const key = `${record.id}\0${project}`;
        const seen = this.seen.get(key) ?? new Map<string, string>();
        for (const [item, t] of seen) {
            if (active.get(item) !== t) {
                seen.delete(item);
            }
        }
        const outstanding = new Set(
            [...active]
                .filter(
                    ([item, t]) =>
                        (!token || t === token) && seen.get(item) !== t && !this.cancelledTokens.get(key)?.has(t)
                )
                .map(([, t]) => t)
        );
        if (!outstanding.size) {
            return;
        }
        const people = recordPeople(record);
        const entries = new DecisionJournal({ store: this.options.store }).read(record.id);
        const tokens = new Set(
            entries
                .filter(
                    (entry) =>
                        outstanding.has(entry.token) &&
                        answeredVoiceTargets(entry, people).some(({ voice }) => active.get(voice.item) === entry.token)
                )
                .map((entry) => entry.token)
        );
        for (const [item, t] of active) {
            if (outstanding.has(t)) {
                seen.set(item, t);
            }
        }
        this.seen.set(key, seen);
        if (tokens.size) {
            return this.learn({ record, project, kind, tokens });
        }
    }

    async backfill(params: VoicesParams<"voice.backfill">) {
        const selected = backfillRecords({ ...this.options, ...params });
        const groups = await Promise.all(
            selected.map(({ record, project }) => this.learn({ record, project, kind: "backfill" }))
        );
        const rows = groups.flat();
        return {
            dryRun: false,
            rows,
            added: rows.reduce((sum, r) => sum + r.added, 0),
            present: rows.reduce((sum, r) => sum + r.present, 0),
        };
    }

    private learn(input: { record: MeetingRecord; project: string; kind: VoiceJob["kind"]; tokens?: Set<string> }) {
        const { record, project, kind, tokens } = input;
        const suppressRetry = () => {
            const key = `${record.id}\0${project}`;
            const cancelled = this.cancelledTokens.get(key) ?? new Set<string>();
            for (const token of tokens ?? record.items.flatMap((i) => (i.decision ? [i.decision.token] : []))) {
                cancelled.add(token);
            }
            this.cancelledTokens.set(key, cancelled);
        };
        return this.enqueue(
            { project, meeting: record.id, kind, step: "Learning confirmed lines", suppressRetry },
            async (run) => {
                const job: LearningRun = {
                    sourceAtEnqueue: record,
                    tokens,
                    signal: run.controller.signal,
                    acquiredBy: kind === "backfill" ? "backfill" : "live",
                    progress: ({ added, skipped, ...progress }) => this.update(run, { added, skipped, progress }),
                    publishWhenFree: (publish) => this.publishWhenFree(run, publish),
                };
                // Undo may have retired some units before this job reached the head of the queue.
                const current = this.options.store.read(record.id);
                if (!current || current.project !== project) {
                    throw new Error("Meeting project changed before voice learning started");
                }
                const rows = await learnMeetingVoices({
                    access: this.options,
                    record: current,
                    project,
                    dryRun: false,
                    job,
                });
                const reasons = new Map<string, number>();
                for (const row of rows) {
                    for (const [reason, count] of Object.entries(row.skipped)) {
                        reasons.set(reason, (reasons.get(reason) ?? 0) + count);
                    }
                }
                if (reasons.size) {
                    this.update(run, {
                        progress: {
                            ...run.row.progress,
                            step: [...reasons].map(([why, count]) => `${count} × ${why}`).join(", "),
                        },
                    });
                }
                const journal = new DecisionJournal({ store: this.options.store });
                const pending =
                    !this.closed && (run.row.added || kind === "backfill")
                        ? journal.pendingNaming(record.id, project)
                        : [];
                if (pending.length) {
                    const config = await (this.options.config?.() ??
                        new MeetingsConfigStore(this.options.store.storage).read());
                    this.scheduleNaming(record.id, project, config.meetings.voices.reproposeDelaySec);
                }
                return rows;
            }
        );
    }

    private async publishWhenFree(run: Run, publish: () => Promise<BackfillRow[]>): Promise<BackfillRow[]> {
        let wait: AbortSignal | undefined;
        const { signal } = run.controller;
        for (;;) {
            signal.throwIfAborted();
            try {
                return await publish();
            } catch (error) {
                if (!(error instanceof PathLockBusyError)) {
                    throw error;
                }
                wait ??= AbortSignal.any([signal, AbortSignal.timeout(LIBRARY_LOCK_WAIT_MS)]);
                this.update(run, { progress: { ...run.row.progress, step: "Waiting for the voice library" } });
                if (!(await waitForPathArbitration(error.targetPath, wait))) {
                    signal.throwIfAborted();
                    const message =
                        "Voice library lock timed out. Learning remains pending for the next service start.";
                    log.warn(
                        { meeting: run.row.meeting, path: error.targetPath, waitMs: LIBRARY_LOCK_WAIT_MS },
                        message
                    );
                    throw new Error(message, { cause: error });
                }
                // The meeting lock was released before the wait. Recheck the decision and source before publication.
            }
        }
    }

    private scheduleNaming(meeting: string, project: string, delaySec: number): void {
        if (this.closed) {
            return;
        }
        this.namingFor.set(meeting, { project, delaySec });
        this.naming.trigger(meeting, delaySec * 1000);
    }

    /**
     * One naming job on the service's queue. It reads the samples still waiting for a pass when it starts, so the
     * samples learned while it waited in the queue are its own. A pass that newer record writes overtook every time it
     * tried (`StaleSuggestionError`) asks for one more pass; its samples stay waiting until a pass finishes.
     */
    private nameAgain(meeting: string, started: () => void): Promise<void> {
        const scope = this.namingFor.get(meeting);
        if (!scope || this.closed) {
            return Promise.resolve();
        }
        const { project, delaySec } = scope;
        const journal = new DecisionJournal({ store: this.options.store });
        let ids: SampleId[] = [];
        const starting = () => {
            started();
            ids = journal.pendingNaming(meeting, project);
            return `Naming again with ${ids.length} new samples`;
        };
        return this.enqueue(
            { meeting, project, kind: "answer-samples", step: "Naming again", starting },
            async (run) => {
                if (this.options.store.read(meeting)?.project !== project) {
                    return;
                }
                let named: Awaited<ReturnType<typeof applyVoices>>;
                try {
                    named = await (this.options.nameMeeting ?? applyVoices)({
                        ...this.options,
                        meeting,
                        signal: run.controller.signal,
                    });
                } catch (error) {
                    if (error instanceof StaleSuggestionError) {
                        this.scheduleNaming(meeting, project, delaySec);
                    }
                    throw error;
                }
                log.info(
                    { meeting, samples: ids.length, added: named.added, warnings: named.warnings },
                    "voice naming pass after new samples"
                );
                if (named.warnings.length) {
                    this.update(run, { warnings: named.warnings });
                }
                await journal.finishNaming(meeting, project, ids);
                this.options.named?.(meeting);
            }
        );
    }

    private update(run: Run, change: Partial<VoiceJob>): void {
        if (run.row.state === "cancelled") {
            return;
        }
        Object.assign(run.row, change);
        this.options.notify(structuredClone(run.row));
    }

    private enqueue<T>(
        {
            step,
            suppressRetry,
            starting,
            ...scope
        }: {
            kind: VoiceJob["kind"];
            project: string;
            meeting: string;
            step: string;
            suppressRetry?: () => void;
            /** Runs when the job leaves the queue; its answer is the step shown while it runs. */
            starting?: () => string;
        },
        work: (run: Run) => Promise<T>
    ): Promise<T> {
        const id = randomUUID();
        const row: VoiceJob = {
            ...scope,
            id,
            state: "queued",
            progress: { done: 0, total: 0, step },
            added: 0,
            skipped: 0,
        };
        const run = { row, controller: new AbortController(), suppressRetry };
        this.runs.set(id, run);
        this.update(run, {});
        const done = this.tail.then(async () => {
            run.controller.signal.throwIfAborted();
            const runningStep = starting?.();
            this.update(run, {
                state: "running",
                ...(runningStep ? { progress: { ...run.row.progress, step: runningStep } } : {}),
            });
            const job = this.registry.run<T | undefined>({
                id,
                kind: row.kind,
                signal: run.controller.signal,
                initial: undefined,
                steps: [{ name: step, run: () => work(run) }],
            });
            try {
                const result = await job.done;
                this.update(run, { state: "done" });
                return result.state as T;
            } catch (error) {
                this.update(run, { state: "failed", error: errorText(error) });
                throw error;
            }
        });
        this.tail = done
            .then(
                () => {},
                () => {}
            )
            .then(() => {
                const finished = [...this.runs.values()].filter(
                    ({ row }) => row.state !== "running" && row.state !== "queued"
                );
                for (const old of finished.slice(0, -50)) {
                    this.runs.delete(old.row.id);
                }
            });
        return done;
    }
}
