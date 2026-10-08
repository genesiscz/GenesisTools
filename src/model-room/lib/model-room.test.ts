import { describe, expect, test } from "bun:test";
import {
    evaluateExpression,
    expressionReferences,
    expressionUnit,
    parseExpression,
} from "@genesiscz/utils/quantities/expression";
import { convertValue, parseUnit, sameDimension } from "@genesiscz/utils/quantities/units";
import { parseDelimited } from "@genesiscz/utils/tabular/delimited";
import { compileModel } from "./compiler";
import { importObservationQuantity, verifyObservationDigest } from "./data-import";
import { readModelDocument } from "./document";
import { evaluateDocument } from "./evaluation";
import { classroomModel, projectBudgetModel, supportCapacityModel } from "./examples";
import { assumptionsCSV, resultsCSV, scriptJSON, serializedModel } from "./exports";
import { CalculationStopped, simulate, simulateAsync, sweepModel } from "./simulation";

function calculate(source: string): number {
    const expression = parseExpression({ source });
    expressionUnit(expression, (name) => {
        throw new Error(`Unexpected reference ${name}`);
    });
    return evaluateExpression(expression, {
        reference: (name) => {
            throw new Error(`Unexpected reference ${name}`);
        },
        lag: (name) => {
            throw new Error(`Unexpected lag ${name}`);
        },
    });
}

function formulaModel(expression: string) {
    return readModelDocument({
        format: "genesis-model-room",
        version: 1,
        id: "test_model",
        title: "Test model",
        time: { unit: "day", duration: 3, step: 1 },
        quantities: [{ id: "answer", label: "Answer", kind: "formula", expression, unit: "1", seed: 1 }],
    });
}

describe("dimensional formula language", () => {
    test("conversion and compound cancellation preserve dimensions", () => {
        expect(convertValue({ value: 2, from: parseUnit({ source: "day" }), to: parseUnit({ source: "hour" }) })).toBe(
            48
        );
        expect(
            sameDimension(parseUnit({ source: "tickets/person/day * people" }), parseUnit({ source: "tickets/day" }))
        ).toBe(true);
        expect(sameDimension(parseUnit({ source: "m^12" }), parseUnit({ source: "m^6 * m^6" }))).toBe(true);
        expect(
            convertValue({ value: 75, from: parseUnit({ source: "percent" }), to: parseUnit({ source: "1" }) })
        ).toBe(0.75);
        expect(() =>
            convertValue({ value: 1, from: parseUnit({ source: "USD" }), to: parseUnit({ source: "EUR" }) })
        ).toThrow("Incompatible units");
    });

    test.each(["unknown", "hour/", "m^", "m^17", "m^1.5", "m people", "1//day"])(
        "rejects malformed unit %s",
        (source) => {
            expect(() => parseUnit({ source })).toThrow();
        }
    );

    test.each([
        ["2 + 3 * 4", 14],
        ["(2 + 3) * 4", 20],
        ["8 / 4 / 2", 1],
        ["5 - 2 - 1", 2],
        ["-2^2", -4],
        ["(-2)^2", 4],
        ["2^-2", 0.25],
        [".5 + 1e-2", 0.51],
        ["max(abs(-4), min(7, 9))", 7],
        ["clamp(40, 2, 8)", 8],
        ["2[hour] + 30[minute]", 9000],
        ["75[percent] * 4", 3],
    ])("calculates %s", (source, expected) => {
        expect(calculate(source)).toBeCloseTo(expected, 10);
    });

    test.each([
        "",
        "2 +",
        "2 3",
        "1; alert(1)",
        "globalThis.process.exit()",
        "constructor(1)",
        "Math.max(1, 2)",
        "2[hour] + 3[people]",
        "min(1[hour], 2[people])",
        "1 / 0",
        "1e309",
        "2^0.5",
        "2^17",
        "clamp(1, 5, 2)",
        "abs(1, 2)",
        "min()",
        "lag(answer, 0)",
        "lag(answer, 1.5)",
        "lag(answer + 1, 1)",
        "lag(answer, 1[day])",
        "lag(answer, 1[percent])",
        "3[hour",
        "3[] + 4[person]",
    ])("rejects unsafe or invalid formula %s", (source) => {
        expect(() => calculate(source)).toThrow();
    });

    test("bounds parser recursion and token count", () => {
        expect(() => parseExpression({ source: `${"(".repeat(70)}1${")".repeat(70)}` })).toThrow("nested too deeply");
        expect(() => parseExpression({ source: "1+".repeat(300) })).toThrow("512 tokens");
        expect(() => parseExpression({ source: " ".repeat(4097) })).toThrow("4096 characters");
    });

    test("distinguishes delayed edges from instantaneous dependencies", () => {
        const refs = expressionReferences(parseExpression({ source: "lag(queue, 2) + arrivals - departures" }));
        expect([...refs.immediate]).toEqual(["arrivals", "departures"]);
        expect([...refs.delayed]).toEqual(["queue"]);
    });
});

describe("model compilation and deterministic time", () => {
    test("backlog example preserves baseline and the report's two interventions", () => {
        const document = supportCapacityModel();
        const baseline = simulate({ model: compileModel({ input: document }) });
        const staffing = simulate({ model: compileModel({ input: document, scenarioId: "three_agents" }) });
        const intervention = simulate({ model: compileModel({ input: document, scenarioId: "self_service" }) });
        expect(baseline.frames.map((frame) => Math.round(frame.values.backlog))).toEqual([
            80, 70, 60, 50, 40, 30, 20, 10, 0, 0, 0,
        ]);
        expect(staffing.frames[6].values.backlog).toBeCloseTo(170);
        expect(intervention.frames[4].values.backlog).toBeCloseTo(140);
        expect(intervention.frames[4].values.arrivals).toBeCloseTo(65);
        expect(intervention.frames[6].values.backlog).toBeCloseTo(120);
        expect(intervention.frames[10].values.backlog).toBeCloseTo(80);
        expect(document.quantities.find((quantity) => quantity.id === "agents")).toMatchObject({ value: 4 });
    });

    test("classroom and budget examples demonstrate real constraints", () => {
        const classroom = classroomModel();
        const room = simulate({ model: compileModel({ input: classroom, scenarioId: "extra_room" }) });
        const staff = simulate({ model: compileModel({ input: classroom, scenarioId: "extra_instructor" }) });
        expect(room.frames[12].values.taught).toBeCloseTo(72);
        expect(staff.frames[12].values.taught).toBeCloseTo(96);
        const budget = simulate({ model: compileModel({ input: projectBudgetModel() }) });
        expect(budget.frames[16].values.remaining).toBeCloseTo(-20000);
    });

    test("converts mixed units in formulas and stock integration", () => {
        const document = readModelDocument({
            format: "genesis-model-room",
            version: 1,
            id: "units",
            title: "Mixed time units",
            time: { unit: "hour", duration: 48, step: 12 },
            quantities: [
                { id: "rate", label: "Rate", kind: "input", value: 24, unit: "tickets/day" },
                { id: "total", label: "Total", kind: "stock", initial: 0, derivative: "rate", unit: "tickets" },
                { id: "elapsed", label: "Elapsed days", kind: "formula", expression: "time", unit: "day" },
            ],
        });
        const result = simulate({ model: compileModel({ input: document }) });
        expect(result.frames[4].values).toMatchObject({ total: 48, elapsed: 2 });
    });

    test("explicit delay permits feedback with declared prehistory", () => {
        const document = formulaModel("lag(answer, 1) * 2");
        const result = simulate({ model: compileModel({ input: document }) });
        expect(result.frames.map((frame) => frame.values.answer)).toEqual([2, 4, 8, 16]);
        const quantity = document.quantities[0];
        delete quantity.seed;
        expect(() => compileModel({ input: document })).toThrow("history seed");
    });

    test("rejects self cycles, longer instantaneous cycles, and unknown references", () => {
        expect(() => compileModel({ input: formulaModel("answer + 1") })).toThrow("answer → answer");
        const document = formulaModel("second + 1");
        document.quantities.push({
            ...document.quantities[0],
            id: "second",
            kind: "formula",
            expression: "answer + 1",
        });
        expect(() => compileModel({ input: document })).toThrow("answer → second → answer");
        expect(() => compileModel({ input: formulaModel("missing") })).toThrow("Unknown quantity");
    });

    test("validates units before producing charts and reports the owning quantity", () => {
        const document = supportCapacityModel();
        const capacity = document.quantities.find((quantity) => quantity.id === "capacity");

        if (capacity?.kind !== "formula") {
            throw new Error("Missing fixture capacity");
        }

        capacity.expression = "agents + productivity";
        expect(() => compileModel({ input: document })).toThrow("Service capacity: Incompatible units");
    });

    test("reports runtime errors at the relevant time and leaves documents untouched", () => {
        const model = compileModel({ input: formulaModel("1 / (2 - time / 1[day])") });
        expect(() => simulate({ model })).toThrow("Answer at 2 day");
        expect(model.document.quantities[0]).toMatchObject({ expression: "1 / (2 - time / 1[day])" });
    });

    test("data lenses use explicit interpolation and endpoint hold", () => {
        const document = formulaModel("1");
        document.quantities = [
            {
                id: "observed",
                label: "Observations",
                kind: "data",
                unit: "1",
                description: "",
                provenance: "measured",
                position: { x: 0, y: 0 },
                source: "sample.csv",
                interpolation: "linear",
                points: [
                    { time: 1, value: 10 },
                    { time: 3, value: 30 },
                ],
            },
        ];
        expect(
            simulate({ model: compileModel({ input: document }) }).frames.map((frame) => frame.values.observed)
        ).toEqual([10, 10, 20, 30]);
        const observed = document.quantities[0];

        if (observed.kind !== "data") {
            throw new Error("Missing observation fixture");
        }

        observed.interpolation = "hold";
        expect(
            simulate({ model: compileModel({ input: document }) }).frames.map((frame) => frame.values.observed)
        ).toEqual([10, 10, 10, 30]);
    });

    test("structural scenarios replace formulas and retain original equations", () => {
        const document = supportCapacityModel();
        const capacity = document.quantities.find((quantity) => quantity.id === "capacity");

        if (capacity?.kind !== "formula") {
            throw new Error("Missing fixture capacity");
        }

        document.scenarios[0].replacements = [{ ...capacity, expression: "agents * productivity * 0.5" }];
        const result = simulate({ model: compileModel({ input: document, scenarioId: "three_agents" }) });
        expect(result.frames[0].values.capacity).toBeCloseTo(37.5);
        expect(capacity.expression).toBe("agents * productivity");
    });

    test("rejects malformed identity, duplicate IDs, invalid steps, and wrong override targets", () => {
        const original = supportCapacityModel();
        expect(() => compileModel({ input: { ...original, version: 2 } })).toThrow();
        expect(() =>
            compileModel({ input: { ...original, quantities: [...original.quantities, original.quantities[0]] } })
        ).toThrow("Duplicate quantity");
        expect(() => compileModel({ input: { ...original, time: { unit: "day", duration: 10, step: 3 } } })).toThrow(
            "exact multiple"
        );
        expect(() => compileModel({ input: { ...original, time: { unit: "day", duration: 10001, step: 1 } } })).toThrow(
            "10000 steps"
        );
        original.scenarios[0].overrides = { backlog: 1 };
        expect(() => compileModel({ input: original, scenarioId: "three_agents" })).toThrow("only override inputs");
        original.scenarios[0].overrides = { agents: 3 };
        original.scenarios[0].interventions = [{ at: 1.5, label: "Between ticks", values: { agents: 2 } }];
        expect(() => compileModel({ input: original, scenarioId: "three_agents" })).toThrow("simulation step");
    });

    test("async and sync evaluation are numerically identical", async () => {
        const model = compileModel({ input: supportCapacityModel(), scenarioId: "self_service" });
        expect(await simulateAsync({ model, yieldToHost: async () => {} })).toEqual(simulate({ model }));
    });
});

describe("bounded cancellable calculations", () => {
    test("abort and deadline stop a calculation without wall-clock sleeps", () => {
        const model = compileModel({ input: supportCapacityModel() });
        const controller = new AbortController();
        controller.abort();
        expect(() => simulate({ model, control: { signal: controller.signal } })).toThrow(CalculationStopped);
        expect(() => simulate({ model, control: { deadline: 10, now: () => 10 } })).toThrow("time limit");
    });

    test("sweep preserves completed results and starts no further run after cancellation", async () => {
        const document = supportCapacityModel();
        const controller = new AbortController();
        let callbacks = 0;
        const result = await sweepModel({
            document,
            axes: [{ quantityId: "agents", values: Array.from({ length: 10000 }, (_, index) => index / 1000 + 1) }],
            outputs: ["backlog"],
            control: { signal: controller.signal },
            yieldToHost: async () => {},
            onRun: (_, count) => {
                callbacks++;

                if (count === 3) {
                    controller.abort();
                }
            },
        });
        expect(result.status).toBe("cancelled");
        expect(result.total).toBe(10000);
        expect(result.runs).toHaveLength(3);
        expect(callbacks).toBe(3);
        expect(result.runs[0].outputs.backlog).toBeCloseTo(730);
    });

    test("cancellation during a run drops the incomplete result", async () => {
        const controller = new AbortController();
        const result = await sweepModel({
            document: supportCapacityModel(),
            axes: [{ quantityId: "agents", values: [3, 4] }],
            outputs: ["backlog"],
            control: { signal: controller.signal },
            yieldToHost: async () => {
                controller.abort();
            },
        });
        expect(result).toEqual({ status: "cancelled", total: 2, runs: [] });
    });

    test("successful Cartesian sweeps return all combinations and expected sensitivity", async () => {
        const result = await sweepModel({
            document: supportCapacityModel(),
            axes: [
                { quantityId: "agents", values: [3, 4] },
                { quantityId: "arrivals", values: [80, 90] },
            ],
            outputs: ["backlog"],
            yieldToHost: async () => {},
        });
        expect(result.status).toBe("complete");
        expect(result.total).toBe(4);
        expect(result.runs.map((run) => Math.round(run.outputs.backlog))).toEqual([130, 0, 230, 0]);
    });

    test("comparison budgets include quantities added by structural scenarios", async () => {
        const document = formulaModel("1");
        document.time.duration = 10000;
        document.scenarios = Array.from({ length: 32 }, (_, index) => ({
            id: `scenario_${index}`,
            label: `Scenario ${index}`,
            description: "",
            color: "#a9c9ff",
            overrides: {},
            interventions: [],
            removed: [],
            replacements: Array.from({ length: 10 }, (_, item) => ({ ...document.quantities[0], id: `added_${item}` })),
        }));
        await expect(evaluateDocument({ input: document, control: { deadline: 0 } })).rejects.toThrow(
            "two million result values"
        );
    });

    test("oversized sweeps fail before starting work", async () => {
        await expect(
            sweepModel({
                document: supportCapacityModel(),
                axes: [{ quantityId: "agents", values: Array.from({ length: 10001 }, () => 4) }],
                outputs: ["backlog"],
            })
        ).rejects.toThrow("10000 runs");
    });
});

describe("portable model exports", () => {
    test("document rendering metadata has bounded positions, sliders and presentation times", () => {
        const document = supportCapacityModel();
        document.quantities[0].position.x = 1e12;
        expect(() => readModelDocument(document)).toThrow();
        document.quantities[0].position.x = 80;
        document.quantities[0].range = { min: -1e308, max: 1e308, step: 1 };
        expect(() => readModelDocument(document)).toThrow("representable step");
        delete document.quantities[0].range;
        document.presentation.steps[0].time = 1e300;
        expect(() => readModelDocument(document)).toThrow("outside the model time range");
    });

    test("CSV includes all scenario times with quoted cells and numeric precision", async () => {
        const document = supportCapacityModel();
        const evaluation = await evaluateDocument({ input: document });
        const csv = resultsCSV(document, evaluation.scenarios);
        expect(csv.split("\r\n").filter(Boolean)).toHaveLength(34);
        const baselineRow = csv.split("\r\n").find((row) => row.startsWith('"Baseline","6",'));
        const exportedBacklog = Number(baselineRow?.match(/,"([^"]+)"$/)?.[1]);
        expect(exportedBacklog).toBeCloseTo(20, 10);
        const calculatedBacklog = evaluation.scenarios[0].result?.frames[6].values.backlog;
        expect(calculatedBacklog).toBeDefined();

        if (calculatedBacklog === undefined) {
            throw new Error("Missing baseline output");
        }

        expect(exportedBacklog).toBe(calculatedBacklog);
        expect(csv).toContain('"Self-service on day 4","6","65","3","25","75","120"');
    });

    test("CSV preserves scenario additions, removals and changed display units", async () => {
        const document = readModelDocument({
            format: "genesis-model-room",
            version: 1,
            id: "structural_export",
            title: "Structural export",
            time: { unit: "day", duration: 1, step: 1 },
            quantities: [
                { id: "distance", label: "Distance", kind: "input", unit: "m", value: 2 },
                { id: "spare", label: "Spare", kind: "input", unit: "1", value: 7 },
            ],
            scenarios: [
                {
                    id: "variant",
                    label: "Variant",
                    removed: ["spare"],
                    replacements: [
                        { id: "distance", label: "Distance", kind: "input", unit: "cm", value: 300 },
                        { id: "bonus", label: "Bonus", kind: "input", unit: "1", value: 9 },
                    ],
                },
            ],
        });
        const evaluation = await evaluateDocument({ input: document });
        const table = parseDelimited({ source: resultsCSV(document, evaluation.scenarios) });
        expect(table.headers).toEqual([
            "Scenario",
            "Time (day)",
            "Distance (m) [distance]",
            "Spare (1) [spare]",
            "Distance (cm) [distance]",
            "Bonus (1) [bonus]",
        ]);
        expect(table.rows[0]).toEqual(["Baseline", "0", "2", "7", "", ""]);
        expect(table.rows[2]).toEqual(["Variant", "0", "", "", "300", "9"]);
    });

    test("exports neutralize spreadsheet formulas and preserve newlines and quotes", () => {
        const document = supportCapacityModel();
        document.quantities[0].label = '=HYPERLINK("https://example.com")';
        document.quantities[0].description = 'A line\nA "quote"';
        const csv = assumptionsCSV(document);
        expect(csv).toContain('"\'=HYPERLINK(""https://example.com"")"');
        expect(csv).toContain('"A line\nA ""quote"""');
    });

    test("embedded JSON cannot terminate its script element", () => {
        const input = { title: '</script><script>alert("example")</script>', line: "\u2028" };
        const encoded = scriptJSON(input);
        expect(encoded).not.toContain("<");
        expect(encoded).toContain("\\u003c/script>");
        expect(encoded).toContain("\\u2028");
    });

    test("editable export retains quantities, scenario structure and presentation", () => {
        const document = supportCapacityModel();
        const encoded = serializedModel(document);
        expect(encoded).toContain('"version": 1');
        expect(encoded).toContain('"derivative": "arrivals - capacity"');
        expect(encoded).toContain('"self_service"');
    });
});

describe("mapped observation imports", () => {
    test("a preview digest accepts its exact source and refuses changed observations", async () => {
        const text = "day,count\n0,40\n1,60";
        const digest = await verifyObservationDigest({ text });
        expect(digest).toMatch(/^[a-f0-9]{64}$/);
        expect(await verifyObservationDigest({ text, expectedDigest: digest })).toBe(digest);
        await expect(
            verifyObservationDigest({ text: "day,count\n0,40\n1,61", expectedDigest: digest })
        ).rejects.toThrow("changed after its preview");
    });

    test("reads quoted newlines, escaped quotes, BOM and CRLF without losing cells", () => {
        const table = parseDelimited({
            source: '\ufefftime,label,value\r\n0,"Two, parts",4\r\n1,"One ""quote""\nTwo lines",5\r\n',
        });
        expect(table.headers).toEqual(["time", "label", "value"]);
        expect(table.rows).toEqual([
            ["0", "Two, parts", "4"],
            ["1", 'One "quote"\nTwo lines', "5"],
        ]);
    });

    test.each(["a,a\n1,2", "a,b\n1", 'a,b\n1,"broken', 'a,b\n1,"ok"oops', 'a,b\n1,un"quoted'])(
        "rejects malformed table %s",
        (source) => {
            expect(() => parseDelimited({ source })).toThrow();
        }
    );

    test("maps explicit columns and decimal format to measured values without changing the source model", () => {
        const original = supportCapacityModel();
        const imported = importObservationQuantity({
            document: original,
            text: "day;observed\n0;80,5\n2;60,5",
            id: "actuals",
            label: "Actual backlog",
            unit: "tickets",
            sourceName: "measurements.csv",
            mapping: {
                timeColumn: "day",
                valueColumn: "observed",
                delimiter: ";",
                decimalSeparator: ",",
                interpolation: "linear",
            },
        });
        expect(original.quantities).toHaveLength(5);
        expect(imported.quantities[5]).toMatchObject({
            kind: "data",
            provenance: "measured",
            source: "measurements.csv",
        });
        const output = simulate({ model: compileModel({ input: imported }) });
        expect(output.frames[1].values.actuals).toBeCloseTo(70.5);
        expect(output.frames[10].values.actuals).toBeCloseTo(60.5);
    });

    test("refuses out-of-order times and partially numeric values without importing partial data", () => {
        const document = supportCapacityModel();
        const base = {
            document,
            id: "observed",
            label: "Observed",
            unit: "tickets",
            sourceName: "observations.csv",
            mapping: {
                timeColumn: "day",
                valueColumn: "count",
                delimiter: "," as const,
                decimalSeparator: "." as const,
                interpolation: "hold" as const,
            },
        };
        expect(() => importObservationQuantity({ ...base, text: "day,count\n1,40\n0,60" })).toThrow(
            "strictly increasing"
        );
        expect(() => importObservationQuantity({ ...base, text: "day,count\n0,40tickets" })).toThrow(
            "not a finite number"
        );
        expect(document.quantities).toHaveLength(5);
        expect(() => importObservationQuantity({ ...base, text: "day,count\n0,40\n," })).toThrow("not a finite number");
    });
});
