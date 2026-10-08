import {
    type Expression,
    expressionReferences,
    expressionUnit,
    parseExpression,
} from "@genesiscz/utils/quantities/expression";
import {
    divideUnits,
    parseUnit,
    QuantityError,
    requireSameDimension,
    type Unit,
} from "@genesiscz/utils/quantities/units";
import { type ModelDocument, type Quantity, readModelDocument, type Scenario, scenarioDocument } from "./document";

export class ModelError extends Error {
    readonly quantityId?: string;

    constructor(message: string, quantityId?: string) {
        super(message);
        this.name = "ModelError";
        this.quantityId = quantityId;
    }
}

export interface CompiledQuantity {
    quantity: Quantity;
    unit: Unit;
    expression?: Expression;
    references: { immediate: Set<string>; delayed: Set<string> };
}

export interface CompiledModel {
    document: ModelDocument;
    scenario?: Scenario;
    quantities: Map<string, CompiledQuantity>;
    formulaOrder: string[];
    timeUnit: Unit;
    steps: number;
}

export function compileModel({ input, scenarioId }: { input: unknown; scenarioId?: string }): CompiledModel {
    const original = readModelDocument(input);
    const scenarioIds = new Set<string>();
    for (const scenario of original.scenarios) {
        if (scenarioIds.has(scenario.id)) {
            throw new ModelError(`Duplicate scenario identifier “${scenario.id}”.`);
        }

        scenarioIds.add(scenario.id);
    }

    const originalIds = new Set<string>();
    for (const quantity of original.quantities) {
        if (originalIds.has(quantity.id)) {
            throw new ModelError(`Duplicate quantity identifier “${quantity.id}”.`, quantity.id);
        }

        originalIds.add(quantity.id);
    }

    const { document, scenario } = scenarioDocument(original, scenarioId);
    const timeUnit = parseUnit({ source: document.time.unit });
    requireSameDimension(timeUnit, parseUnit({ source: "s" }));
    const steps = Math.round(document.time.duration / document.time.step);

    if (
        steps < 1 ||
        steps > 10000 ||
        Math.abs(steps * document.time.step - document.time.duration) > document.time.duration * 1e-10
    ) {
        throw new ModelError("Choose a duration that is an exact multiple of the time step, with 1 to 10000 steps.");
    }

    if (document.quantities.length > 256 || (steps + 1) * document.quantities.length > 2_000_000) {
        throw new ModelError("This run exceeds the limit of 256 quantities or two million result values.");
    }

    const quantities = new Map<string, CompiledQuantity>();
    for (const quantity of document.quantities) {
        try {
            const unit = parseUnit({ source: quantity.unit });
            const source =
                quantity.kind === "formula"
                    ? quantity.expression
                    : quantity.kind === "stock"
                      ? quantity.derivative
                      : undefined;
            const expression = source ? parseExpression({ source }) : undefined;
            const references = expression
                ? expressionReferences(expression)
                : { immediate: new Set<string>(), delayed: new Set<string>() };

            if (quantity.range && quantity.range.min >= quantity.range.max) {
                throw new QuantityError("An input range must have a minimum below its maximum.");
            }

            if (quantity.kind === "stock") {
                if ((quantity.min ?? -Infinity) > quantity.initial || (quantity.max ?? Infinity) < quantity.initial) {
                    throw new QuantityError("The initial stock must be within its declared limits.");
                }
            }

            if (quantity.kind === "data") {
                for (let i = 1; i < quantity.points.length; i++) {
                    if (quantity.points[i].time <= quantity.points[i - 1].time) {
                        throw new QuantityError("Observation times must be strictly increasing, with no duplicates.");
                    }
                }
            }

            quantities.set(quantity.id, { quantity, unit, expression, references });
        } catch (error) {
            throw new ModelError(
                `${quantity.label}: ${error instanceof Error ? error.message : String(error)}`,
                quantity.id
            );
        }
    }

    const lookup = (name: string): Unit => {
        if (name === "time" || name === "step") {
            return timeUnit;
        }

        const entry = quantities.get(name);

        if (!entry) {
            throw new QuantityError(`Unknown quantity “${name}”.`);
        }

        return entry.unit;
    };
    for (const [id, entry] of quantities) {
        try {
            if (entry.expression) {
                const expected = entry.quantity.kind === "stock" ? divideUnits(entry.unit, timeUnit) : entry.unit;
                requireSameDimension(expressionUnit(entry.expression, lookup), expected);
            }

            for (const delayed of entry.references.delayed) {
                const target = quantities.get(delayed)?.quantity;

                if (!target) {
                    throw new QuantityError(`lag requires a quantity, not “${delayed}”.`);
                }

                if (target.kind === "formula" && target.seed === undefined) {
                    throw new QuantityError(
                        `“${target.label}” needs an explicit history seed before it can be delayed.`
                    );
                }
            }
        } catch (error) {
            throw new ModelError(
                `${entry.quantity.label}: ${error instanceof Error ? error.message : String(error)}`,
                id
            );
        }
    }

    const order: string[] = [];
    const state = new Map<string, "visiting" | "done">();
    const stack: string[] = [];
    const visit = (id: string) => {
        const entry = quantities.get(id);

        if (entry?.quantity.kind !== "formula" || state.get(id) === "done") {
            return;
        }

        if (state.get(id) === "visiting") {
            const cycle = [...stack.slice(stack.indexOf(id)), id].join(" → ");
            throw new ModelError(`Instantaneous cycle: ${cycle}. Insert an explicit lag or a stock.`, id);
        }

        state.set(id, "visiting");
        stack.push(id);
        entry.references.immediate.forEach(visit);
        stack.pop();
        state.set(id, "done");
        order.push(id);
    };
    quantities.forEach((_, id) => {
        visit(id);
    });

    if (scenario) {
        const validateValues = (values: Record<string, number>) => {
            for (const id of Object.keys(values)) {
                if (quantities.get(id)?.quantity.kind !== "input") {
                    throw new ModelError(`Scenario values can only override inputs; “${id}” is not an input.`, id);
                }
            }
        };
        validateValues(scenario.overrides);
        scenario.interventions.forEach((intervention) => {
            if (intervention.at > document.time.duration) {
                throw new ModelError(`Intervention “${intervention.label}” is outside the model's time range.`);
            }

            const tick = intervention.at / document.time.step;

            if (Math.abs(tick - Math.round(tick)) > 1e-9) {
                throw new ModelError(`Intervention “${intervention.label}” must fall on a simulation step.`);
            }

            validateValues(intervention.values);
        });
    }

    return { document, scenario, quantities, formulaOrder: order, timeUnit, steps };
}
