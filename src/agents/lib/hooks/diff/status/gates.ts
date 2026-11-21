import { percentile } from "@genesiscz/utils/math";
import type { MetricEventRow, MetricEventsQuery, MetricEventsResult } from "@genesiscz/utils/metrics/types";
import { HARNESS_NAMES } from "../../config";
import { PARITY_CLASSES, type ParityClass, type ParityDifference, STATUS_METRICS } from "./shadow";
import { STATUS_MODE_IDS, type StatusModeId, type StatusPhase } from "./types";

export interface PhaseCost {
    observations: number;
    cpuMs: { p50: number; p90: number };
    wallMs: { p50: number; p90: number; p99: number };
}

export interface ArmReport {
    arm: string;
    mode: StatusModeId;
    /** Distinct hook calls (session and tool call) the arm observed at least once. */
    calls: number;
    /** One per root and boundary: a call over two roots and two boundaries is four. */
    observations: number;
    /** Observations the arm answered itself (outcome `answered`). */
    answered: number;
    /** Observations skipped by the shadow budget; they are no fault of the arm and leave the answered share. */
    skipped: number;
    /** Fallback and skip reasons with their counts. */
    reasons: Record<string, number>;
    parity: Record<ParityClass, number>;
    /** `missing-dirty` at the pre boundary of a writer (need `all`): the class with tolerance zero. */
    missingDirtyAtWriterPre: number;
    /** Confirmed differences other than `missing-dirty` at a writer's pre. */
    otherDifferences: number;
    /** Confirmed differences that no named explainer covers. */
    unexplained: number;
    cpuMs: { p50: number; p90: number };
    wallMs: { p50: number; p90: number; p99: number };
    phases: Record<StatusPhase, PhaseCost>;
    fullStatusPerCall: number;
    /** Calls of each shape with at least one answered observation (a reader's pre asks for deletions only). */
    admitted: { reads: number; writes: number };
    roots: number;
    linkedRoots: number;
    harnesses: string[];
    /** Days between the first and the last observation. */
    days: number;
}

export interface GateCheck {
    /** null: not measured here. */
    value: number | null;
    holds: boolean | null;
}

export interface StatusGate {
    id: string;
    text: string;
    threshold: string;
    check(report: ArmReport): GateCheck;
}

export interface DifferenceGroup {
    arm: string;
    cause: string | null;
    count: number;
    examples: string[];
}

export interface StatusReport {
    arms: ArmReport[];
    differences: DifferenceGroup[];
}

const NOT_MEASURED: GateCheck = { value: null, holds: null };

function atLeast(id: string, text: string, min: number, value: (report: ArmReport) => number): StatusGate {
    return {
        id,
        text,
        threshold: `>= ${min.toLocaleString("en-US")}`,
        check: (report) => {
            const measured = value(report);
            return { value: measured, holds: measured >= min };
        },
    };
}

function atMost(id: string, text: string, max: number, value: (report: ArmReport) => number | null): StatusGate {
    return {
        id,
        text,
        threshold: `<= ${max}`,
        check: (report) => {
            const measured = value(report);
            return measured === null ? NOT_MEASURED : { value: measured, holds: measured <= max };
        },
    };
}

function notMeasured(id: string, text: string, threshold: string): StatusGate {
    return { id, text, threshold, check: () => NOT_MEASURED };
}

function share(part: number, whole: number): number | null {
    return whole === 0 ? null : part / whole;
}

const answeredShare = (report: ArmReport) => share(report.answered, report.observations - report.skipped);

/** The gates of each mode, from that mode's design. Data only: the report prints them and switches nothing. */
export const STATUS_GATES: Record<StatusModeId, readonly StatusGate[]> = {
    git: [],
    snapshot: [
        atLeast("days", "days of shadow data", 7, (report) => report.days),
        atLeast("calls", "hook calls", 20_000, (report) => report.calls),
        atLeast("roots", "roots", 5, (report) => report.roots),
        atLeast("linked-roots", "linked worktree roots", 2, (report) => report.linkedRoots),
        atMost("missing-dirty", "missing-dirty at a writer's pre", 0, (report) => report.missingDirtyAtWriterPre),
        atMost("other-differences", "other confirmed differences per call", 0.0001, (report) =>
            share(report.otherDifferences, report.calls)
        ),
        atMost("unexplained", "confirmed differences without a cause", 0, (report) => report.unexplained),
        {
            id: "answered",
            text: "answered share",
            threshold: ">= 0.95",
            check: (report) => {
                const measured = answeredShare(report);
                return measured === null ? NOT_MEASURED : { value: measured, holds: measured >= 0.95 };
            },
        },
        atMost("fence-timeouts", "fence timeouts per observation", 0.005, (report) =>
            share(report.reasons["fence-timeout"] ?? 0, report.observations)
        ),
        atMost("full-status", "full status runs per call", 0.3, (report) => report.fullStatusPerCall),
        notMeasured("drift", "drift without a cause in the last 3 days (service counters)", "0"),
        notMeasured("cpu", "hook CPU against the git arm (benchmark: status-ab.ts --modes)", "<= 60%"),
    ],
    "narrow-git": [
        atLeast("calls", "hook calls", 10_000, (report) => report.calls),
        atLeast("admitted-reads", "admitted read calls", 1_000, (report) => report.admitted.reads),
        atLeast("admitted-writes", "admitted write calls", 1_000, (report) => report.admitted.writes),
        {
            id: "harnesses",
            text: "harnesses seen",
            threshold: `all ${HARNESS_NAMES.length}`,
            check: (report) => ({
                value: report.harnesses.length,
                holds: HARNESS_NAMES.every((name) => report.harnesses.includes(name)),
            }),
        },
        atMost("missing-dirty", "missing-dirty", 0, (report) => report.parity["missing-dirty"]),
        atMost("unexplained", "confirmed differences without a cause", 0, (report) => report.unexplained),
        notMeasured("cpu", "median hook CPU against the git arm (benchmark: status-ab.ts --modes)", "<= 75%"),
    ],
};

/** A confirmed difference: the arm answered, the reread repeated it, and it is not the same view. */
const CONFIRMED: ReadonlySet<ParityClass> = new Set(
    PARITY_CLASSES.filter((parity) => parity !== "same" && parity !== "none" && parity !== "unconfirmed")
);

function isParity(value: unknown): value is ParityClass {
    return typeof value === "string" && (PARITY_CLASSES as readonly string[]).includes(value);
}

function isMode(value: unknown): value is StatusModeId {
    return typeof value === "string" && (STATUS_MODE_IDS as readonly string[]).includes(value);
}

function text(value: unknown): string | null {
    return typeof value === "string" && value.length > 0 ? value : null;
}

function record(value: unknown): Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value) ? { ...value } : {};
}

function differencesOf(context: Record<string, unknown>): ParityDifference[] {
    const raw = context.differences;

    if (!Array.isArray(raw)) {
        return [];
    }

    return raw.flatMap((item): ParityDifference[] => {
        const fields = record(item);
        const path = text(fields.path);
        return path ? [{ path, reference: text(fields.reference), got: text(fields.got) }] : [];
    });
}

function emptyParity(): Record<ParityClass, number> {
    return {
        same: 0,
        "missing-dirty": 0,
        "missing-other": 0,
        extra: 0,
        letters: 0,
        order: 0,
        head: 0,
        unconfirmed: 0,
        none: 0,
    };
}

function round(value: number | undefined, digits = 1): number {
    if (value === undefined) {
        return 0;
    }

    const scale = 10 ** digits;
    return Math.round(value * scale) / scale;
}

function spread(values: readonly number[]) {
    return {
        p50: round(percentile(values, 0.5)),
        p90: round(percentile(values, 0.9)),
        p99: round(percentile(values, 0.99)),
    };
}

/** One observation of an arm, read from a CPU event; the wall event of the same observation adds only its value. */
interface Observation {
    at: number;
    arm: string;
    mode: StatusModeId;
    phase: StatusPhase;
    need: string;
    outcome: string;
    reason: string | null;
    parity: ParityClass;
    cause: string | null;
    harness: string | null;
    root: string | null;
    linked: boolean;
    call: string | null;
    fullStatus: boolean;
    cpuMs: number;
    differences: ParityDifference[];
}

function observationOf(row: MetricEventRow): Observation | null {
    const { dims } = row;
    const arm = text(dims.arm);
    const phase = dims.phase === "pre" || dims.phase === "post" ? dims.phase : null;

    if (!arm || !phase || !isMode(dims.mode)) {
        return null;
    }

    const context = record(row.context);
    const session = text(context.session);
    const toolUse = text(context.toolUseId);
    return {
        at: row.at,
        arm,
        mode: dims.mode,
        phase,
        need: text(dims.need) ?? "all",
        outcome: text(dims.outcome) ?? "fallback",
        reason: text(dims.reason),
        parity: isParity(dims.parity) ? dims.parity : "none",
        cause: text(dims.cause),
        harness: text(dims.harness),
        root: text(dims.root),
        linked: dims.linked === true || dims.linked === "true",
        call: session || toolUse ? `${session ?? ""}/${toolUse ?? ""}` : null,
        fullStatus: context.fullStatus === true,
        cpuMs: row.value,
        differences: differencesOf(context),
    };
}

function wallKey(dims: MetricEventRow["dims"]): string | null {
    const arm = text(dims.arm);
    const phase = text(dims.phase);
    return arm && phase ? `${arm}\0${phase}` : null;
}

function armReport(arm: string, observations: readonly Observation[], walls: Map<string, number[]>): ArmReport {
    const first = observations[0];
    const calls = new Set<string>();
    const roots = new Set<string>();
    const linkedRoots = new Set<string>();
    const harnesses = new Set<string>();
    const reads = new Set<string>();
    const writes = new Set<string>();
    const reasons: Record<string, number> = {};
    const parity = emptyParity();
    let answered = 0;
    let skipped = 0;
    let fullStatus = 0;
    let missingDirtyAtWriterPre = 0;
    let otherDifferences = 0;
    let unexplained = 0;

    for (const observation of observations) {
        const call = observation.call ?? `${observation.at}`;
        calls.add(call);
        parity[observation.parity] += 1;
        fullStatus += observation.fullStatus ? 1 : 0;

        if (observation.root) {
            roots.add(observation.root);

            if (observation.linked) {
                linkedRoots.add(observation.root);
            }
        }

        if (observation.harness) {
            harnesses.add(observation.harness);
        }

        if (observation.outcome === "answered") {
            answered += 1;

            if (observation.phase === "pre") {
                (observation.need === "deletions" ? reads : writes).add(call);
            }
        } else {
            skipped += observation.outcome === "skipped" ? 1 : 0;
            const reason = observation.reason ?? "unknown";
            reasons[reason] = (reasons[reason] ?? 0) + 1;
        }

        if (!CONFIRMED.has(observation.parity)) {
            continue;
        }

        const writerPre = observation.phase === "pre" && observation.need === "all";

        if (observation.parity === "missing-dirty" && writerPre) {
            missingDirtyAtWriterPre += 1;
        } else {
            otherDifferences += 1;
        }

        unexplained += observation.cause === null ? 1 : 0;
    }

    const phaseCost = (phase: StatusPhase): PhaseCost => {
        const own = observations.filter((observation) => observation.phase === phase);
        const cpu = spread(own.map((observation) => observation.cpuMs));
        return {
            observations: own.length,
            cpuMs: { p50: cpu.p50, p90: cpu.p90 },
            wallMs: spread(walls.get(`${arm}\0${phase}`) ?? []),
        };
    };
    const cpu = spread(observations.map((observation) => observation.cpuMs));
    const ats = observations.map((observation) => observation.at);

    return {
        arm,
        mode: first?.mode ?? "git",
        calls: calls.size,
        observations: observations.length,
        answered,
        skipped,
        reasons,
        parity,
        missingDirtyAtWriterPre,
        otherDifferences,
        unexplained,
        cpuMs: { p50: cpu.p50, p90: cpu.p90 },
        wallMs: spread([...(walls.get(`${arm}\0pre`) ?? []), ...(walls.get(`${arm}\0post`) ?? [])]),
        phases: { pre: phaseCost("pre"), post: phaseCost("post") },
        fullStatusPerCall: calls.size === 0 ? 0 : round(fullStatus / calls.size, 3),
        admitted: { reads: reads.size, writes: writes.size },
        roots: roots.size,
        linkedRoots: linkedRoots.size,
        harnesses: [...harnesses].sort(),
        days: ats.length === 0 ? 0 : round((Math.max(...ats) - Math.min(...ats)) / 86_400_000, 2),
    };
}

/**
 * The report from recorded events: the CPU events (with their context) and the wall events of the two status metrics.
 * Pure, so a test can build it from fixture rows. The reference arm is in it too; its parity is all `none`.
 */
export function reportFromEvents(events: {
    cpu: readonly MetricEventRow[];
    wall: readonly MetricEventRow[];
}): StatusReport {
    const byArm = new Map<string, Observation[]>();

    for (const row of events.cpu) {
        const observation = observationOf(row);

        if (observation) {
            const list = byArm.get(observation.arm) ?? [];
            list.push(observation);
            byArm.set(observation.arm, list);
        }
    }

    const walls = new Map<string, number[]>();

    for (const row of events.wall) {
        const key = wallKey(row.dims);

        if (key) {
            const list = walls.get(key) ?? [];
            list.push(row.value);
            walls.set(key, list);
        }
    }

    const arms = [...byArm].map(([arm, observations]) => armReport(arm, observations, walls));
    const groups = new Map<string, DifferenceGroup>();

    for (const [arm, observations] of byArm) {
        for (const observation of observations) {
            if (!CONFIRMED.has(observation.parity)) {
                continue;
            }

            const key = `${arm}\0${observation.cause ?? ""}`;
            const group = groups.get(key) ?? { arm, cause: observation.cause, count: 0, examples: [] };
            group.count += 1;

            for (const difference of observation.differences) {
                if (group.examples.length < 3 && !group.examples.includes(difference.path)) {
                    group.examples.push(difference.path);
                }
            }

            groups.set(key, group);
        }
    }

    const differences = [...groups.values()].sort(
        (a, b) => Number(a.cause !== null) - Number(b.cause !== null) || b.count - a.count
    );
    arms.sort((a, b) => a.arm.localeCompare(b.arm));
    return { arms, differences };
}

/** One page of events, newest first, as `tools metrics events` reads them. */
export type StatusEventReader = (query: MetricEventsQuery) => Promise<MetricEventsResult>;

const PAGE = 10_000;

async function allEvents(
    read: StatusEventReader,
    metric: string,
    window: { since: number; until?: number }
): Promise<MetricEventRow[]> {
    const rows = new Map<number, MetricEventRow>();
    let until = window.until;

    for (;;) {
        const page = await read({
            project: STATUS_METRICS.project,
            metric,
            since: window.since,
            ...(until === undefined ? {} : { until }),
            limit: PAGE,
        });
        const before = rows.size;

        for (const row of page.rows) {
            rows.set(row.id, row);
        }

        const oldest = page.rows.at(-1);

        if (page.rows.length < PAGE || !oldest || rows.size === before) {
            break;
        }

        // `until` is exclusive: one ms past the oldest row keeps the rows that share its time; the id set drops repeats.
        until = oldest.at + 1;
    }

    return [...rows.values()];
}

/**
 * The report over a time window, read from the metrics store through the same `events` call as `tools metrics events`.
 * It reads only: it changes no config and switches no mode.
 */
export async function buildStatusReport(options: {
    since: number;
    until?: number;
    read?: StatusEventReader;
}): Promise<StatusReport> {
    const reader = options.read ? { read: options.read, close: () => {} } : await defaultEventReader();
    const window = { since: options.since, ...(options.until === undefined ? {} : { until: options.until }) };

    try {
        const cpu = await allEvents(reader.read, STATUS_METRICS.cpu, window);
        const wall = await allEvents(reader.read, STATUS_METRICS.wall, window);
        return reportFromEvents({ cpu, wall });
    } finally {
        reader.close();
    }
}

/**
 * The running metrics service when there is one, else the store file opened read-only. Neither starts the service or
 * drains the spool, so events still in the spool of a stopped service are not in the report yet.
 */
async function defaultEventReader(): Promise<{ read: StatusEventReader; close(): void }> {
    const [{ openMetricsService }, { MetricsStore }, { metricsDbPath }] = await Promise.all([
        import("@genesiscz/utils/metrics/service-client"),
        import("@genesiscz/utils/metrics/store"),
        import("@genesiscz/utils/metrics/spool"),
    ]);
    const opened = await openMetricsService({ start: false });

    if (opened.status === "connected") {
        const client = opened.client;
        return { read: (query) => client.call("events", query), close: () => client.close() };
    }

    const store = MetricsStore.openReadOnly(metricsDbPath());
    return {
        read: async (query) =>
            store ? store.events(query) : { project: query.project, metric: query.metric, known: false, rows: [] },
        close: () => store?.close(),
    };
}

export interface GateRow {
    id: string;
    text: string;
    threshold: string;
    value: number | null;
    holds: boolean | null;
}

/** The gate rows of an arm's mode with their measured values; an empty list for the `git` reference. */
export function gateRows(report: ArmReport): GateRow[] {
    return STATUS_GATES[report.mode].map((gate) => ({
        id: gate.id,
        text: gate.text,
        threshold: gate.threshold,
        ...gate.check(report),
    }));
}
