import { logger } from "@genesiscz/utils/logger";
import { profiler } from "@genesiscz/utils/profile";
import { type AxResult, runAxAsync } from "../runner";
import { type ActionParameters, nativeActionArguments } from "./action";
import {
    type Candidate,
    candidatesFor,
    hasAncestorRole,
    type Observation,
    observationSchema,
    primaryWebArea,
    sameScope,
} from "./observation";

const { log } = logger.scoped("control-native");
const prof = profiler.scope("control-native");

export interface DriverCall {
    signal?: AbortSignal;
    timeoutMs?: number;
}
export interface ControlDriver {
    observe(options: DriverCall): Promise<Observation>;
    validateObservation?(observation: Observation): void;
    act(
        options: DriverCall & {
            observation: Observation;
            candidate: Candidate;
            value?: string;
            parameters?: ActionParameters;
        }
    ): Promise<AxResult>;
}
const PREPARABLE_ACTIONS = new Set(["press", "click", "key", "type", "paste", "select", "set"]);
/** ax-tool refuses a tree deeper than this; see HierarchySource.buildObservedTree. */
export const MAX_SEE_DEPTH = 50;

/**
 * ax-tool refuses a too-shallow snapshot rather than truncating it, so a deeply nested app
 * (Electron, a web view) fails the first `see`. Read the refused depth back out of the message
 * and name the next one to try; `null` means the ceiling is already reached.
 */
export function deeperSeeDepth(error: string | undefined): number | null {
    const match = /exceeds --depth (\d+)/.exec(error ?? "");
    if (!match) {
        return null;
    }

    const refused = Number(match[1]);
    if (!Number.isFinite(refused) || refused >= MAX_SEE_DEPTH) {
        return null;
    }

    return Math.min(MAX_SEE_DEPTH, refused * 2);
}
/**
 * A tree can be too large to observe at all: ax-tool refuses past `observedElementLimit`, and the
 * observation schema refuses past 2000 rows rather than accept a partial screen. For a browser the
 * page is what makes it large, so the browser's own chrome is still a complete, observable surface
 * and is the honest thing to fall back to. Anything else has no smaller complete view, so it fails.
 */
export function overflowsObservation(error: string | undefined): boolean {
    const text = error ?? "";
    return /too_big|exceeds \d+ elements|exceeds traversal budget/.test(text) || atDepthCeiling(text);
}

/** The depth was refused and there is no deeper depth left to try. */
export function atDepthCeiling(error: string | undefined): boolean {
    const match = /exceeds --depth (\d+)/.exec(error ?? "");
    return match !== null && Number(match[1]) >= MAX_SEE_DEPTH;
}

export class NativeControlDriver implements ControlDriver {
    private pinned?: Observation;
    private depth?: number;
    private scope?: "window" | "chrome";
    constructor(
        private readonly options: {
            app: string;
            windowId?: number;
            /** On-screen window index (0 = frontmost) when no window id is pinned. */
            windowIndex?: number;
            scope?: "window" | "chrome";
            image?: boolean;
            prepare?: boolean | "auto";
            expectedURL?: string;
            /** AX traversal depth for `see`; escalated automatically when ax-tool refuses. */
            depth?: number;
            run?: typeof runAxAsync;
        }
    ) {}
    private seeArguments(): string[] {
        const args = ["see", "--app", this.options.app, "--scope", this.scope ?? this.options.scope ?? "window"];
        if (this.options.image === false) {
            args.push("--no-image");
        }

        const depth = this.depth ?? this.options.depth;
        if (depth !== undefined) {
            args.push("--depth", String(depth));
        }

        const windowId = this.pinned?.window.id ?? this.options.windowId;
        if (windowId !== undefined) {
            args.push("--window-id", String(windowId));
        } else if (this.options.windowIndex !== undefined) {
            args.push("--window-index", String(this.options.windowIndex));
        }

        return args;
    }
    async observe(call: DriverCall): Promise<Observation> {
        call.signal?.throwIfAborted();
        let result: AxResult;
        let seeMs = 0;
        for (;;) {
            const args = this.seeArguments();
            log.debug({ app: this.options.app, args: args.slice(1) }, "native see");
            const stopSee = prof.start("see");
            result = await (this.options.run ?? runAxAsync)({
                args,
                timeoutMs: Math.min(call.timeoutMs ?? 30000, 30000),
                signal: call.signal,
            });
            seeMs = stopSee();
            call.signal?.throwIfAborted();
            if (result.ok) {
                break;
            }

            const deeper = deeperSeeDepth(result.error);
            if (deeper !== null) {
                log.info(
                    { app: this.options.app, depth: deeper, error: result.error },
                    "AX tree too deep; retrying deeper"
                );
                this.depth = deeper;
                continue;
            }

            if (this.narrowScope(result.error)) {
                continue;
            }

            log.warn({ app: this.options.app, ms: seeMs, error: result.error }, "native see failed");
            throw new Error(result.error ?? "Observation failed.");
        }

        const parsed = observationSchema.safeParse(result);
        if (!parsed.success) {
            if (this.narrowScope(parsed.error.message)) {
                return this.observe(call);
            }

            throw parsed.error;
        }

        const observation = parsed.data;
        this.validateObservation(observation);
        this.pinned ??= observation;
        log.info(
            {
                app: this.options.app,
                appPid: observation.pid,
                window: observation.window,
                scope: observation.scope,
                elements: observation.elements.length,
                ms: seeMs,
            },
            "native see ok"
        );
        return observation;
    }
    /** Step down to the only smaller complete surface there is, once. */
    private narrowScope(error: string | undefined): boolean {
        const current = this.scope ?? this.options.scope ?? "window";
        if (current === "chrome" || !overflowsObservation(error)) {
            return false;
        }

        log.warn(
            { app: this.options.app, error: (error ?? "").slice(0, 200) },
            "window tree too large to observe whole; narrowing to the browser chrome"
        );
        this.scope = "chrome";
        return true;
    }
    validateObservation(observation: Observation): void {
        if (this.options.expectedURL !== undefined) {
            const observedURL = primaryWebArea(observation.elements)?.AXURL;
            if (observedURL !== this.options.expectedURL) {
                log.warn(
                    { app: this.options.app, expectedURL: this.options.expectedURL, observedURL },
                    "observed browser document does not match expected_url"
                );
                throw new Error("Observed browser document does not match expected_url. Task cannot continue.");
            }
        }
        if (this.pinned && !sameScope(this.pinned, observation)) {
            log.warn(
                {
                    app: this.options.app,
                    pinned: { pid: this.pinned.pid, window: this.pinned.window },
                    observed: { pid: observation.pid, window: observation.window },
                },
                "app instance or window scope changed"
            );
            throw new Error("App instance or window scope changed. Start a new task.");
        }
    }
    async act(
        call: DriverCall & {
            observation: Observation;
            candidate: Candidate;
            value?: string;
            parameters?: ActionParameters;
        }
    ): Promise<AxResult> {
        call.signal?.throwIfAborted();
        if (!this.pinned || !sameScope(this.pinned, call.observation)) {
            throw new Error("Action is outside the observed app/window.");
        }
        const admitted = candidatesFor({
            observation: call.observation,
            action: call.candidate.action,
            parameters: call.parameters,
        }).some((item) => item.element === call.candidate.element && item.id === call.candidate.id);
        if (!admitted) {
            throw new Error("Action does not match an observed allowed candidate.");
        }
        const target = call.observation.elements.find((row) => row.index === call.candidate.element);
        const webTarget = target !== undefined && hasAncestorRole(call.observation.elements, target, "AXWebArea");
        const prepare =
            this.options.prepare === true ||
            (this.options.prepare === "auto" &&
                (webTarget || ["click", "key", "type", "paste", "select"].includes(call.candidate.action)));
        let actionArgs = nativeActionArguments({
            action: call.candidate.action,
            value: call.value,
            parameters: call.parameters,
        });
        if (prepare && target && webTarget) {
            if (call.candidate.action === "set" && ["AXTextField", "AXTextArea", "AXComboBox"].includes(target.role)) {
                actionArgs = ["--action", "paste", "--text", call.value ?? "", "--format", "text", "--replace"];
            } else if (call.candidate.action === "press" && target.role === "AXLink") {
                actionArgs = ["--action", "key", "--keys", "return"];
            } else if (
                call.candidate.action === "press" &&
                ["AXButton", "AXCheckBox", "AXRadioButton", "AXSwitch"].includes(target.role)
            ) {
                actionArgs = ["--action", "key", "--keys", "space"];
            }
        }
        if (prepare && PREPARABLE_ACTIONS.has(call.candidate.action)) {
            actionArgs.push("--prepare", ...(target?.targetKey ? ["--target-key", target.targetKey] : []));
        }
        log.info(
            {
                app: this.options.app,
                candidate: call.candidate.id,
                element: call.candidate.element,
                role: target?.role,
                action: call.candidate.action,
                prepared: this.options.prepare === true,
                // The value itself never reaches the log: it may be a supplied secret.
                valueChars: call.value?.length ?? 0,
                dispatch: actionArgs[1],
            },
            "native act"
        );
        const args = [
            "act",
            "--app",
            this.options.app,
            "--snapshot",
            call.observation.snapshot,
            "--element",
            String(call.candidate.element),
            ...actionArgs,
            "--refresh",
        ];
        if (this.options.image === false) {
            args.push("--no-image");
        }
        const stopAct = prof.start("act");
        const result = await (this.options.run ?? runAxAsync)({
            args,
            timeoutMs: Math.min(call.timeoutMs ?? 30000, 30000),
            signal: call.signal,
        });
        const actMs = stopAct();
        if (result.ok) {
            log.info({ app: this.options.app, candidate: call.candidate.id, ms: actMs }, "native act ok");
        } else {
            log.warn(
                {
                    app: this.options.app,
                    candidate: call.candidate.id,
                    ms: actMs,
                    dispatchState: result.dispatchState,
                    error: result.error,
                },
                "native act failed"
            );
        }

        return result;
    }
}
