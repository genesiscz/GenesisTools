import { runCmuxJSON } from "@genesiscz/utils/cmux/lib/cli";
import { CmuxCommandError } from "@genesiscz/utils/cmux/lib/command-error";
import {
    type CmuxHealthState,
    CmuxUnresponsiveError,
    ensureCmuxResponsive,
    findCmuxAppPid,
} from "@genesiscz/utils/cmux/lib/health";
import {
    activeTreeBackoff,
    fileTreeBackoffStore,
    nextTreeBackoff,
    skippedTreeError,
    type TreeBackoffStore,
} from "@genesiscz/utils/cmux/lib/tree-backoff";
import { logger } from "@genesiscz/utils/logger";

/**
 * The one `cmux tree --all` read. Every module that wants the live tabs (the fleet locator's `liveTree`, the
 * snapshot's surfaces, the tmux join, `who`, a new session's ids) asks here, so each gets the same bound, the probe
 * that names a fault, the backoff after cmux stopped answering, and one parse.
 *
 * A failed read is a value, never an empty tree: a wedged cmux must not look like a terminal with no tabs.
 * The tree carries no pane geometry; the geometry snapshot (`lib/live-snapshot.ts`) stays its own read.
 */

/** `tree --all` answers in about 100 ms; a stalled cmux must give up long before the 30 s default of `runCmux`. */
export const CMUX_TREE_TIMEOUT_MS = 3_500;

/** `--id-format both` adds each UUID beside its ref: refs renumber at every cmux relaunch, the UUIDs stay. */
const TREE_ARGS = ["--id-format", "both", "tree", "--all"];

export interface CmuxTreeReadSurface {
    /** The surface UUID. */
    id: string | null;
    /** `surface:N`, for display. */
    ref: string | null;
    /** `ttys001`, as cmux reports it (no `/dev/`). */
    tty: string | null;
    type: string | null;
    title: string | null;
    /** The position in its pane (`index_in_pane`, else `index`). */
    index: number | null;
    /** Selected in its pane (`selected_in_pane`, else `selected`). */
    selected: boolean | null;
    url: string | null;
    /** The `pane:N` the surface names itself, when it does. */
    paneRef: string | null;
}

export interface CmuxTreeReadPane {
    id: string | null;
    ref: string | null;
    /** Null when the tree listed no surfaces for the pane (a caller then asks cmux for that pane itself). */
    surfaces: CmuxTreeReadSurface[] | null;
}

export interface CmuxTreeReadWorkspace {
    id: string | null;
    ref: string | null;
    title: string | null;
    name: string | null;
    panes: CmuxTreeReadPane[];
}

export interface CmuxTreeReadWindow {
    id: string | null;
    ref: string | null;
    workspaces: CmuxTreeReadWorkspace[];
}

/** The parsed `cmux --json --id-format both tree --all`. */
export interface CmuxTree {
    /** The surface the reading process runs in, when cmux named it. */
    caller: { surfaceId: string | null; surfaceRef: string | null } | null;
    windows: CmuxTreeReadWindow[];
}

export type CmuxTreeRead =
    | { ok: true; tree: CmuxTree }
    | {
          ok: false;
          reason: "timeout" | "failed" | "backoff";
          /** What went wrong, for a log or a user: the probe's diagnosis when it found one. */
          error: string;
      };

export interface ReadCmuxTreeOptions {
    timeoutMs?: number;
    /**
     * The cmux call: argv after the binary, answering parsed JSON or throwing. Default `runCmuxJSON`. An injected
     * runner (a test) gets no backoff file and no probe unless those are injected too. Reads through one runner
     * that overlap share one call.
     */
    run?: (args: string[], opts: { timeoutMs: number }) => Promise<unknown>;
    /** Names the fault after a failed read; throws `CmuxUnresponsiveError` when cmux does not answer. */
    probe?: (context: string) => Promise<unknown>;
    /** The memory of a cmux that does not answer (`lib/tree-backoff.ts`); null turns it off. */
    backoff?: TreeBackoffStore | null;
    /** The running cmux app's pid; default `findCmuxAppPid`. */
    appPid?: () => number | undefined;
    now?: () => number;
}

const { log } = logger.scoped("cmux-tree-read");

type TreeRunner = NonNullable<ReadCmuxTreeOptions["run"]>;

const defaultRun: TreeRunner = (args, opts) => runCmuxJSON<unknown>(args, opts);

/** Reads in flight now, by runner and timeout: callers that ask at the same moment share one cmux call. */
const inFlight = new Map<TreeRunner, Map<number, Promise<CmuxTreeRead>>>();

/** The live tree, bounded, probed on failure and backed off after cmux stopped answering. */
export function readCmuxTree(options: ReadCmuxTreeOptions = {}): Promise<CmuxTreeRead> {
    const timeoutMs = options.timeoutMs ?? CMUX_TREE_TIMEOUT_MS;
    const run = options.run ?? defaultRun;
    const byTimeout = inFlight.get(run) ?? new Map<number, Promise<CmuxTreeRead>>();
    const running = byTimeout.get(timeoutMs);

    if (running) {
        return running;
    }

    const read = readOnce(options, run, timeoutMs).finally(() => {
        byTimeout.delete(timeoutMs);

        if (byTimeout.size === 0) {
            inFlight.delete(run);
        }
    });
    byTimeout.set(timeoutMs, read);
    inFlight.set(run, byTimeout);
    return read;
}

async function readOnce(options: ReadCmuxTreeOptions, run: TreeRunner, timeoutMs: number): Promise<CmuxTreeRead> {
    const now = options.now ?? Date.now;
    const backoff = options.backoff !== undefined ? options.backoff : options.run ? null : fileTreeBackoffStore();
    const previous = backoff?.read() ?? null;
    const skip = activeTreeBackoff({ record: previous, now: now(), appPid: options.appPid ?? findCmuxAppPid });

    if (skip) {
        log.debug({ backoff: skip }, "cmux tree not asked: cmux did not answer recently");
        return { ok: false, reason: "backoff", error: skippedTreeError(skip) };
    }

    const answer = await withDeadline(run(TREE_ARGS, { timeoutMs }), timeoutMs);
    let result: CmuxTreeRead;
    let unresponsive: { state: CmuxHealthState; appPid?: number } | undefined;

    if (answer.ok) {
        const tree = cmuxTreeFromJson(answer.value);
        result = tree ? { ok: true, tree } : { ok: false, reason: "failed", error: "cmux tree answered no object" };
    } else {
        const probe =
            options.probe ??
            (options.run
                ? undefined
                : (context: string) => ensureCmuxResponsive(context, { identifyTimeoutMs: 1_000 }));
        let error = answer.error;

        try {
            await probe?.("cmux tree");
        } catch (probeError) {
            error = probeError instanceof Error ? probeError.message : String(probeError);

            if (probeError instanceof CmuxUnresponsiveError) {
                const { state, appPid } = probeError.health;
                unresponsive = { state, ...(appPid !== undefined ? { appPid } : {}) };
            }
        }

        result = { ok: false, reason: answer.timedOut ? "timeout" : "failed", error };
        log.debug({ reason: result.reason, error }, "cmux tree read failed");
    }

    if (backoff) {
        const next = nextTreeBackoff({
            previous,
            unresponsive,
            error: result.ok ? undefined : result.error,
            now: now(),
        });

        // A success after no failure writes nothing, so a healthy cmux costs one stat per call.
        if (next || (previous && previous.failures > 0)) {
            backoff.write(next);
            log.debug({ backoff: next }, next ? "cmux tree backs off" : "cmux tree answered again; backoff cleared");
        }
    }

    return result;
}

type RunAnswer = { ok: true; value: unknown } | { ok: false; timedOut: boolean; error: string };

/**
 * The runner's answer, or a timeout at `timeoutMs` whatever the runner does: `runCmux` kills its child at the same
 * moment but waits a grace period for the exit, and an injected runner may never answer at all.
 */
async function withDeadline(call: Promise<unknown>, timeoutMs: number): Promise<RunAnswer> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<RunAnswer>((resolve) => {
        timer = setTimeout(
            () => resolve({ ok: false, timedOut: true, error: `cmux tree timed out after ${timeoutMs} ms` }),
            timeoutMs
        );
    });
    const answered = call.then(
        (value): RunAnswer => ({ ok: true, value }),
        (error): RunAnswer => ({
            ok: false,
            timedOut: error instanceof CmuxCommandError && error.result.timedOut === true,
            error: error instanceof Error ? error.message : String(error),
        })
    );

    try {
        return await Promise.race([answered, deadline]);
    } finally {
        clearTimeout(timer);
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function list(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [];
}

function str(value: unknown): string | null {
    return typeof value === "string" ? value : null;
}

function num(value: unknown): number | null {
    return typeof value === "number" ? value : null;
}

function bool(value: unknown): boolean | null {
    return typeof value === "boolean" ? value : null;
}

function surfaceOf(raw: Record<string, unknown>): CmuxTreeReadSurface {
    return {
        id: str(raw.id),
        ref: str(raw.ref),
        tty: str(raw.tty),
        type: str(raw.type),
        title: str(raw.title),
        index: num(raw.index_in_pane) ?? num(raw.index),
        selected: bool(raw.selected_in_pane) ?? bool(raw.selected),
        url: str(raw.url),
        paneRef: str(raw.pane_ref),
    };
}

/** The one parse of a `tree` answer; null when it is not an object. Strings stay as cmux sent them (an empty one too). */
export function cmuxTreeFromJson(value: unknown): CmuxTree | null {
    if (!isRecord(value)) {
        return null;
    }

    const caller = isRecord(value.caller)
        ? { surfaceId: str(value.caller.surface_id), surfaceRef: str(value.caller.surface_ref) }
        : null;
    const windows = list(value.windows)
        .filter(isRecord)
        .map((window) => ({
            id: str(window.id),
            ref: str(window.ref),
            workspaces: list(window.workspaces)
                .filter(isRecord)
                .map((workspace) => ({
                    id: str(workspace.id),
                    ref: str(workspace.ref),
                    title: str(workspace.title),
                    name: str(workspace.name),
                    panes: list(workspace.panes)
                        .filter(isRecord)
                        .map((pane) => ({
                            id: str(pane.id),
                            ref: str(pane.ref),
                            surfaces: Array.isArray(pane.surfaces)
                                ? pane.surfaces.filter(isRecord).map(surfaceOf)
                                : null,
                        })),
                })),
        }));

    return { caller, windows };
}
