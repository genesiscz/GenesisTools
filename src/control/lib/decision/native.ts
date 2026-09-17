import { type AxResult, runAx } from "../runner";
import { type Candidate, candidatesFor, type Observation, observationSchema, sameScope } from "./observation";

export interface DriverCall {
    signal?: AbortSignal;
    timeoutMs?: number;
}
export interface ControlDriver {
    observe(options: DriverCall): Promise<Observation>;
    act(options: DriverCall & { observation: Observation; candidate: Candidate; value?: string }): Promise<AxResult>;
}
export class NativeControlDriver implements ControlDriver {
    private pinned?: Observation;
    constructor(private readonly options: { app: string; windowId?: number; scope?: "window" | "chrome" }) {}
    async observe(call: DriverCall): Promise<Observation> {
        call.signal?.throwIfAborted();
        const args = ["see", "--app", this.options.app, "--scope", this.options.scope ?? "window"];
        const windowId = this.pinned?.window.id ?? this.options.windowId;
        if (windowId !== undefined) {
            args.push("--window-id", String(windowId));
        }
        const result = runAx(args, Math.min(call.timeoutMs ?? 30000, 30000));
        call.signal?.throwIfAborted();
        if (!result.ok) {
            throw new Error(result.error ?? "Observation failed.");
        }
        const observation = observationSchema.parse(result);
        if (this.pinned && !sameScope(this.pinned, observation)) {
            throw new Error("App instance or window scope changed. Start a new task.");
        }
        this.pinned ??= observation;
        return observation;
    }
    async act(
        call: DriverCall & { observation: Observation; candidate: Candidate; value?: string }
    ): Promise<AxResult> {
        call.signal?.throwIfAborted();
        if (!this.pinned || !sameScope(this.pinned, call.observation)) {
            throw new Error("Action is outside the observed app/window.");
        }
        const admitted = candidatesFor({ observation: call.observation, action: call.candidate.action }).some(
            (item) => item.element === call.candidate.element && item.id === call.candidate.id
        );
        if (!admitted) {
            throw new Error("Action does not match an observed allowed candidate.");
        }
        const args = [
            "act",
            "--app",
            this.options.app,
            "--snapshot",
            call.observation.snapshot,
            "--element",
            String(call.candidate.element),
            "--action",
            call.candidate.action,
            "--refresh",
        ];
        if (call.candidate.action === "set") {
            if (call.value === undefined) {
                throw new Error("A set action requires an exact supplied value.");
            }
            args.push("--value", call.value);
        }
        return runAx(args, Math.min(call.timeoutMs ?? 30000, 30000));
    }
}
