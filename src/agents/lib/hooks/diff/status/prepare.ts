import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import type { MetricsRecorder } from "@genesiscz/utils/metrics";
import { isTestProcess } from "@genesiscz/utils/test-process";
import type { HarnessName } from "../../config";
import { statusOf } from "../../git";
import { hookDiag } from "../../log";
import { callDir, safeSegment } from "../../paths";
import { readOnlyCommand } from "../attribution";
import { makePrivateDir } from "../private-dir";
import { armsFor, gitOnly } from "./modes";
import type { Parity } from "./shadow";
import {
    type DiffStatusConfig,
    NO_COST,
    type StatusAnswer,
    type StatusArm,
    type StatusNeed,
    type StatusPhase,
    type StatusRequest,
    type StatusView,
} from "./types";

export interface StatusReads {
    /** Always a view the body can use: the active arm's answer, or Git's. */
    read(root: string): StatusView;
}

export interface StatusCall {
    harness: HarnessName;
    sessionId: string;
    toolUseId: string;
    command: string;
    dir: string | null;
}

/** Today's behaviour: one sync Git read per root, at the moment `read` is first called for it. */
export function gitReads(need: StatusNeed): StatusReads {
    return {
        read(root) {
            const summary = statusOf(root, { trackedOnly: need === "deletions" });
            return { head: summary.branch?.oid ?? null, entries: summary.entries };
        },
    };
}

/** A command that leaves a writer running after the hook: a job in the background or a detached child. */
const LEAVES_WRITER = /(^|[^&])&(?!&)|\bnohup\b|\bdisown\b|\bsetsid\b/;

/** False for a background call, a deferred diff, a command that leaves a writer (`&`, `nohup`, `disown`, `setsid`) and a test process. */
export function statusEligible(call: StatusCall, facts: { background: boolean; deferred: boolean }): boolean {
    if (facts.background || facts.deferred) {
        return false;
    }

    if (LEAVES_WRITER.test(call.command.replace(/&>|>&|\d>&\d/g, " "))) {
        return false;
    }

    return !isTestProcess();
}

const MARKS_FILE = "status-marks.json";

/** `{ v: 1, arms: { <arm id>: [<mark, "" for an answer without one, or null>, ...] } }`, one slot per root. */
type MarkSlots = Record<string, Array<string | null>>;

function markFileOf(call: StatusCall): string | null {
    const session = safeSegment(call.sessionId);
    const toolUse = safeSegment(call.toolUseId);

    if (session === null || toolUse === null) {
        return null;
    }

    return join(callDir(call.harness, session, toolUse), MARKS_FILE);
}

function readMarks(path: string | null): MarkSlots {
    if (!path || !existsSync(path)) {
        return {};
    }

    try {
        const parsed: unknown = SafeJSON.parse(readFileSync(path, "utf8"), { strict: true });

        if (
            typeof parsed !== "object" ||
            parsed === null ||
            !("v" in parsed) ||
            parsed.v !== 1 ||
            !("arms" in parsed)
        ) {
            return {};
        }

        const arms = parsed.arms;

        if (typeof arms !== "object" || arms === null) {
            return {};
        }

        const slots: MarkSlots = {};

        for (const [id, value] of Object.entries(arms)) {
            if (Array.isArray(value)) {
                slots[id] = value.map((slot) => (typeof slot === "string" ? slot : null));
            }
        }

        return slots;
    } catch (error) {
        hookDiag("status marks could not be read, so every arm starts without a mark", { path, error: String(error) });
        return {};
    }
}

function writeMarks(path: string | null, slots: MarkSlots): void {
    if (!path || Object.keys(slots).length === 0) {
        return;
    }

    const dir = join(path, "..");
    const refused = makePrivateDir(dir);

    if (refused) {
        hookDiag("status marks not written: the call folder is refused", { dir, refused });
        return;
    }

    writeFileSync(path, SafeJSON.stringify({ v: 1, arms: slots }), { mode: 0o600 });
}

function sampled(call: StatusCall, every: number): boolean {
    if (every <= 1) {
        return true;
    }

    return createHash("sha256").update(call.toolUseId).digest().readUInt32BE(0) % every === 0;
}

function isLinked(root: string): boolean {
    return statSync(join(root, ".git"), { throwIfNoEntry: false })?.isFile() ?? false;
}

async function observeSafely(arm: StatusArm, request: StatusRequest): Promise<StatusAnswer> {
    try {
        return await arm.observe(request);
    } catch (error) {
        hookDiag("a status arm threw, so it counts as unavailable", { arm: arm.id, error: String(error) });
        return { state: "unavailable", reason: "arm-error", cost: NO_COST };
    }
}

/** Parity of an arm against the reference; a difference that a second read of both does not repeat is `unconfirmed`. */
async function confirmedParity(options: {
    compare: typeof import("./shadow").compareToReference;
    arm: StatusArm;
    reference: StatusArm;
    request: StatusRequest;
    referenceView: StatusView;
    answer: StatusAnswer;
}): Promise<Parity> {
    const { arm, reference, request, referenceView, answer, compare } = options;

    if (answer.state !== "ok") {
        return { parity: "none", differences: [], cause: null };
    }

    const first = compare({
        need: request.need,
        phase: request.phase,
        reference: referenceView,
        got: answer.view,
    });

    if (first.parity === "same") {
        return first;
    }

    const [again, referenceAgain] = await Promise.all([
        observeSafely(arm, request),
        observeSafely(reference, { ...request, mark: null }),
    ]);

    if (again.state !== "ok" || referenceAgain.state !== "ok") {
        return { ...first, parity: "unconfirmed" };
    }

    const second = compare({
        need: request.need,
        phase: request.phase,
        reference: referenceAgain.view,
        got: again.view,
    });

    return second.parity === "same" ? { ...first, parity: "unconfirmed" } : second;
}

async function defaultRecorder(): Promise<MetricsRecorder> {
    const [{ hookRecorder }, { defineStatusMetrics }] = await Promise.all([
        import("../../guard-metrics"),
        import("./shadow"),
    ]);
    defineStatusMetrics();
    return hookRecorder();
}

/**
 * The status reads of one boundary. With `active` on `git` for this command shape and no shadow mode it returns
 * `gitReads` at once: no eager read, no mode load, no recorder. That is the default, and it is today's behaviour.
 *
 * Otherwise each root is asked of the active arm (with the arm's mark from pre at post); a post boundary whose
 * active arm left no slot in pre answers `unavailable` with `no-mark`, so a call that began on Git ends on Git. One call
 * in `shadow.every` also reads the reference and then each shadow arm, one after another, until `budgetMs` is spent.
 */
export async function prepareStatus(options: {
    phase: StatusPhase;
    roots: readonly { root: string; head: string | null }[];
    need: StatusNeed;
    call: StatusCall;
    config: DiffStatusConfig;
    recorder?: MetricsRecorder;
}): Promise<StatusReads> {
    const { phase, roots, need, call, config } = options;
    const fallback = gitReads(need);

    if (gitOnly(config)) {
        return fallback;
    }

    const shape = readOnlyCommand(call.command) ? "read" : "write";

    if (gitOnly(config, shape)) {
        return fallback;
    }

    const { active, reference, shadow } = await armsFor(config, shape);
    const shadowing = sampled(call, config.shadow.every) && (shadow.length > 0 || active.id !== reference.id);
    const recorder = shadowing ? (options.recorder ?? (await defaultRecorder())) : null;
    const { compareToReference, recordArm } = shadowing
        ? await import("./shadow")
        : { compareToReference: null, recordArm: null };
    const markPath = markFileOf(call);
    const marksIn = phase === "post" ? readMarks(markPath) : {};
    const marksOut: MarkSlots = {};
    const views = new Map<string, StatusView>();
    const started = performance.now();

    for (const [index, entry] of roots.entries()) {
        const requestFor = (arm: StatusArm): StatusRequest => ({
            phase,
            root: entry.root,
            need,
            head: entry.head,
            mark: marksIn[arm.id]?.[index] || null,
        });
        const linked = isLinked(entry.root);
        let referenceAnswer: StatusAnswer | null = null;

        const keepMark = (arm: StatusArm, answer: StatusAnswer) => {
            const slots = marksOut[arm.id] ?? roots.map(() => null);
            marksOut[arm.id] = slots;
            slots[index] = answer.state === "ok" ? (answer.mark ?? "") : null;
        };

        if (shadowing) {
            referenceAnswer = await observeSafely(reference, requestFor(reference));
        }

        let activeAnswer: StatusAnswer;

        if (active.id === reference.id) {
            activeAnswer = referenceAnswer ?? (await observeSafely(active, requestFor(active)));
        } else if (phase === "post" && (marksIn[active.id]?.[index] ?? null) === null) {
            activeAnswer = { state: "unavailable", reason: "no-mark", cost: NO_COST };
        } else {
            activeAnswer = await observeSafely(active, requestFor(active));
        }

        if (active.id !== reference.id) {
            keepMark(active, activeAnswer);
        }

        if (activeAnswer.state === "ok") {
            views.set(entry.root, activeAnswer.view);
        } else if (referenceAnswer?.state === "ok") {
            views.set(entry.root, referenceAnswer.view);
        }

        if (!recorder || !referenceAnswer || !recordArm || !compareToReference) {
            continue;
        }

        const referenceView = referenceAnswer.state === "ok" ? referenceAnswer.view : null;
        recordArm({
            recorder,
            call,
            request: requestFor(reference),
            arm: reference,
            role: "reference",
            answer: referenceAnswer,
            parity: null,
            linked,
        });

        const judge = async (arm: StatusArm, answer: StatusAnswer, role: "active" | "shadow") => {
            const parity = referenceView
                ? await confirmedParity({
                      arm,
                      reference,
                      request: requestFor(arm),
                      referenceView,
                      answer,
                      compare: compareToReference,
                  })
                : null;
            recordArm({ recorder, call, request: requestFor(arm), arm, role, answer, parity, linked });
        };

        if (active.id !== reference.id) {
            await judge(active, activeAnswer, "active");
        }

        for (const arm of shadow) {
            const overBudget = performance.now() - started > config.shadow.budgetMs;
            const answer: StatusAnswer = overBudget
                ? { state: "unavailable", reason: "budget", cost: NO_COST }
                : await observeSafely(arm, requestFor(arm));
            keepMark(arm, answer);
            await judge(arm, answer, "shadow");
        }
    }

    if (phase === "pre" && roots.length > 0) {
        writeMarks(markPath, marksOut);
    }

    return {
        read(root) {
            return views.get(root) ?? fallback.read(root);
        },
    };
}
