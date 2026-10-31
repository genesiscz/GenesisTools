import { abortableSleep } from "@genesiscz/utils/async";
import { type AxResult, type AxRun, runAx } from "./runner";

/** One element condition: `wait` polls it, `assert` checks it once. The CLI, the plan runner and the MCP twin share it. */
export interface CheckOpts {
    app: string;
    target: string[];
    gone?: boolean;
    for?: string;
    value?: string;
    contains?: string;
    /** The native read; injected by tests so no condition ever reaches the real window server. */
    run?: AxRun;
    signal?: AbortSignal;
}

async function checkOnce(o: CheckOpts): Promise<{ pass: boolean; state: AxResult }> {
    const state = await (o.run ?? runAx)(["get", "--app", o.app, ...o.target]);
    if (o.gone) {
        return { pass: !state.ok, state };
    }

    if (!state.ok) {
        return { pass: false, state };
    }

    if (o.for === "enabled" && state.enabled !== true) {
        return { pass: false, state };
    }

    if (o.for === "focused" && state.focused !== true) {
        return { pass: false, state };
    }

    if (o.value !== undefined && String(state.value ?? "") !== o.value) {
        return { pass: false, state };
    }

    if (o.contains !== undefined && !String(state.value ?? "").includes(o.contains)) {
        return { pass: false, state };
    }

    return { pass: true, state };
}

function conditionLabel(o: CheckOpts): string {
    if (o.for !== undefined) {
        return o.for;
    }

    if (o.value !== undefined) {
        return `value == '${o.value}'`;
    }

    return o.contains !== undefined ? `value contains '${o.contains}'` : "exists";
}

/**
 * Polls until the condition holds or timeout. Shared by the CLI command and run steps.
 *
 * Async because of the sleep, not the check: `checkOnce` spawns ax-tool synchronously and always
 * did. With `Bun.sleepSync` the whole wait was one unbroken block, measured at 1055 ms for a
 * 1000 ms timeout, during which no timer ran and Ctrl-C was not delivered until it ended.
 */
export async function waitFor(o: CheckOpts & { timeout: number; interval: number }): Promise<AxResult> {
    const t0 = performance.now();
    let last: { pass: boolean; state: AxResult } = { pass: false, state: { ok: false } };
    let polls = 0;
    while (performance.now() - t0 < o.timeout) {
        if (o.signal?.aborted) {
            return { ok: false, action: "wait", error: "cancelled" };
        }
        last = await checkOnce(o);
        polls++;
        if (o.signal?.aborted) {
            return { ok: false, action: "wait", error: "cancelled" };
        }
        if (last.pass) {
            return {
                ok: true,
                action: "wait",
                waitedMs: Math.round(performance.now() - t0),
                polls,
                ...(o.gone ? { gone: true } : { element: last.state }),
            };
        }

        // Sleep only up to the deadline. A full interval here let one more poll start at the
        // last millisecond and run the wait 20% past its timeout, one ax-tool spawn for nothing.
        const remaining = o.timeout - (performance.now() - t0);
        if (remaining <= 0) {
            break;
        }

        try {
            await abortableSleep(Math.min(o.interval, remaining), o.signal);
        } catch (error) {
            if (!o.signal?.aborted) {
                throw error;
            }
            return { ok: false, action: "wait", error: "cancelled" };
        }
    }

    const cond = o.gone ? "gone" : conditionLabel(o);
    return {
        ok: false,
        action: "wait",
        error: `timeout after ${o.timeout}ms (${polls} polls) — ${o.target.join(" ")} in ${o.app}: '${cond}' not met`,
        lastState: last.state,
    };
}

/** Single-shot condition check. Shared by the CLI command and run steps. */
export async function assertEl(o: CheckOpts): Promise<AxResult> {
    const { pass, state } = await checkOnce(o);
    if (pass) {
        return { ok: true, action: "assert", ...(o.gone ? { gone: true } : { element: state }) };
    }

    const want = o.gone ? "element gone" : conditionLabel(o);
    return {
        ok: false,
        action: "assert",
        error: `assert failed: expected ${want}`,
        actual: state.ok ? { value: state.value, enabled: state.enabled, focused: state.focused } : state.error,
    };
}

/** `wait` and `assert` exit 0 when the condition held and 1 when it did not; a plan step reads the same `ok`. */
export function conditionExitCode(result: AxResult): number {
    return result.ok ? 0 : 1;
}
