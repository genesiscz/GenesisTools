import { resolveAgentHost } from "@genesiscz/utils/agent/host";
import { type FocusStealGuard, loadJevSettings } from "@genesiscz/utils/ai/evaluation/settings";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { env } from "@genesiscz/utils/env";
import { logger } from "@genesiscz/utils/logger";
import { readExecutablePath } from "@genesiscz/utils/process/processes";
import { type AxResult, type AxRun, runAx } from "./runner";

const { log } = logger.scoped("control-focus-guard");

/**
 * The legacy keyboard verbs post CGEvents that raise the target app or land in whatever app is
 * frontmost (measured 2026-09-09: `type --to-pid` raised Genesis over cmux, `hotkey` sent `cmd,b`
 * into the user's terminal and reported ok). Each entry names the focus-safe substitute an agent
 * should take instead. A new focus-stealing verb is one more row here, never a branch at a caller.
 */
const FOCUS_STEALING_VERBS = {
    type: `${toolCommand("control see")} then ${toolCommand("control act")} --action set (an AXValue write, no keys)`,
    set: `${toolCommand("control see")} then ${toolCommand("control act")} --action set (an AXValue write with readback)`,
    hotkey: `${toolCommand("control see")} then ${toolCommand("control act")} --action key, which refuses a wrong frontmost window, or press/perform for a control`,
} as const;

export type FocusStealingVerb = keyof typeof FOCUS_STEALING_VERBS;

export function isFocusStealingVerb(verb: string): verb is FocusStealingVerb {
    return Object.hasOwn(FOCUS_STEALING_VERBS, verb);
}

/** What the window server says is in front: its pid and app name, and the top on-screen window the user sees. */
export interface FrontState {
    pid?: number;
    app?: string;
    /** The first layer-0 window, front to back. It can belong to another app than `pid`: a non-activating panel. */
    topWindow?: { app: string; title?: string };
}

interface WindowRow {
    pid?: unknown;
    app?: unknown;
    title?: unknown;
}

function rows(value: unknown): WindowRow[] {
    return Array.isArray(value) ? value.filter((row): row is WindowRow => row !== null && typeof row === "object") : [];
}

function appNamed(row: WindowRow, pid: number, key: "app" | "name"): string | undefined {
    const name = (row as Record<string, unknown>)[key];
    return row.pid === pid && typeof name === "string" && name.length > 0 ? name : undefined;
}

/**
 * Reads `ax-tool front`'s answer: the frontmost pid, named through one of its on-screen windows or,
 * when it has none (a GenesisTools panel, a menu-bar app), through `ax-tool apps`.
 */
export function frontStateFrom(front: AxResult, apps?: AxResult): FrontState | null {
    if (!front.ok || typeof front.frontmostPid !== "number") {
        return null;
    }

    const pid = front.frontmostPid;
    const windows = rows(front.windows);
    const top = windows.find((row) => typeof row.app === "string" && row.app.length > 0);
    const topWindow =
        top === undefined
            ? undefined
            : { app: String(top.app), ...(typeof top.title === "string" ? { title: top.title } : {}) };
    const app =
        windows.map((row) => appNamed(row, pid, "app")).find((name) => name !== undefined) ??
        rows(apps?.apps)
            .map((row) => appNamed(row, pid, "name"))
            .find((name) => name !== undefined);

    return { pid, ...(app ? { app } : {}), ...(topWindow ? { topWindow } : {}) };
}

/** `/System/.../NotificationCenter.app/Contents/MacOS/NotificationCenter` reads as `NotificationCenter`. */
export function appNameFromCommand(command: string): string | undefined {
    const trimmed = command.trim();
    const bundle = /([^/]+)\.app\//.exec(trimmed)?.[1];
    return bundle ?? (trimmed.split("/").pop() || undefined);
}

/** The executable of one pid, for a frontmost process that is neither on screen nor a regular app. */
function processName(pid: number): string | undefined {
    const path = readExecutablePath(pid);
    if (path === null) {
        log.debug({ pid }, "could not name the frontmost pid from its executable");
        return undefined;
    }

    return appNameFromCommand(path);
}

/**
 * One `ax-tool front` read, plus `apps` and then the executable only when the frontmost pid has no window
 * (a notification banner, a GenesisTools panel). Null means "cannot prove it is safe".
 */
export async function readFrontState(run: AxRun = runAx): Promise<FrontState | null> {
    const front = await run(["front"], 5000);
    let state = frontStateFrom(front);

    if (state !== null && state.app === undefined) {
        state = frontStateFrom(front, await run(["apps"], 5000));
    }

    if (state?.pid !== undefined && state.app === undefined) {
        const app = processName(state.pid);
        state = app === undefined ? state : { ...state, app };
    }

    log.debug({ state }, "frontmost app for the focus-steal guard");
    return state;
}

/** Whether the guard applies in this process, from the saved `focusStealGuard` setting (default `always`). */
export function guardApplies(guard: FocusStealGuard | undefined, environment: NodeJS.ProcessEnv): boolean {
    const mode = guard ?? "always";
    const applies: Record<FocusStealGuard, () => boolean> = {
        always: () => true,
        agents: () => resolveAgentHost(environment).isInAgent === true,
        off: () => false,
    };

    return applies[mode]();
}

function frontLabel(front: FrontState): string {
    const owner = front.app ? `${front.app} (pid ${front.pid})` : `pid ${front.pid}`;
    const top = front.topWindow;

    if (top === undefined || top.app === front.app) {
        return owner;
    }

    return `${owner} (top window: ${top.app}${top.title ? ` "${top.title}"` : ""})`;
}

/**
 * The refusal text for one legacy keyboard verb, or null when it may run. It may run when the
 * target already IS frontmost: then nothing is taken from anyone. It refuses when another app is in
 * front, when the frontmost app cannot be read (a guard that fails open is no guard), and for a
 * `hotkey` with no target at all, whose keys would land in whatever the user has focused.
 */
export function focusStealRefusal({
    verb,
    app,
    toPid,
    front,
}: {
    verb: FocusStealingVerb;
    app?: string;
    toPid?: string;
    front: FrontState | null;
}): string | null {
    const substitute = FOCUS_STEALING_VERBS[verb];
    const optOut = `pass --steal-focus for a demonstration the user asked for, or save ${toolCommand("control config set")} focusStealGuard off`;

    if (front === null) {
        return `control ${verb} refused: the frontmost app could not be read, so it cannot be shown that no focus is taken. No event was posted. Use ${substitute}, or ${optOut}.`;
    }

    const pid = toPid === undefined ? undefined : Number(toPid);
    const targetIsFront =
        (pid !== undefined || app !== undefined) &&
        (pid === undefined || front.pid === pid) &&
        (app === undefined || (front.app !== undefined && front.app === app));

    if (targetIsFront) {
        return null;
    }

    const target = app ?? (toPid === undefined ? undefined : `pid ${toPid}`);
    const what =
        target === undefined
            ? `has no target app, so its keys would land in the frontmost app, ${frontLabel(front)}`
            : `would take focus from the frontmost app, ${frontLabel(front)}; the target is ${target}`;

    return `control ${verb} refused: it ${what}. No event was posted. Use ${substitute}, or ${optOut}.`;
}

/**
 * The guard every door calls before it dispatches a legacy keyboard verb: the CLI commands, the
 * plan runner and the MCP twin. `stealFocus` is the explicit per-call opt-in; the saved setting and
 * the frontmost read are injectable so tests never touch the real window server.
 */
export async function guardFocusSteal({
    verb,
    app,
    toPid,
    stealFocus,
    run = runAx,
    readFront = () => readFrontState(run),
    loadGuard = async () => (await loadJevSettings()).focusStealGuard,
    environment = env.getProcessEnv(),
}: {
    verb: FocusStealingVerb;
    app?: string;
    toPid?: string;
    stealFocus?: boolean;
    /** The native runner the default frontmost read uses. */
    run?: AxRun;
    readFront?: () => FrontState | null | Promise<FrontState | null>;
    loadGuard?: () => Promise<FocusStealGuard | undefined>;
    environment?: NodeJS.ProcessEnv;
}): Promise<AxResult | null> {
    if (stealFocus === true) {
        log.debug({ verb, app }, "focus-steal guard lifted by --steal-focus");
        return null;
    }

    const guard = await loadGuard();
    if (!guardApplies(guard, environment)) {
        log.debug({ verb, guard }, "focus-steal guard off by setting");
        return null;
    }

    const front = await readFront();
    const refusal = focusStealRefusal({ verb, app, toPid, front });

    if (refusal === null) {
        return null;
    }

    log.debug({ verb, app, toPid, front }, "focus-steal guard refused a legacy keyboard verb");
    return {
        ok: false,
        error: refusal,
        refusal: "focus_steal",
        dispatchState: "not_started",
        frontmost: front ?? undefined,
    };
}
