import { AsyncLocalStorage } from "node:async_hooks";
import { env } from "@genesiscz/utils/env";

/**
 * The trace id of the call this code runs for, so one GenesisTools.app call can be followed from the app's
 * `app-perf.log` line to the CLI's day log and profiling lines.
 *
 * A `tools` process gets it from `GENESIS_TOOLS_TRACE_ID` (set by the app per call). The resident hub server
 * runs many calls in one process, so there it comes from the request and is scoped with `withTraceId`.
 */
const scope = new AsyncLocalStorage<string>();
const processTraceId = env.tools.getTraceId();

/** Letters, digits, `-` and `_`, at most 64: an id, never free text. */
export function isTraceId(value: unknown): value is string {
    return typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value);
}

export function currentTraceId(): string | undefined {
    return scope.getStore() ?? processTraceId;
}

export function withTraceId<T>(traceId: string | undefined, fn: () => T): T {
    return traceId ? scope.run(traceId, fn) : fn();
}
