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
export class NativeControlDriver implements ControlDriver {
    private pinned?: Observation;
    constructor(
        private readonly options: {
            app: string;
            windowId?: number;
            scope?: "window" | "chrome";
            image?: boolean;
            prepare?: boolean | "auto";
            expectedURL?: string;
            run?: typeof runAxAsync;
        }
    ) {}
    async observe(call: DriverCall): Promise<Observation> {
        call.signal?.throwIfAborted();
        const args = ["see", "--app", this.options.app, "--scope", this.options.scope ?? "window"];
        if (this.options.image === false) {
            args.push("--no-image");
        }
        const windowId = this.pinned?.window.id ?? this.options.windowId;
        if (windowId !== undefined) {
            args.push("--window-id", String(windowId));
        }
        const result = await (this.options.run ?? runAxAsync)({
            args,
            timeoutMs: Math.min(call.timeoutMs ?? 30000, 30000),
            signal: call.signal,
        });
        call.signal?.throwIfAborted();
        if (!result.ok) {
            throw new Error(result.error ?? "Observation failed.");
        }
        const observation = observationSchema.parse(result);
        this.validateObservation(observation);
        this.pinned ??= observation;
        return observation;
    }
    validateObservation(observation: Observation): void {
        if (this.options.expectedURL !== undefined) {
            if (primaryWebArea(observation.elements)?.AXURL !== this.options.expectedURL) {
                throw new Error("Observed browser document does not match expected_url. Task cannot continue.");
            }
        }
        if (this.pinned && !sameScope(this.pinned, observation)) {
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
        return (this.options.run ?? runAxAsync)({
            args,
            timeoutMs: Math.min(call.timeoutMs ?? 30000, 30000),
            signal: call.signal,
        });
    }
}
