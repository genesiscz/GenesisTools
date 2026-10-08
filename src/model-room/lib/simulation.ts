import { type Expression, evaluateExpression } from "@genesiscz/utils/quantities/expression";
import { finiteValue } from "@genesiscz/utils/quantities/units";
import { type CompiledModel, type CompiledQuantity, compileModel, ModelError } from "./compiler";
import type { ModelDocument, Quantity } from "./document";

export interface SimulationFrame {
    tick: number;
    time: number;
    values: Record<string, number>;
}

export interface SimulationResult {
    scenarioId: string | null;
    frames: SimulationFrame[];
    method: "explicit-euler";
    timeUnit: string;
    step: number;
}

export class CalculationStopped extends Error {
    constructor(readonly reason: "cancelled" | "deadline") {
        super(reason === "cancelled" ? "Calculation cancelled." : "Calculation exceeded its time limit.");
        this.name = "CalculationStopped";
    }
}

export interface RunControl {
    signal?: AbortSignal;
    deadline?: number;
    now?: () => number;
}

function checkRun({ signal, deadline, now = () => performance.now() }: RunControl): void {
    if (signal?.aborted) {
        throw new CalculationStopped("cancelled");
    }

    if (deadline !== undefined && now() >= deadline) {
        throw new CalculationStopped("deadline");
    }
}

function observationAt(quantity: Extract<Quantity, { kind: "data" }>, time: number): number {
    const points = quantity.points;
    let lower = 0;
    let upper = points.length - 1;

    if (time <= points[0].time) {
        return points[0].value;
    }

    if (time >= points[upper].time) {
        return points[upper].value;
    }

    while (upper - lower > 1) {
        const middle = Math.floor((upper + lower) / 2);

        if (points[middle].time <= time) {
            lower = middle;
        } else {
            upper = middle;
        }
    }

    const before = points[lower];
    const after = points[upper];
    return quantity.interpolation === "hold"
        ? before.value
        : before.value + ((time - before.time) / (after.time - before.time)) * (after.value - before.value);
}

function historySeed(entry: CompiledQuantity): number {
    const { quantity, unit } = entry;
    let value: number;

    if (quantity.seed !== undefined) {
        value = quantity.seed;
    } else if (quantity.kind === "input") {
        value = quantity.value;
    } else if (quantity.kind === "stock") {
        value = quantity.initial;
    } else if (quantity.kind === "data") {
        value = quantity.points[0].value;
    } else {
        throw new ModelError(`Missing history seed for “${quantity.label}”.`, quantity.id);
    }

    return finiteValue(value * unit.scale);
}

/** Stocks advance from the preceding frame's rates; interventions act at the interval beginning at their timestamp. */
export function* simulationFrames({
    model,
    control = {},
}: {
    model: CompiledModel;
    control?: RunControl;
}): Generator<SimulationFrame> {
    const runControl = { ...control, deadline: control.deadline ?? (control.now?.() ?? performance.now()) + 15000 };
    const { document, scenario, quantities } = model;
    const history: Map<string, number>[] = [];
    const stockValues = new Map<string, number>();
    const overrides = new Map(Object.entries(scenario?.overrides ?? {}));
    const interventions = [...(scenario?.interventions ?? [])].sort((left, right) => left.at - right.at);
    let nextIntervention = 0;
    const stepSeconds = finiteValue(document.time.step * model.timeUnit.scale);

    for (const [id, entry] of quantities) {
        if (entry.quantity.kind === "stock") {
            stockValues.set(id, finiteValue(entry.quantity.initial * entry.unit.scale));
        }
    }

    for (let tick = 0; tick <= model.steps; tick++) {
        checkRun(runControl);
        const time = tick * document.time.step;
        while (
            nextIntervention < interventions.length &&
            Math.round(interventions[nextIntervention].at / document.time.step) <= tick
        ) {
            for (const [id, value] of Object.entries(interventions[nextIntervention].values)) {
                overrides.set(id, value);
            }
            nextIntervention++;
        }

        const values = new Map<string, number>(stockValues);
        values.set("time", finiteValue(time * model.timeUnit.scale));
        values.set("step", stepSeconds);
        for (const [id, { quantity, unit }] of quantities) {
            if (quantity.kind === "input") {
                values.set(id, finiteValue((overrides.get(id) ?? quantity.value) * unit.scale));
            } else if (quantity.kind === "data") {
                values.set(id, finiteValue(observationAt(quantity, time) * unit.scale));
            }
        }

        const context = {
            reference: (name: string): number => {
                const value = values.get(name);

                if (value === undefined) {
                    throw new ModelError(`“${name}” was not calculated before its dependent quantity.`, name);
                }

                return value;
            },
            lag: (name: string, steps: number): number => {
                const entry = quantities.get(name);

                if (!entry) {
                    throw new ModelError(`Unknown delayed quantity “${name}”.`, name);
                }

                return history[tick - steps]?.get(name) ?? historySeed(entry);
            },
        };
        const evaluate = (id: string, expression: Expression) => {
            try {
                return evaluateExpression(expression, context);
            } catch (error) {
                throw new ModelError(
                    `${quantities.get(id)?.quantity.label ?? id} at ${time} ${document.time.unit}: ${error instanceof Error ? error.message : String(error)}`,
                    id
                );
            }
        };
        for (const id of model.formulaOrder) {
            const expression = quantities.get(id)?.expression;

            if (expression) {
                values.set(id, evaluate(id, expression));
            }
        }

        history.push(values);
        const displayValues: Record<string, number> = Object.fromEntries(
            [...quantities].map(([id, entry]) => [id, finiteValue(context.reference(id) / entry.unit.scale)])
        );
        yield { tick, time, values: displayValues };

        if (tick === model.steps) {
            break;
        }

        for (const [id, entry] of quantities) {
            if (entry.quantity.kind !== "stock" || !entry.expression) {
                continue;
            }

            const next = finiteValue(context.reference(id) + evaluate(id, entry.expression) * stepSeconds);
            const lower = entry.quantity.min === undefined ? -Infinity : entry.quantity.min * entry.unit.scale;
            const upper = entry.quantity.max === undefined ? Infinity : entry.quantity.max * entry.unit.scale;
            stockValues.set(id, Math.max(lower, Math.min(upper, next)));
        }
    }
}

export function simulate({ model, control = {} }: { model: CompiledModel; control?: RunControl }): SimulationResult {
    return {
        scenarioId: model.scenario?.id ?? null,
        frames: [...simulationFrames({ model, control })],
        method: "explicit-euler",
        timeUnit: model.document.time.unit,
        step: model.document.time.step,
    };
}

export async function simulateAsync({
    model,
    control = {},
    yieldToHost = () => new Promise<void>((resolve) => setTimeout(resolve, 0)),
}: {
    model: CompiledModel;
    control?: RunControl;
    yieldToHost?: () => Promise<void>;
}): Promise<SimulationResult> {
    const frames: SimulationFrame[] = [];
    for (const frame of simulationFrames({ model, control })) {
        frames.push(frame);

        if (frame.tick % 32 === 0) {
            await yieldToHost();
            checkRun(control);
        }
    }

    return {
        scenarioId: model.scenario?.id ?? null,
        frames,
        method: "explicit-euler",
        timeUnit: model.document.time.unit,
        step: model.document.time.step,
    };
}

export interface SweepAxis {
    quantityId: string;
    values: number[];
}

export interface SweepRun {
    inputs: Record<string, number>;
    outputs: Record<string, number>;
}

export interface SweepResult {
    status: "complete" | "cancelled" | "deadline";
    total: number;
    runs: SweepRun[];
}

export async function sweepModel({
    document,
    axes,
    outputs,
    scenarioId,
    control = {},
    onRun,
    yieldToHost,
}: {
    document: ModelDocument;
    axes: SweepAxis[];
    outputs: string[];
    scenarioId?: string;
    control?: RunControl;
    onRun?: (run: SweepRun, completed: number) => void;
    yieldToHost?: () => Promise<void>;
}): Promise<SweepResult> {
    const compiled = compileModel({ input: document, scenarioId });
    const runControl = { ...control, deadline: control.deadline ?? (control.now?.() ?? performance.now()) + 60000 };
    const axisIds = new Set<string>();
    let total = 1;

    if (axes.length < 1 || axes.length > 8 || outputs.length < 1 || outputs.length > 32) {
        throw new ModelError("Select 1–8 sweep inputs and 1–32 outputs.");
    }

    for (const axis of axes) {
        if (axisIds.has(axis.quantityId) || compiled.quantities.get(axis.quantityId)?.quantity.kind !== "input") {
            throw new ModelError(`Sweep input “${axis.quantityId}” must be a unique input quantity.`);
        }

        axisIds.add(axis.quantityId);

        if (axis.values.length === 0 || axis.values.some((value) => !Number.isFinite(value))) {
            throw new ModelError("Each sweep input requires at least one finite value.");
        }

        total *= axis.values.length;
    }

    if (total > 10000) {
        throw new ModelError("A sweep may contain at most 10000 runs.");
    }

    if (outputs.some((id) => !compiled.quantities.has(id))) {
        throw new ModelError("Every sweep output must refer to an existing quantity.");
    }

    const runs: SweepRun[] = [];
    try {
        for (let index = 0; index < total; index++) {
            checkRun(runControl);
            let cursor = index;
            const inputs: Record<string, number> = Object.fromEntries(
                axes.map((axis) => {
                    const value = axis.values[cursor % axis.values.length];
                    cursor = Math.floor(cursor / axis.values.length);
                    return [axis.quantityId, value];
                })
            );
            const base = compiled.scenario;
            const model: CompiledModel = {
                ...compiled,
                scenario: {
                    id: base?.id ?? "sweep",
                    label: base?.label ?? "Sweep",
                    color: base?.color ?? "#a9c9ff",
                    description: base?.description ?? "",
                    overrides: { ...base?.overrides, ...inputs },
                    interventions: base?.interventions ?? [],
                    replacements: [],
                    removed: [],
                },
            };
            const result = await simulateAsync({ model, control: runControl, yieldToHost });
            const last = result.frames[result.frames.length - 1];
            const run = { inputs, outputs: Object.fromEntries(outputs.map((id) => [id, last.values[id]])) };
            runs.push(run);
            onRun?.(run, runs.length);
        }
    } catch (error) {
        if (error instanceof CalculationStopped) {
            return { status: error.reason, total, runs };
        }

        throw error;
    }

    return { status: "complete", total, runs };
}
