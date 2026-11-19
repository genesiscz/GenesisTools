import { createHash } from "node:crypto";
import type { StatusEntry } from "@genesiscz/utils/git/porcelain";
import { SafeJSON } from "@genesiscz/utils/json";
import type { MetricsRecorder } from "@genesiscz/utils/metrics";
import { appendSpoolLines } from "@genesiscz/utils/metrics/spool";
import type { StatusCall } from "./prepare";
import type { StatusAnswer, StatusArm, StatusNeed, StatusPhase, StatusRequest, StatusView } from "./types";

export const PARITY_CLASSES = [
    "same",
    "missing-dirty",
    "missing-other",
    "extra",
    "letters",
    "order",
    "head",
    "unconfirmed",
    "none",
] as const;
export type ParityClass = (typeof PARITY_CLASSES)[number];

/** One path the two views disagree on. `reference` and `got` are the two letters ("M."), null when absent. */
export interface ParityDifference {
    path: string;
    reference: string | null;
    got: string | null;
}

export interface Parity {
    parity: ParityClass;
    differences: ParityDifference[];
    cause: string | null;
}

/** The metrics project and the two metrics of the shadow record. */
export const STATUS_METRICS = {
    project: "agent-context",
    cpu: "hook.status.cpu_ms",
    wall: "hook.status.wall_ms",
} as const;

export const STATUS_METRIC_DIMS = [
    "arm",
    "mode",
    "role",
    "phase",
    "need",
    "outcome",
    "reason",
    "source",
    "parity",
    "cause",
    "harness",
    "root",
    "linked",
] as const;

const MAX_RECORDED_DIFFERENCES = 50;
let defined = false;

/** Declares the two metrics with spool `define` lines, once per process, so their dims get an index. */
export function defineStatusMetrics(writer = "agents-hooks"): void {
    if (defined) {
        return;
    }

    defined = true;
    const define = (metric: string, description: string) => {
        const line = SafeJSON.stringify({
            v: 1,
            define: { project: STATUS_METRICS.project, metric, unit: "ms", description, dims: [...STATUS_METRIC_DIMS] },
        });
        return `${line}\n`;
    };

    try {
        appendSpoolLines({
            writer,
            lines: [
                define(STATUS_METRICS.cpu, "CPU of one status arm at one hook boundary, per root"),
                define(STATUS_METRICS.wall, "Wall time of one status arm at one hook boundary, per root"),
            ],
        });
    } catch {
        // A metric declaration must never stop a command; the events still carry their dims.
    }
}

function letters(entry: StatusEntry): string {
    return `${entry.index}${entry.worktree}`;
}

function isDeletion(entry: StatusEntry): boolean {
    return entry.worktree === "D" || entry.index === "D";
}

/** A tracked entry: what the hook captures and diffs. An untracked or ignored path is "other". */
function isTracked(entry: StatusEntry): boolean {
    return entry.kind === "changed" || entry.kind === "renamed" || entry.kind === "unmerged";
}

/**
 * Named explainers of a difference, first match wins. Each one says why a disagreement is expected, so the report can
 * list the unexplained ones first.
 */
const CAUSES: ReadonlyArray<{ id: string; explains(differences: readonly ParityDifference[]): boolean }> = [
    {
        id: "watchman-cookie",
        explains: (differences) => differences.every((difference) => difference.path.includes(".watchman-cookie-")),
    },
    {
        id: "untracked-collapse",
        explains: (differences) =>
            differences.every((difference) =>
                differences.some(
                    (other) =>
                        other !== difference &&
                        ((other.path.endsWith("/") && difference.path.startsWith(other.path)) ||
                            (difference.path.endsWith("/") && other.path.startsWith(difference.path)))
                )
            ),
    },
];

function causeOf(differences: readonly ParityDifference[]): string | null {
    if (differences.length === 0) {
        return null;
    }

    return CAUSES.find((cause) => cause.explains(differences))?.id ?? null;
}

/** How an arm's view differs from the reference at the same boundary and need. */
export function compareToReference(options: {
    need: StatusNeed;
    phase: StatusPhase;
    reference: StatusView;
    got: StatusView;
}): Parity {
    const keep = (entries: readonly StatusEntry[]) =>
        options.need === "deletions" ? entries.filter(isDeletion) : [...entries];
    const reference = keep(options.reference.entries);
    const got = keep(options.got.entries);
    const gotByPath = new Map(got.map((entry) => [entry.path, entry]));
    const referenceByPath = new Map(reference.map((entry) => [entry.path, entry]));
    const differences: ParityDifference[] = [];
    let missingTracked = false;
    let missingOther = false;
    let extra = false;
    let changedLetters = false;

    for (const entry of reference) {
        const other = gotByPath.get(entry.path);

        if (!other) {
            differences.push({ path: entry.path, reference: letters(entry), got: null });
            missingTracked ||= isTracked(entry);
            missingOther ||= !isTracked(entry);
        } else if (letters(other) !== letters(entry)) {
            differences.push({ path: entry.path, reference: letters(entry), got: letters(other) });
            changedLetters = true;
        }
    }

    for (const entry of got) {
        if (!referenceByPath.has(entry.path)) {
            differences.push({ path: entry.path, reference: null, got: letters(entry) });
            extra = true;
        }
    }

    const cause = causeOf(differences);
    const headDiffers =
        options.reference.head !== null && options.got.head !== null && options.reference.head !== options.got.head;
    const parity: ParityClass = missingTracked
        ? "missing-dirty"
        : missingOther
          ? "missing-other"
          : extra
            ? "extra"
            : changedLetters
              ? "letters"
              : headDiffers
                ? "head"
                : reference.map((entry) => entry.path).join("\0") !== got.map((entry) => entry.path).join("\0")
                  ? "order"
                  : "same";

    return { parity, differences, cause };
}

/** A short, stable hash of a root path: the dim names the root without writing the path into the store. */
function rootHash(root: string): string {
    return createHash("sha256").update(root).digest("hex").slice(0, 10);
}

/** The digest of a view, so two records of the same state can be matched without the entries. */
function viewDigest(answer: StatusAnswer): string | null {
    if (answer.state !== "ok") {
        return null;
    }

    const text = answer.view.entries.map((entry) => `${letters(entry)} ${entry.path}`).join("\n");
    return createHash("sha256")
        .update(`${answer.view.head ?? ""}\n${text}`)
        .digest("hex")
        .slice(0, 16);
}

function outcomeOf(answer: StatusAnswer): "answered" | "fallback" | "skipped" {
    if (answer.state === "ok") {
        return "answered";
    }

    return answer.reason === "budget" ? "skipped" : "fallback";
}

/** One CPU and one wall event for an arm, a root and a boundary. Never throws: a metric must not stop a command. */
export function recordArm(options: {
    recorder: MetricsRecorder;
    call: StatusCall;
    request: StatusRequest;
    arm: StatusArm;
    role: "active" | "shadow" | "reference";
    answer: StatusAnswer;
    parity: Parity | null;
    linked: boolean;
}): void {
    const { recorder, call, request, arm, answer, parity } = options;
    const dims = {
        arm: arm.id,
        mode: arm.mode,
        role: options.role,
        phase: request.phase,
        need: request.need,
        outcome: outcomeOf(answer),
        reason: answer.state === "ok" ? null : answer.reason,
        source: answer.state === "ok" ? answer.source : null,
        parity: parity?.parity ?? "none",
        cause: parity?.cause ?? null,
        harness: call.harness,
        root: rootHash(request.root),
        linked: options.linked,
    };
    const context = {
        entries: answer.state === "ok" ? answer.view.entries.length : null,
        digest: viewDigest(answer),
        gitSpawns: answer.cost.gitSpawns,
        serviceCpuMs: answer.cost.serviceCpuMs,
        fullStatus: answer.cost.fullStatus,
        session: call.sessionId,
        toolUseId: call.toolUseId,
        differences: (parity?.differences ?? []).slice(0, MAX_RECORDED_DIFFERENCES),
    };

    try {
        recorder.record(STATUS_METRICS.project, STATUS_METRICS.cpu, answer.cost.cpuMs, dims, context);
        recorder.record(STATUS_METRICS.project, STATUS_METRICS.wall, answer.cost.wallMs, dims);
    } catch {
        // `record` buffers and never throws by contract; a broken recorder must still not stop the command.
    }
}
