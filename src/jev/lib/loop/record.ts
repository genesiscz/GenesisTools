import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Candidate, Observation } from "@app/control/lib/decision/observation";
import { type ObserveFanout, observeFanout } from "@app/control/lib/decision/observe";
import type { EvaluationResponse, Evaluator } from "@genesiscz/utils/ai/evaluation/service";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { Stopwatch } from "@genesiscz/utils/Stopwatch";
import { Storage } from "@genesiscz/utils/storage";

const { log } = logger.scoped("jev-runs");

/** Run folders kept; older ones are pruned when a new run starts. */
const KEPT_RUNS = 30;
const STEP_FILE = /^step-(\d{3})\.json$/;

export interface CallMeter {
    calls: number;
    failures: number;
    ms: number;
    inputTokens: number;
    outputTokens: number;
}

export interface RecordedCall {
    /** The exact `{ state, questions }` sent to Jev. */
    request: unknown;
    response?: EvaluationResponse;
    error?: string;
    ms: number;
}

/**
 * Times and counts every Jev call, and keeps the calls of the current step so a run folder can
 * store the exact wire payload. Ported from typesafe-computer-use `calls.py`: the classifier's
 * share of a run becomes a number the run prints, not a claim.
 */
export class MeteredEvaluator {
    readonly meter: CallMeter = { calls: 0, failures: 0, ms: 0, inputTokens: 0, outputTokens: 0 };
    private pending: RecordedCall[] = [];

    constructor(private readonly inner: Evaluator) {}

    readonly evaluate: Evaluator = async (call) => {
        const clock = new Stopwatch();
        try {
            const response = await this.inner(call);
            const ms = Math.round(clock.elapsedMs);
            this.meter.calls += 1;
            this.meter.ms += ms;
            this.meter.inputTokens += response.usage?.inputTokens ?? 0;
            this.meter.outputTokens += response.usage?.outputTokens ?? 0;
            this.pending.push({ request: call.input, response, ms });
            return response;
        } catch (error) {
            const ms = Math.round(clock.elapsedMs);
            this.meter.calls += 1;
            this.meter.failures += 1;
            this.meter.ms += ms;
            this.pending.push({
                request: call.input,
                error: error instanceof Error ? error.message : String(error),
                ms,
            });
            throw error;
        }
    };

    /** The calls made since the last drain. */
    drain(): RecordedCall[] {
        const calls = this.pending;
        this.pending = [];
        return calls;
    }
}

export interface StepTiming {
    seeMs: number;
    decideMs: number;
    actMs?: number;
}

/** Everything a step decided on, so the decision can be rebuilt offline without a model call. */
export interface StepRecord {
    step: number;
    snapshot: { id: string; label: string };
    input: {
        goal: string;
        observation: Observation;
        candidates: Candidate[];
        evidence: unknown;
        triedHere: string[];
        allowYes: boolean;
    };
    calls: RecordedCall[];
    decision: Omit<ObserveFanout, "target" | "evaluation"> & { target: string | null };
    act?: { target: string; ok: boolean; error?: string };
    timing: StepTiming;
}

export interface RunSummary {
    goal: string;
    surface: string;
    startedAt: string;
    finishedAt: string;
    status: string;
    reason: string;
    steps: number;
    calls: CallMeter;
    timing: Record<keyof StepTiming, { mean: number; max: number }>;
}

function slug(text: string): string {
    return (
        text
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-|-$/g, "")
            .slice(0, 40) || "run"
    );
}

export function defaultRunsRoot(): string {
    return join(new Storage("jev").getBaseDir(), "runs");
}

/**
 * One goal run on disk: `step-NNN.json` per step (inputs, exact requests, every probability,
 * decision, act, timing) and `run.json` at the end. Ported from typesafe-computer-use's run
 * folder, so a stall can be replayed and fixed offline (`tools jev replay <dir>`). Input values the
 * caller supplied never reach it: they are not part of any Jev request.
 */
export class RunFolder {
    private readonly timings: StepTiming[] = [];
    private readonly startedAt = new Date();

    private constructor(
        readonly dir: string,
        private readonly goal: string,
        private readonly surface: string
    ) {}

    static create(options: { goal: string; surface: string; root?: string }): RunFolder {
        const root = options.root ?? defaultRunsRoot();
        mkdirSync(root, { recursive: true, mode: 0o700 });
        pruneRuns(root);
        const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
        const dir = join(root, `${stamp}-${process.pid}-${slug(options.goal)}`);
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        log.info({ dir }, "goal run folder");
        return new RunFolder(dir, options.goal, options.surface);
    }

    /** Synchronous, so a step is on disk before the next act runs: a crash keeps every finished step. */
    writeStep(record: StepRecord): void {
        this.timings.push(record.timing);
        const file = join(this.dir, `step-${String(record.step).padStart(3, "0")}.json`);
        try {
            writeFileSync(file, `${SafeJSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
        } catch (error) {
            log.warn({ error, file }, "could not write a run step");
        }
    }

    async finish(result: { status: string; reason: string; steps: number; calls: CallMeter }): Promise<void> {
        const summary: RunSummary = {
            goal: this.goal,
            surface: this.surface,
            startedAt: this.startedAt.toISOString(),
            finishedAt: new Date().toISOString(),
            ...result,
            timing: {
                seeMs: stats(this.timings.map((timing) => timing.seeMs)),
                decideMs: stats(this.timings.map((timing) => timing.decideMs)),
                actMs: stats(this.timings.flatMap((timing) => (timing.actMs === undefined ? [] : [timing.actMs]))),
            },
        };
        writeFileSync(join(this.dir, "run.json"), `${SafeJSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
    }
}

function stats(values: number[]): { mean: number; max: number } {
    if (values.length === 0) {
        return { mean: 0, max: 0 };
    }

    return {
        mean: Math.round(values.reduce((total, value) => total + value, 0) / values.length),
        max: Math.max(...values),
    };
}

/** Removes the oldest run folders past the kept count. Only folders this module wrote are touched. */
function pruneRuns(root: string): void {
    const runs = readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && /^\d{8}-\d{6}-\d+-/.test(entry.name))
        .map((entry) => entry.name)
        .sort();
    for (const name of runs.slice(0, Math.max(0, runs.length - (KEPT_RUNS - 1)))) {
        const dir = join(root, name);
        const ours = readdirSync(dir).every((file) => file === "run.json" || STEP_FILE.test(file));
        if (!ours) {
            log.warn({ dir }, "not pruning a run folder that holds files this tool did not write");
            continue;
        }

        rmSync(dir, { recursive: true, force: true });
        log.debug({ dir }, "pruned an old goal run folder");
    }
}

export interface ReplayedStep {
    step: number;
    requestsMatch: boolean;
    decisionMatch: boolean;
    saved: string;
    replayed: string;
}

/**
 * Rebuilds every recorded step's decision with the CURRENT decision code and the SAVED answers, so
 * no model is called. A step whose requests differ means the prompt code changed since the run; a
 * step whose decision differs means the gate or the branching changed. Both are findings.
 */
export async function replayRun(dir: string, options: { step?: number } = {}): Promise<ReplayedStep[]> {
    if (!existsSync(dir)) {
        throw new Error(`No run folder at ${dir}.`);
    }

    const files = readdirSync(dir)
        .filter((file) => STEP_FILE.test(file))
        .sort()
        .filter((file) => options.step === undefined || Number(STEP_FILE.exec(file)?.[1]) === options.step);
    const replayed: ReplayedStep[] = [];
    for (const file of files) {
        const saved = SafeJSON.parse(await Bun.file(join(dir, file)).text(), { strict: true }) as StepRecord;
        const answers = saved.calls.flatMap((call) => (call.response ? [call.response] : []));
        const requests: unknown[] = [];
        const evaluate: Evaluator = async (call) => {
            requests.push(call.input);
            const next = answers.shift();
            if (!next) {
                throw new Error(`step ${saved.step}: the replay asked more questions than the run recorded`);
            }

            return next;
        };
        const fanout = await observeFanout({
            observation: saved.input.observation,
            candidates: saved.input.candidates,
            evidence: saved.input.evidence,
            goal: saved.input.goal,
            triedHere: saved.input.triedHere,
            allowYes: saved.input.allowYes,
            evaluate,
        });
        const decision = summarizeDecision(fanout);
        const wire = (value: unknown) => SafeJSON.stringify(value, { strict: true });
        replayed.push({
            step: saved.step,
            requestsMatch: wire(requests) === wire(saved.calls.map((call) => call.request)),
            decisionMatch: wire(decision) === wire(saved.decision),
            saved: `${saved.decision.status}:${saved.decision.reason}:${saved.decision.target ?? "-"}`,
            replayed: `${decision.status}:${decision.reason}:${decision.target ?? "-"}`,
        });
    }

    return replayed;
}

export function summarizeDecision(fanout: ObserveFanout): StepRecord["decision"] {
    return {
        status: fanout.status,
        reason: fanout.reason,
        target: fanout.target?.id ?? null,
        verb: fanout.verb,
        done: fanout.done,
        blocked: fanout.blocked,
        wait: fanout.wait,
        risk: fanout.risk,
    };
}
