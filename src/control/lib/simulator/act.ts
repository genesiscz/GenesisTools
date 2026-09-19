import { logger } from "@genesiscz/utils/logger";
import type { ActionParameters, ControlAction } from "../decision/action";
import { type Candidate, candidatesFor, type Observation } from "../decision/observation";
import type { AxResult } from "../runner";
import { SimulatorControlDriver, type SimulatorDriverOptions } from "./driver";
import type { SimulatorObservation } from "./observe";
import { rematchElement } from "./resolve";

const { log } = logger.scoped("control-simulator");

export interface SimulatorActRequest extends SimulatorDriverOptions {
    /** The observation the element was chosen from. Proves the element was observed, not invented. */
    chosenFrom: Observation;
    /** Index into `chosenFrom.elements`. */
    element: number;
    action: ControlAction;
    value?: string;
    parameters?: ActionParameters;
}

export interface SimulatorActResult {
    ok: boolean;
    action: ControlAction;
    /** The element as it was when chosen, and as it is in the fresh read acted on. */
    chosen: { index: number; role: string; label?: string; identifier?: string };
    resolved: { index: number; moved: boolean };
    before: SimulatorObservation;
    after?: Observation;
    error?: string;
    refusal?: string;
}

/**
 * Dispatches one act against a FRESH read of the simulator, having first found the chosen element
 * again in that read. A decision made against a screen that has since changed is refused here, so
 * nothing is ever dispatched at coordinates that used to mean something else.
 *
 * This is the one place the behaviour lives. Every door (CLI, MCP, HTTP) calls it.
 */
export async function actOnSimulator(request: SimulatorActRequest): Promise<SimulatorActResult> {
    const chosen = request.chosenFrom.elements.find((row) => row.index === request.element);
    if (!chosen) {
        throw new Error(`Element ${request.element} is not in the supplied observation.`);
    }
    const driver = new SimulatorControlDriver(request);
    const before = await driver.observe({});
    const rematch = rematchElement({ chosen, fresh: before });
    const candidate: Candidate | undefined = candidatesFor({
        observation: before,
        action: request.action,
        parameters: request.parameters,
    }).find((item) => item.element === rematch.row.index);
    if (!candidate) {
        return {
            ok: false,
            action: request.action,
            chosen: {
                index: chosen.index,
                role: chosen.role,
                label: chosen.AXDescription,
                identifier: chosen.AXIdentifier,
            },
            resolved: { index: rematch.row.index, moved: rematch.moved },
            before,
            refusal: "action_not_allowed",
            error: `"${request.action}" is not an allowed action on this element (role ${rematch.row.role}).`,
        };
    }
    log.info(
        {
            element: rematch.row.index,
            moved: rematch.moved,
            action: request.action,
            identifier: rematch.row.AXIdentifier,
        },
        "simulator act resolved against a fresh read"
    );
    const result: AxResult = await driver.act({
        observation: before,
        candidate,
        value: request.value,
        parameters: request.parameters,
    });
    return {
        ok: result.ok,
        action: request.action,
        chosen: {
            index: chosen.index,
            role: chosen.role,
            label: chosen.AXDescription,
            identifier: chosen.AXIdentifier,
        },
        resolved: { index: rematch.row.index, moved: rematch.moved },
        before,
        after: result.after as Observation | undefined,
        ...(result.error ? { error: String(result.error) } : {}),
        ...(result.refusal ? { refusal: String(result.refusal) } : {}),
    };
}
