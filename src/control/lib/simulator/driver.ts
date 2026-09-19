import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { profiler } from "@genesiscz/utils/profile";
import { Stopwatch } from "@genesiscz/utils/Stopwatch";
import { type ActionParameters, actionParametersSchema, type ControlAction } from "../decision/action";
import { admittedTarget, type ControlDriver, type DriverCall } from "../decision/native";
import {
    type Candidate,
    type Observation,
    type ObservedElement,
    observedRows,
    sameScope,
} from "../decision/observation";
import type { AxResult } from "../runner";
import { type Frame, frameCentre } from "./elements";
import { describePoint, type IdbVerb, runIdb } from "./idb";
import { observeSimulator, type SimulatorObservation } from "./observe";
import { staleRefusalReason } from "./resolve";
import { resolveDevice, runningPid, type SimDevice } from "./simctl";

const { log } = logger.scoped("control-simulator");
const prof = profiler.scope("control-simulator");

/** HID usage-page-7 codes, the only key names a simulator act may use. */
export const KEY_CODES: Record<string, number> = {
    return: 40,
    enter: 40,
    escape: 41,
    esc: 41,
    backspace: 42,
    delete: 42,
    tab: 43,
    space: 44,
    right: 79,
    left: 80,
    down: 81,
    up: 82,
};

/** Actions a simulator can genuinely perform. Everything else is refused by name. */
export const SIMULATOR_ACTIONS: ReadonlySet<ControlAction> = new Set<ControlAction>([
    "press",
    "click",
    "focus",
    "type",
    "key",
    "scroll",
]);

export class UnsupportedSimulatorAction extends Error {
    constructor(action: ControlAction) {
        super(
            `Simulator control does not support "${action}". Supported: ${[...SIMULATOR_ACTIONS].sort().join(", ")}.`
        );
        this.name = "UnsupportedSimulatorAction";
    }
}

export function rowFrame(row: ObservedElement): Frame {
    const values = [row.x, row.y, row.width, row.height];
    if (!values.every((value) => typeof value === "number" && Number.isFinite(value))) {
        throw new Error("Observed simulator element carries no frame; it cannot be acted on.");
    }
    return { x: Number(row.x), y: Number(row.y), width: Number(row.width), height: Number(row.height) };
}

/**
 * A scroll is a swipe in the OPPOSITE direction: dragging content up scrolls the view down. The
 * travel is clamped to the element's own frame, so a scroll can never start or end on a surface
 * the caller did not observe.
 */
export function swipeForScroll(options: {
    frame: Frame;
    direction: "up" | "down" | "left" | "right";
    pixels?: number;
    pages?: number;
}): { fromX: number; fromY: number; toX: number; toY: number } {
    const { frame, direction } = options;
    const centre = frameCentre(frame);
    const vertical = direction === "up" || direction === "down";
    const span = vertical ? frame.height : frame.width;
    const requested = options.pixels ?? (options.pages ?? 1) * span * 0.75;
    // The 0.8 cap is applied LAST so it always wins. With the floor outermost, a frame under 25
    // points tall took the 20-point minimum and put both endpoints outside the frame the caller
    // asked to scroll, which is a swipe across a surface nobody observed.
    const travel = Math.min(Math.max(20, requested), span * 0.8);
    const half = travel / 2;
    const sign = direction === "down" || direction === "right" ? -1 : 1;
    return vertical
        ? { fromX: centre.x, fromY: centre.y - sign * half, toX: centre.x, toY: centre.y + sign * half }
        : { fromX: centre.x - sign * half, fromY: centre.y, toX: centre.x + sign * half, toY: centre.y };
}

export function verbsForAction(options: {
    action: ControlAction;
    frame: Frame;
    value?: string;
    parameters?: ActionParameters;
}): IdbVerb[] {
    const { action, frame } = options;
    if (!SIMULATOR_ACTIONS.has(action)) {
        throw new UnsupportedSimulatorAction(action);
    }
    const parameters = actionParametersSchema.parse(options.parameters ?? {});
    const centre = frameCentre(frame);
    switch (action) {
        case "press":
        case "click":
        case "focus":
            if (options.value !== undefined) {
                throw new Error(`${action} does not accept a supplied value.`);
            }
            return [{ kind: "tap", x: centre.x, y: centre.y }];
        case "type": {
            if (options.value === undefined) {
                throw new Error("type requires an exact supplied value.");
            }
            if (options.value.length > 256 || /[\r\n]/.test(options.value)) {
                throw new Error("type requires at most 256 single-line UTF-16 units.");
            }
            // Focus first: idb sends text to whatever the device has focused, so an unfocused
            // field would silently swallow the keystrokes.
            return [
                { kind: "tap", x: centre.x, y: centre.y },
                { kind: "text", text: options.value },
            ];
        }
        case "key": {
            if (!parameters.keys) {
                throw new Error("key requires parameters.keys.");
            }
            const codes = parameters.keys
                .split("+")
                .map((name) => name.trim().toLowerCase())
                .map((name) => {
                    const code = KEY_CODES[name];
                    if (code === undefined) {
                        throw new Error(
                            `Unknown simulator key "${name}". Known: ${Object.keys(KEY_CODES).sort().join(", ")}.`
                        );
                    }
                    return code;
                });
            return [
                codes.length === 1 ? { kind: "key", keycode: codes[0] } : { kind: "key-sequence", keycodes: codes },
            ];
        }
        case "scroll": {
            if (!parameters.direction) {
                throw new Error("scroll requires parameters.direction.");
            }
            if (parameters.pages !== undefined && parameters.pixels !== undefined) {
                throw new Error("scroll takes at most one of pages/pixels.");
            }
            return [
                {
                    kind: "swipe",
                    ...swipeForScroll({
                        frame,
                        direction: parameters.direction,
                        pixels: parameters.pixels,
                        pages: parameters.pages,
                    }),
                },
            ];
        }
        default:
            throw new UnsupportedSimulatorAction(action);
    }
}

export interface SimulatorDriverOptions {
    /** Device udid or name. Resolved on first use; a single booted device needs no hint. */
    udid?: string;
    /** Bundle id under test. Gives the observation a real pid, so an app swap is detectable. */
    bundleId?: string;
    pid?: number;
    probe?: boolean;
    probeStep?: number;
    probeConcurrency?: number;
    maxProbePoints?: number;
}

/**
 * Drives a booted iOS simulator through idb, producing the same `Observation` the macOS driver
 * produces. Nothing above this class knows the screen is a simulator.
 *
 * Staleness is this driver's own responsibility. `src/control` treats `Observation.snapshot` as an
 * opaque string and never inspects it; the macOS driver gets its freshness guarantee from a
 * SHA-256 tree digest inside `ax-tool`. Here the equivalent guard is a hit test at the exact point
 * about to be tapped: if the element there is no longer the element that was decided on, the
 * action is refused as `not_started` instead of landing on whatever moved into its place.
 */
/** How long an iOS transition is given to finish before the screen is read back again. */
export const SETTLE_WAIT_MS = 400;

/** Two observations of the same screen, compared the way the freshness gate compares them. */
function sameScreen(left: Observation, right: Observation): boolean {
    return SafeJSON.stringify(observedRows(left)) === SafeJSON.stringify(observedRows(right));
}

export class SimulatorControlDriver implements ControlDriver {
    private pinned?: Observation;
    private device?: SimDevice;

    constructor(private readonly options: SimulatorDriverOptions = {}) {}

    async resolveDevice(signal?: AbortSignal): Promise<SimDevice> {
        this.device ??= await resolveDevice({ udid: this.options.udid, signal });
        return this.device;
    }

    /**
     * Re-read on every observation, never cached: a relaunched app gets a new pid, and that is
     * exactly the change `sameScope` must notice and refuse to keep acting through.
     */
    private async appPid(udid: string, signal?: AbortSignal): Promise<number | undefined> {
        if (this.options.pid !== undefined) {
            return this.options.pid;
        }
        if (!this.options.bundleId) {
            return undefined;
        }
        return runningPid({ udid, bundleId: this.options.bundleId, signal });
    }

    async observe(call: DriverCall): Promise<SimulatorObservation> {
        call.signal?.throwIfAborted();
        const device = await this.resolveDevice(call.signal);
        const observation = await observeSimulator({
            udid: device.udid,
            deviceName: device.name,
            pid: await this.appPid(device.udid, call.signal),
            probe: this.options.probe,
            probeStep: this.options.probeStep,
            probeConcurrency: this.options.probeConcurrency,
            maxProbePoints: this.options.maxProbePoints,
            signal: call.signal,
            timeoutMs: call.timeoutMs,
        });
        this.validateObservation(observation);
        this.pinned ??= observation;
        return observation;
    }

    validateObservation(observation: Observation): void {
        if (this.pinned && !sameScope(this.pinned, observation)) {
            log.warn(
                { pinned: this.pinned.window, observed: observation.window },
                "foreground app changed under the simulator task"
            );
            throw new Error("Simulator foreground app changed. Start a new task.");
        }
    }

    /**
     * One hit test at the point about to be tapped. Returns the reason to refuse, or `undefined`
     * when the decided element is still there.
     */
    private async staleReason(options: {
        udid: string;
        target: ObservedElement;
        frame: Frame;
        signal?: AbortSignal;
        timeoutMs: number;
    }): Promise<string | undefined> {
        const centre = frameCentre(options.frame);
        const present = await describePoint({
            udid: options.udid,
            x: centre.x,
            y: centre.y,
            signal: options.signal,
            timeoutMs: options.timeoutMs,
        });
        return staleRefusalReason(options.target, present);
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
        const target = admittedTarget({
            pinned: this.pinned,
            observation: call.observation,
            candidate: call.candidate,
            parameters: call.parameters,
            surface: "simulator app",
        });
        if (!target) {
            throw new Error("Observed element is no longer in the snapshot being acted on.");
        }

        const device = await this.resolveDevice(call.signal);
        const frame = rowFrame(target);
        const verbs = verbsForAction({
            action: call.candidate.action,
            frame,
            value: call.value,
            parameters: call.parameters,
        });
        const clock = new Stopwatch();
        const deadlineMs = Math.max(1, Math.floor(call.timeoutMs ?? 30_000));
        const remaining = () => Math.max(1, deadlineMs - Math.floor(clock.elapsedMs));

        // A screen-level scroll or key has no single point to hit-test, and its target is the
        // window itself, which cannot be replaced without `sameScope` already refusing.
        if (call.candidate.action !== "scroll" && call.candidate.action !== "key") {
            const stale = await this.staleReason({
                udid: device.udid,
                target,
                frame,
                signal: call.signal,
                timeoutMs: Math.min(10_000, remaining()),
            });
            if (stale) {
                log.warn(
                    { candidate: call.candidate.id, element: target.index, stale },
                    "simulator act refused as stale"
                );
                return {
                    ok: false,
                    dispatchState: "not_started",
                    refusal: "stale_observation",
                    error: `Refused: ${stale}. Observe again.`,
                };
            }
        }

        log.info(
            {
                udid: device.udid,
                bundleId: this.options.bundleId,
                candidate: call.candidate.id,
                element: call.candidate.element,
                role: target.role,
                action: call.candidate.action,
                identifier: target.AXIdentifier,
                // The value itself never reaches the log: it may be a supplied secret.
                valueChars: call.value?.length ?? 0,
                verbs: verbs.map((verb) => verb.kind),
            },
            "simulator act"
        );
        const stop = prof.start("act");
        for (const [position, verb] of verbs.entries()) {
            const outcome = await runIdb(verb, {
                udid: device.udid,
                signal: call.signal,
                timeoutMs: remaining(),
            });
            if (!outcome.ok) {
                stop();
                return {
                    ok: false,
                    dispatchState: position === 0 ? "not_started" : "uncertain",
                    error: outcome.error ?? `idb ${verb.kind} failed`,
                };
            }
        }
        const dispatchMs = stop();
        // `ok` means dispatched. What actually changed is only what the readback below shows.
        //
        // iOS animates a navigation push over roughly a third of a second, and this readback used
        // to fire the instant idb returned, so it photographed the screen the act was leaving. The
        // judge then saw the OLD screen, could not confirm the outcome, and the loop acted again:
        // opening a conversation tapped it once to open it and once more into contact details.
        //
        // An unchanged readback is the suspicious one, so only that case pays for a second look.
        // A screen that really did change is already the new screen and costs nothing extra.
        let after = await this.observe({ signal: call.signal, timeoutMs: remaining() });
        if (sameScreen(call.observation, after) && remaining() > SETTLE_WAIT_MS * 2) {
            await Bun.sleep(SETTLE_WAIT_MS);
            const settled = await this.observe({ signal: call.signal, timeoutMs: remaining() });
            if (!sameScreen(after, settled)) {
                log.info({ udid: device.udid, candidate: call.candidate.id }, "screen settled after the act");
            }

            after = settled;
        }
        log.info(
            { udid: device.udid, candidate: call.candidate.id, ms: Math.round(dispatchMs) },
            "simulator act dispatched"
        );
        return { ok: true, dispatchState: "completed", after };
    }
}
