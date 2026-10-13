import { withTimeout } from "@genesiscz/utils/async";
import { SafeJSON } from "@genesiscz/utils/json";
import { profiler } from "@genesiscz/utils/profile";
import type { CdpLike } from "./cdp-like.ts";

const prof = profiler.scope("chrome-devtools");

const DEFAULT_TIMEOUT_MS = 30_000;

export interface InPageCallOptions {
    /** How long the expression, and a promise it returns, may run. Default 30 s. */
    timeoutMs?: number;
}

export class InPageError extends Error {}

/**
 * The expression that calls an `in-page/` function with one JSON argument.
 * The function must be self-contained (no imports, no closure over module scope), because only its
 * source text reaches the page.
 */
export function inPageExpression<A>(fn: (arg: A) => unknown, arg?: A): string {
    const json = arg === undefined ? "" : SafeJSON.stringify(arg);
    return `(${fn.toString()})(${json})`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function exceptionText(details: Record<string, unknown>): string {
    const exception = details.exception;
    const description = isRecord(exception) ? exception.description : undefined;
    return typeof description === "string" ? description : String(details.text ?? "in-page exception");
}

/** Runs an expression in the page's main world and returns its JSON value. Throws `InPageError` on a page exception. */
export async function evaluateExpression(
    cdp: CdpLike,
    expression: string,
    options: InPageCallOptions = {}
): Promise<unknown> {
    // Every in-page call passes here; the named in-page.<fn> timer is the useful one by default.
    const stopProfile = profiler.detail === "all" ? prof.start("evaluate") : () => 0;
    try {
        const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        const reply = await withTimeout(
            // The transport's own deadline must not end the call first: a long in-page call (an IndexedDB dump,
            // a wait for a condition) asks for more than a plain command gets.
            cdp.send(
                "Runtime.evaluate",
                { expression, awaitPromise: true, returnByValue: true },
                { timeoutMs: timeoutMs + 1_000 }
            ),
            timeoutMs,
            new InPageError(`in-page call did not finish within ${timeoutMs} ms`)
        );

        if (!isRecord(reply)) {
            throw new InPageError("Runtime.evaluate returned no result");
        }

        if (isRecord(reply.exceptionDetails)) {
            throw new InPageError(exceptionText(reply.exceptionDetails));
        }

        return isRecord(reply.result) ? reply.result.value : undefined;
    } finally {
        stopProfile();
    }
}

export interface InitScript {
    /** The id from `Page.addScriptToEvaluateOnNewDocument`. */
    identifier: string;
    /** Stops running the script in documents loaded from now on. */
    remove(): Promise<void>;
}

/**
 * Runs an `in-page/` function in every new document of this target, before the page's own scripts.
 * Init scripts belong to the CDP session: they stop when it detaches.
 */
export async function addInitScript<A>(cdp: CdpLike, fn: (arg: A) => unknown, arg: A): Promise<InitScript> {
    const reply = await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: inPageExpression(fn, arg) });
    const identifier = isRecord(reply) && typeof reply.identifier === "string" ? reply.identifier : null;
    if (!identifier) {
        throw new InPageError("Page.addScriptToEvaluateOnNewDocument returned no identifier");
    }

    return {
        identifier,
        async remove() {
            await cdp.send("Page.removeScriptToEvaluateOnNewDocument", { identifier });
        },
    };
}

/** Calls an `in-page/` function with `arg` and returns what it returned (by value). */
export async function callInPage<A, R>(
    cdp: CdpLike,
    fn: (arg: A) => R,
    arg: A,
    options: InPageCallOptions = {}
): Promise<Awaited<R>> {
    const stopProfile = prof.start(`in-page.${fn.name || "anonymous"}`);
    try {
        const value = await evaluateExpression(cdp, inPageExpression(fn, arg), options);
        // The in-page functions are ours and return plain JSON by construction; returnByValue hands it back as is.
        return value as Awaited<R>;
    } finally {
        stopProfile();
    }
}
