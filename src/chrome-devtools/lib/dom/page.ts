import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { profiler } from "@genesiscz/utils/profile";
import { z } from "zod";
import { Conn, localDebuggerUrl, type Target } from "../cdp";
import {
    type DomAction,
    type DomPrepared,
    type DomSettled,
    type DomSnapshot,
    type DomSnapshotOptions,
    installPageAgent,
} from "./in-page";

const prof = profiler.scope("chrome-devtools");
const { log } = logger.scoped("chrome-devtools-dom");

const WORLD_NAME = "genesis-page-agent";
const AGENT_SOURCE = installPageAgent.toString();
/** A step's change normally lands within a few frames; a click that changes nothing pays this cap. */
const SETTLE_CAP_MS = 300;
const SETTLE_QUIET_MS = 50;
const WAIT_CAP_MS = 1500;
const NAVIGATION_CAP_MS = 8000;
/**
 * No single CDP call may hold a step longer than this. A benchmark run on 2026-09-28 lost 30 s in
 * one evaluate sent into a world whose document a form submit was replacing: the call neither
 * answered nor failed until Chrome gave up on it.
 */
const CALL_DEADLINE_MS = 5000;

export const DEFAULT_SNAPSHOT_OPTIONS: DomSnapshotOptions = {
    maxActions: 250,
    maxText: 6000,
    maxOptions: 30,
    maxBelowFoldLabels: 30,
};

export type DomActResult =
    | { ok: true; settled: DomSettled | "navigated"; screen?: { x: number; y: number } }
    | { ok: false; error: string; dispatched: boolean };

const fieldSchema = z.object({
    type: z.string(),
    name: z.string(),
    id: z.string(),
    ariaLabel: z.string(),
    autocomplete: z.string(),
    secret: z.boolean(),
});
const snapshotSchema = z.object({
    url: z.string(),
    title: z.string(),
    text: z.string(),
    actions: z.array(
        z.object({
            id: z.string().regex(/^n\d+(f|o\d+)?$/),
            node: z.number().int().positive(),
            kind: z.enum(["click", "fill", "select"]),
            role: z.string(),
            label: z.string(),
            value: z.string().optional(),
            checked: z.boolean().optional(),
            expanded: z.boolean().optional(),
            href: z.string().optional(),
            option: z.object({ index: z.number().int().min(0), label: z.string() }).optional(),
            field: fieldSchema.optional(),
            guard: z.string(),
        })
    ),
    omitted: z.number().int().min(0),
    belowFold: z.number().int().min(0),
    belowFoldLabels: z.array(z.string()),
    secretFields: z.array(z.object({ label: z.string(), field: fieldSchema })),
    canScrollDown: z.boolean(),
    canScrollUp: z.boolean(),
    historyLength: z.number().int().min(0),
    marker: z.string(),
});
const preparedSchema = z.union([
    z.object({
        ok: z.literal(true),
        x: z.number(),
        y: z.number(),
        screen: z.object({ x: z.number(), y: z.number() }),
        visible: z.boolean(),
    }),
    z.object({
        ok: z.literal(false),
        reason: z.enum(["gone", "changed", "disabled", "hidden", "occluded"]),
        detail: z.string().optional(),
    }),
]);
const settledSchema = z.object({
    reason: z.enum(["quiet", "cap"]),
    mutations: z.number(),
    ms: z.number(),
});

class DeadlineError extends Error {}

/** The execution context vanished, or a call ran out its deadline while a navigation replaced it. */
function isContextLoss(error: unknown): boolean {
    if (error instanceof DeadlineError) {
        return true;
    }

    const message = error instanceof Error ? error.message : String(error);
    return /context was destroyed|Cannot find context|Inspected target navigated|Execution context/i.test(message);
}

/**
 * A send that ran out its deadline may or may not have reached the page. It is reported as
 * dispatched, so a caller never repeats an input that may already have landed.
 */
function uncertain(error: unknown): DomActResult {
    if (!(error instanceof DeadlineError)) {
        throw error;
    }

    return { ok: false, error: `dispatch_uncertain: ${error.message}`, dispatched: true };
}

interface LoadWaiter {
    loaded: Promise<void>;
    /** Drops the waiter when the input did not navigate, so a long single-page session does not pile them up. */
    cancel: () => void;
}

async function withDeadline<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new DeadlineError(`${label} did not answer within ${ms} ms`)), ms);
    });
    try {
        return await Promise.race([promise, deadline]);
    } finally {
        clearTimeout(timer);
    }
}

/**
 * One page, driven over our own CDP client. Every read is ONE `Runtime.evaluate` of the page agent
 * in an isolated world; every input is a real `Input.dispatch*` event at a point the agent has just
 * hit-tested. It replaced jev's chrome-devtools-mcp accessibility snapshot, which took 26 s on a
 * 60-tab browser and needed a second script call for fields and a third for boxes.
 */
export class DomPage {
    private contextId: number | undefined;
    private readonly navigations: Array<() => void> = [];

    private constructor(
        private readonly conn: Conn,
        readonly target: Target,
        readonly port: number
    ) {
        this.conn.on((method, params) => {
            const frame = params.frame as { parentId?: string } | undefined;
            if (
                method === "Runtime.executionContextsCleared" ||
                (method === "Page.frameNavigated" && !frame?.parentId)
            ) {
                this.contextId = undefined;
            }

            // A back/forward cache restore brings a finished document back without DOMContentLoaded,
            // and a same-document navigation has none either; both are loaded the moment they land.
            const restored =
                method === "Page.frameNavigated" && !frame?.parentId && params.type === "BackForwardCacheRestore";
            if (method === "Page.domContentEventFired" || method === "Page.navigatedWithinDocument" || restored) {
                for (const wake of this.navigations.splice(0)) {
                    wake();
                }
            }
        });
    }

    /** Attaches to one page target the caller has already chosen; choosing is a policy, not ours. */
    static async attach(options: { port: number; target: Target }): Promise<DomPage> {
        const { target } = options;
        const conn = new Conn(localDebuggerUrl(target, options.port));
        const page = new DomPage(conn, target, options.port);
        await conn.send("Page.enable");
        await conn.send("Runtime.enable");
        // Keeps timers, animations and focus alive in a tab the user is not looking at, so the
        // agent works in a background tab without bringing it to the front.
        await conn.send("Emulation.setFocusEmulationEnabled", { enabled: true });
        await page.ready();
        log.debug({ port: options.port, url: target.url, title: target.title }, "DOM page attached");
        return page;
    }

    /** A tab opened for the goal may still be loading; the first read must see the parsed document. */
    private async ready(): Promise<void> {
        const load = this.nextLoad();
        try {
            const state = await withDeadline(
                this.conn.send("Runtime.evaluate", { expression: "document.readyState", returnByValue: true }),
                CALL_DEADLINE_MS,
                "readyState"
            )
                .then((value) => (value as { result?: { value?: unknown } }).result?.value)
                .catch((error: unknown) => {
                    log.debug({ error }, "readyState read failed while attaching; waiting for the load event");
                    return undefined;
                });
            if (state !== "complete" && state !== "interactive") {
                await this.untilLoaded(load.loaded);
            }
        } finally {
            load.cancel();
        }
    }

    close(): void {
        this.conn.close();
    }

    private async world(): Promise<number> {
        if (this.contextId !== undefined) {
            return this.contextId;
        }

        const tree = (await this.conn.send("Page.getFrameTree")) as { frameTree: { frame: { id: string } } };
        const created = (await this.conn.send("Page.createIsolatedWorld", {
            frameId: tree.frameTree.frame.id,
            worldName: WORLD_NAME,
            grantUniveralAccess: false,
        })) as { executionContextId: number };
        this.contextId = created.executionContextId;
        return this.contextId;
    }

    /**
     * Runs one agent method in the isolated world. A lost context is recreated once, and only after
     * the new document says it is ready; `retry: false` hands the loss to the caller instead.
     */
    private async agent(
        method: string,
        arg: unknown,
        options: { retry?: boolean; deadlineMs?: number } = {}
    ): Promise<unknown> {
        const expression = `(${AGENT_SOURCE})(); globalThis.__gtJevAgent.${method}(${SafeJSON.stringify(arg ?? null, { strict: true })})`;
        for (let attempt = 0; ; attempt++) {
            try {
                const contextId = await withDeadline(this.world(), CALL_DEADLINE_MS, "isolated world");
                const evaluated = this.conn.send("Runtime.evaluate", {
                    expression,
                    contextId,
                    returnByValue: true,
                    awaitPromise: true,
                });
                const result = (await withDeadline(
                    evaluated,
                    options.deadlineMs ?? CALL_DEADLINE_MS,
                    `page agent ${method}`
                )) as {
                    result?: { value?: unknown };
                    exceptionDetails?: { text: string; exception?: { description?: string } };
                };
                if (result.exceptionDetails) {
                    throw new Error(
                        `${result.exceptionDetails.text} ${result.exceptionDetails.exception?.description ?? ""}`.trim()
                    );
                }

                return result.result?.value;
            } catch (error) {
                if (!isContextLoss(error)) {
                    throw error;
                }

                // A deadline alone is a slow page, not a navigation: retrying it into a fresh document
                // would run the call twice. Only a context the page itself reported gone is retried.
                if (error instanceof DeadlineError && this.contextId !== undefined) {
                    throw error;
                }

                this.contextId = undefined;
                if (options.retry === false || attempt > 0) {
                    throw error;
                }

                log.debug({ method, error }, "page context was replaced; waiting for the new document, then retrying");
                await this.ready();
            }
        }
    }

    async snapshot(options: DomSnapshotOptions = DEFAULT_SNAPSHOT_OPTIONS): Promise<DomSnapshot> {
        const raw = await prof.measureAsync("dom-snapshot", () => this.agent("snapshot", options));
        return snapshotSchema.parse(raw);
    }

    private async prepared(method: "prepare" | "focusField", action: DomAction): Promise<DomPrepared> {
        return preparedSchema.parse(await this.agent(method, { node: action.node, guard: action.guard }));
    }

    /** Every input send has a deadline, like every agent call: a document being replaced can leave one unanswered. */
    private input(method: string, params: Record<string, unknown>): Promise<unknown> {
        return withDeadline(this.conn.send(method, params), CALL_DEADLINE_MS, method);
    }

    private async mouseClick(x: number, y: number): Promise<void> {
        await this.input("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
        await this.input("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
        await this.input("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
    }

    /**
     * Waits for the change the last input caused. `loaded` was registered BEFORE the input, so a
     * navigation it started ends the wait on that document's load event however fast it landed.
     * Never retried: a lost context here IS the navigation.
     */
    private async settle(load: LoadWaiter, capMs = SETTLE_CAP_MS): Promise<DomSettled | "navigated"> {
        try {
            const raw = await prof.measureAsync("dom-settle", () =>
                this.agent("settle", { capMs, quietMs: SETTLE_QUIET_MS }, { retry: false, deadlineMs: capMs + 2000 })
            );
            return settledSchema.parse(raw);
        } catch (error) {
            if (!isContextLoss(error)) {
                throw error;
            }

            await this.untilLoaded(load.loaded);
            return "navigated";
        } finally {
            load.cancel();
        }
    }

    /** Registers a waiter BEFORE the navigation is sent, so a fast load cannot slip past it. */
    private nextLoad(): LoadWaiter {
        let wake: () => void = () => {};
        const loaded = new Promise<void>((resolve) => {
            wake = resolve;
            this.navigations.push(resolve);
        });
        return {
            loaded,
            cancel: () => {
                const index = this.navigations.indexOf(wake);
                if (index >= 0) {
                    this.navigations.splice(index, 1);
                }
            },
        };
    }

    private async untilLoaded(loaded: Promise<void>): Promise<void> {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const cap = new Promise<void>((resolve) => {
            timer = setTimeout(() => {
                log.warn({ capMs: NAVIGATION_CAP_MS }, "navigation did not reach DOMContentLoaded in time");
                resolve();
            }, NAVIGATION_CAP_MS);
        });
        try {
            await prof.measureAsync("dom-navigation", () => Promise.race([loaded, cap]));
        } finally {
            clearTimeout(timer);
        }
    }

    private async navigateBy(label: string, send: () => Promise<unknown>): Promise<DomActResult> {
        const load = this.nextLoad();
        try {
            await withDeadline(send(), CALL_DEADLINE_MS, label);
            await this.untilLoaded(load.loaded);
            return { ok: true, settled: "navigated" };
        } catch (error) {
            return uncertain(error);
        } finally {
            load.cancel();
        }
    }

    async click(action: DomAction): Promise<DomActResult> {
        const prepared = await this.prepared("prepare", action);
        if (!prepared.ok) {
            return {
                ok: false,
                error: `target ${prepared.reason}${prepared.detail ? `: ${prepared.detail}` : ""}`,
                dispatched: false,
            };
        }

        await this.agent("arm", null);
        const load = this.nextLoad();
        try {
            await this.mouseClick(prepared.x, prepared.y);
        } catch (error) {
            load.cancel();
            return uncertain(error);
        }

        const settled = await this.settle(load);
        return { ok: true, settled, ...(prepared.visible ? { screen: prepared.screen } : {}) };
    }

    /** Replaces the field's content and proves it holds exactly the supplied value. */
    async fill(action: DomAction, value: string): Promise<DomActResult> {
        const prepared = await this.prepared("focusField", action);
        if (!prepared.ok) {
            return {
                ok: false,
                error: `target ${prepared.reason}${prepared.detail ? `: ${prepared.detail}` : ""}`,
                dispatched: false,
            };
        }

        await this.agent("arm", null);
        const load = this.nextLoad();
        try {
            await this.input("Input.insertText", { text: value });
        } catch (error) {
            load.cancel();
            return uncertain(error);
        }

        const settled = await this.settle(load);
        if (settled === "navigated") {
            return { ok: true, settled };
        }

        const holds = await this.agent("holds", { node: action.node, expected: value });
        if (holds !== true) {
            return {
                ok: false,
                error: "fill_unverified: the field does not hold the supplied value",
                dispatched: true,
            };
        }

        return { ok: true, settled };
    }

    async select(action: DomAction): Promise<DomActResult> {
        if (!action.option) {
            return { ok: false, error: "select needs an option", dispatched: false };
        }

        await this.agent("arm", null);
        const load = this.nextLoad();
        let prepared: DomPrepared;
        try {
            prepared = preparedSchema.parse(
                await this.agent(
                    "selectOption",
                    {
                        node: action.node,
                        guard: action.guard,
                        option: action.option.index,
                        optionLabel: action.option.label,
                    },
                    { retry: false }
                )
            );
        } catch (error) {
            load.cancel();
            throw error;
        }

        if (!prepared.ok) {
            load.cancel();
            return {
                ok: false,
                error: `target ${prepared.reason}${prepared.detail ? `: ${prepared.detail}` : ""}`,
                dispatched: false,
            };
        }

        const settled = await this.settle(load);
        if (settled === "navigated") {
            return { ok: true, settled };
        }

        // A change event may already have run page code, so an unconfirmed select is reported and
        // never repeated.
        const confirmed = await this.agent("selected", { node: action.node, option: action.option.index });
        return confirmed === true
            ? { ok: true, settled }
            : { ok: false, error: "select_unverified: the list shows another option", dispatched: true };
    }

    async scroll(direction: 1 | -1): Promise<DomActResult> {
        await this.agent("arm", null);
        const load = this.nextLoad();
        const moved = await this.agent("scroll", direction, { retry: false }).catch((error: unknown) => {
            load.cancel();
            throw error;
        });
        if (moved === 0) {
            load.cancel();
            return { ok: false, error: "scroll moved nothing", dispatched: true };
        }

        return { ok: true, settled: await this.settle(load) };
    }

    async wait(): Promise<DomActResult> {
        await this.agent("arm", null);
        return { ok: true, settled: await this.settle(this.nextLoad(), WAIT_CAP_MS) };
    }

    async back(): Promise<DomActResult> {
        const history = (await withDeadline(
            this.conn.send("Page.getNavigationHistory"),
            CALL_DEADLINE_MS,
            "Page.getNavigationHistory"
        )) as {
            currentIndex: number;
            entries: Array<{ id: number }>;
        };
        const previous = history.entries[history.currentIndex - 1];
        if (!previous) {
            return { ok: false, error: "no history entry to go back to", dispatched: false };
        }

        return this.navigateBy("Page.navigateToHistoryEntry", () =>
            this.conn.send("Page.navigateToHistoryEntry", { entryId: previous.id })
        );
    }

    reload(): Promise<DomActResult> {
        return this.navigateBy("Page.reload", () => this.conn.send("Page.reload", { ignoreCache: false }));
    }

    navigate(url: string): Promise<DomActResult> {
        return this.navigateBy("Page.navigate", () => this.conn.send("Page.navigate", { url }));
    }
}
