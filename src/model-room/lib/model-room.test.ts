import { describe, expect, test } from "bun:test";
import { SafeJSON } from "@genesiscz/utils/json";
import {
    evaluateExpression,
    expressionReferences,
    expressionUnit,
    parseExpression,
    rewriteExpressionReferences,
} from "@genesiscz/utils/quantities/expression";
import { convertValue, parseUnit, sameDimension } from "@genesiscz/utils/quantities/units";
import { parseDelimited } from "@genesiscz/utils/tabular/delimited";
import { skip } from "@genesiscz/utils/test/skip";
import { compileModel } from "./compiler";
import { importObservationQuantity, verifyObservationDigest } from "./data-import";
import { readModelDocument } from "./document";
import { convertModelTime } from "./document-operations";
import { comparisonValue, evaluateDocument } from "./evaluation";
import { classroomModel, projectBudgetModel, supportCapacityModel } from "./examples";
import { assumptionsCSV, resultsCSV, scriptJSON, serializedModel } from "./exports";
import { inspectModelProposal, resolveModelProposal } from "./proposal";
import { CalculationStopped, simulate, simulateAsync, sweepModel } from "./simulation";
import {
    extractSubsystem,
    importSubsystem,
    inspectSubsystemSelection,
    readSubsystemPackage,
    subsystemBindingChoices,
} from "./subsystems";

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

describe("document time conversion", () => {
    test("converts schedules, presentation jumps and measurements without changing simulated quantities", async () => {
        const original = supportCapacityModel();
        original.quantities.push({
            id: "observed",
            label: "Observed",
            unit: "tickets",
            kind: "data",
            points: [
                { time: 0, value: 80 },
                { time: 6, value: 20 },
            ],
            interpolation: "linear",
            source: "fixture",
            description: "",
            provenance: "measured",
            position: { x: 0, y: 0 },
        });
        const converted = convertModelTime({ input: original, unit: "hour" });
        expect(original.time.unit).toBe("day");
        expect(converted.time).toEqual({ unit: "hour", duration: 240, step: 24 });
        expect(converted.scenarios[1].interventions[0].at).toBe(96);
        expect(converted.presentation.steps[0].time).toBe(144);
        const measured = converted.quantities.find((quantity) => quantity.id === "observed");
        expect(measured?.kind === "data" ? measured.points[1].time : undefined).toBe(144);
        const before = await evaluateDocument({ input: original });
        const after = await evaluateDocument({ input: converted });
        for (let index = 0; index < before.scenarios.length; index++) {
            expect(after.scenarios[index].result?.frames.map((frame) => frame.values)).toEqual(
                before.scenarios[index].result?.frames.map((frame) => frame.values)
            );
        }
        expect(() => convertModelTime({ input: original, unit: "m" })).toThrow("Incompatible units");
    });
});

describe("portable model exports", () => {
    test("presentation quantity references reject missing IDs and retain scenario-only IDs", async () => {
        const document = supportCapacityModel();
        for (const field of ["controls", "outputs"] as const) {
            const invalid = structuredClone(document);
            invalid.presentation[field] = ["missing_quantity"];
            expect(() => readModelDocument(invalid)).toThrow("unknown quantity");
            await expect(evaluateDocument({ input: invalid })).rejects.toThrow("unknown quantity");
        }

        document.scenarios[0].replacements.push({
            ...document.quantities[0],
            id: "branch_only",
            label: "Branch only",
        });
        document.presentation.controls = ["branch_only"];
        document.presentation.outputs = ["branch_only"];
        expect(readModelDocument(document).presentation.outputs).toEqual(["branch_only"]);
        const evaluation = await evaluateDocument({ input: document });
        expect(evaluation.scenarios[1].result?.frames[0].values.branch_only).toBeDefined();
        document.scenarios[0].removed.push("branch_only");
        expect(() => readModelDocument(document)).toThrow("unknown quantity");
    });

    test("scenario metadata treats a removed inherited-name quantity as absent", async () => {
        const document = readModelDocument({
            format: "genesis-model-room",
            version: 1,
            id: "inherited_metadata",
            title: "Inherited metadata",
            time: { unit: "day", duration: 1, step: 1 },
            quantities: [
                { id: "toString", label: "Assumption", kind: "input", unit: "1", value: 2 },
                { id: "spare", label: "Spare", kind: "input", unit: "1", value: 3 },
            ],
            scenarios: [{ id: "removed", label: "Removed", removed: ["toString"] }],
        });
        const { scenarios } = await evaluateDocument({ input: document });
        const id: string = "toString";
        expect(scenarios[0].quantities[id]).toMatchObject({ label: "Assumption", unit: "1" });
        expect(scenarios[1].quantities[id]).toBeUndefined();
        expect(
            comparisonValue({ value: 2, source: scenarios[1].quantities[id], target: scenarios[0].quantities[id] })
        ).toBeUndefined();
    });

    test("presentation steps accept known branches and reject unknown branches", async () => {
        const document = supportCapacityModel();
        document.presentation.steps = [{ title: "Branch", text: "", scenario: document.scenarios[0].id }];
        expect(readModelDocument(document).presentation.steps[0].scenario).toBe(document.scenarios[0].id);
        document.presentation.steps[0].scenario = "missing_branch";
        expect(() => readModelDocument(document)).toThrow("unknown scenario");
        await expect(evaluateDocument({ input: document })).rejects.toThrow("unknown scenario");
    });

    test("wide CSV rejects sparse scenario expansion before allocating its cells", async () => {
        const document = readModelDocument({
            format: "genesis-model-room",
            version: 1,
            id: "sparse",
            title: "Sparse branches",
            time: { unit: "day", duration: 309, step: 1 },
            quantities: [{ id: "base", label: "Base", kind: "input", unit: "1", value: 1 }],
            scenarios: Array.from({ length: 8 }, (_, branch) => ({
                id: `branch_${branch}`,
                label: `Branch ${branch}`,
                replacements: Array.from({ length: 100 }, (_, column) => ({
                    id: `value_${branch}_${column}`,
                    label: `Value ${branch} ${column}`,
                    kind: "input",
                    unit: "1",
                    value: column,
                })),
            })),
        });
        const evaluation = await evaluateDocument({ input: document });
        expect(evaluation.scenarios.every((scenario) => scenario.result)).toBe(true);
        expect(() => resultsCSV(document, evaluation.scenarios)).toThrow("CSV exceeds two million cells");
    });

    test.skipIf(skip.e2e)(
        "offline HTML preserves branch focus, inherited-name inputs and downloadable remixes",
        async () => {
            const { chromium } = await import("@playwright/test");
            const { standaloneModelHTML } = await import("./html-export");
            const document = readModelDocument({
                format: "genesis-model-room",
                version: 1,
                id: "offline",
                title: "Offline fixture",
                time: { unit: "day", duration: 1, step: 1 },
                quantities: [
                    { id: "toString", label: "Assumption", kind: "input", unit: "1", value: 2 },
                    { id: "outcome", label: "Outcome", kind: "formula", unit: "1", expression: "10 / toString" },
                ],
                scenarios: [
                    { id: "branch", label: "Branch" },
                    {
                        id: "without_assumption",
                        label: "Without assumption",
                        removed: ["toString", "outcome"],
                        replacements: [{ id: "spare", label: "Spare", kind: "input", unit: "1", value: 3 }],
                    },
                ],
                presentation: { controls: ["toString"], outputs: ["outcome", "toString"], steps: [] },
            });
            const html = await standaloneModelHTML(document);
            const browser = await chromium.launch();
            try {
                const context = await browser.newContext({ offline: true, acceptDownloads: true });
                const page = await context.newPage();
                const errors: string[] = [];
                const requests: string[] = [];
                page.on("pageerror", (error) => errors.push(error.message));
                page.on("request", (request) => requests.push(request.url()));
                await page.setContent(html);
                await page.getByRole("status").filter({ hasText: "Ready" }).waitFor();
                expect(await page.locator('[data-quantity="outcome"]').getAttribute("data-value")).toBe("5");
                const scenario = page.getByRole("combobox", { name: "Scenario to edit" });
                await scenario.focus();
                await scenario.selectOption("branch");
                expect(await scenario.evaluate((node) => node === node.ownerDocument.activeElement)).toBe(true);
                expect(await page.locator("#toString").inputValue()).toBe("2");
                await page.locator("#toString").fill("4");
                await page.waitForFunction(
                    () =>
                        globalThis.document.querySelector('[data-quantity="outcome"]')?.getAttribute("data-value") ===
                        "2.5"
                );
                const downloadPromise = page.waitForEvent("download");
                await page.getByRole("button", { name: "Remix this model" }).click();
                const download = await downloadPromise;
                const stream = await download.createReadStream();
                if (!stream) {
                    throw new Error("Remix download has no readable contents.");
                }

                let text = "";
                for await (const chunk of stream) {
                    text += typeof chunk === "string" ? chunk : chunk.toString("utf8");
                }

                const remix = readModelDocument(SafeJSON.parse(text, { strict: true }));
                expect(Object.entries(remix.scenarios[0].overrides).find(([id]) => id === "toString")?.[1]).toBe(4);
                expect(remix.quantities[0]).toMatchObject({ value: 2 });
                await page.locator("#toString").fill("0");
                await page.getByRole("status").filter({ hasText: "finite" }).waitFor();
                expect(await page.locator('[data-quantity="outcome"]').count()).toBe(0);
                await scenario.selectOption("");
                await page.locator("#toString").fill("0");
                await page.getByRole("status").filter({ hasText: "Last valid results are retained" }).waitFor();
                expect(await page.locator('[data-quantity="outcome"]').getAttribute("data-value")).toBe("5");
                await page.getByRole("button", { name: "Reset", exact: true }).click();
                await page.getByRole("status").filter({ hasText: "Ready" }).waitFor();
                expect(await page.locator("#toString").inputValue()).toBe("2");
                await page.getByRole("combobox", { name: "Chart quantity" }).selectOption("toString");
                await scenario.selectOption("without_assumption");
                expect(
                    await page
                        .getByRole("combobox", { name: "Chart quantity" })
                        .locator('option[value="toString"]')
                        .textContent()
                ).toBe("Assumption · 1");
                expect(await page.locator("svg polyline").count()).toBe(2);
                await page.getByText("Inspect every result", { exact: true }).click();
                expect(await page.locator("table").textContent()).toContain("Absent or incompatible quantity");
                expect(errors).toEqual([]);
                expect(requests).toEqual([]);
            } finally {
                await browser.close();
            }
        },
        20_000
    );

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

    test("scenario metadata keeps changed-unit comparisons and graph relationships truthful", async () => {
        const document = readModelDocument({
            format: "genesis-model-room",
            version: 1,
            id: "unit_branches",
            title: "Unit branches",
            time: { unit: "day", duration: 1, step: 1 },
            quantities: [{ id: "length", label: "Length", kind: "input", unit: "m", value: 2 }],
            scenarios: [
                {
                    id: "centimetres",
                    label: "Centimetres",
                    replacements: [
                        { id: "length", label: "Length", kind: "input", unit: "cm", value: 300 },
                        { id: "doubled", label: "Doubled", kind: "formula", unit: "cm", expression: "length * 2" },
                    ],
                },
                {
                    id: "different_dimension",
                    label: "Different dimension",
                    replacements: [{ id: "length", label: "Duration", kind: "input", unit: "hour", value: 3 }],
                },
            ],
        });
        const { scenarios } = await evaluateDocument({ input: document });
        const baseline = scenarios[0].quantities.length;
        expect(comparisonValue({ value: 300, source: scenarios[1].quantities.length, target: baseline })).toBe(3);
        expect(comparisonValue({ value: 3, source: scenarios[2].quantities.length, target: baseline })).toBeUndefined();
        expect(scenarios[1].relationships).toEqual([{ source: "length", target: "doubled", delayed: false }]);
        expect(scenarios[0].relationships).toEqual([]);
        expect(scenarios[1].result?.frames[0].values.doubled).toBe(600);
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

describe("portable model subsystems", () => {
    test("rewrites parsed reference spans including delays without touching unit literals or functions", () => {
        const source = "max( day, 1[day]) + lag((day), 2) + day_count + 1e2[day]";
        expect(rewriteExpressionReferences({ source, mapping: new Map([["day", "copied_day"]]) })).toBe(
            "max( copied_day, 1[day]) + lag((copied_day), 2) + day_count + 1e2[day]"
        );
        expect(rewriteExpressionReferences({ source: "time / step + x", mapping: new Map([["x", "copied_x"]]) })).toBe(
            "time / step + copied_x"
        );
        expect(() => rewriteExpressionReferences({ source: "x", mapping: new Map([["x", "time"]]) })).toThrow("clock");
        expect(() => rewriteExpressionReferences({ source: "lag(x, 0)", mapping: new Map([["x", "new_x"]]) })).toThrow(
            "whole step"
        );
        const long = Array.from({ length: 100 }, () => "x").join("+");
        expect(() => rewriteExpressionReferences({ source: long, mapping: new Map([["x", "a".repeat(64)]]) })).toThrow(
            "4096"
        );
    });

    test("extracts closed equations with copied inputs and reproduces the baseline without source mutation", async () => {
        const model = supportCapacityModel();
        const before = structuredClone(model);
        const packageFile = await extractSubsystem({
            input: model,
            members: ["capacity"],
            outputs: ["capacity"],
            label: "Support team",
        });
        expect(packageFile.boundaryInputs.sort()).toEqual(["agents", "productivity"]);
        expect(packageFile.model.scenarios).toEqual([]);
        expect(packageFile.model.presentation.steps).toEqual([]);
        const original = simulate({ model: compileModel({ input: model }) });
        const extracted = simulate({ model: compileModel({ input: packageFile.model }) });
        expect(extracted.frames.map((frame) => frame.values.capacity)).toEqual(
            original.frames.map((frame) => frame.values.capacity)
        );
        expect(model).toEqual(before);
    });

    test("requires dynamic dependencies instead of silently freezing them", async () => {
        const model = supportCapacityModel();
        const selection = inspectSubsystemSelection({ input: model, members: ["backlog"] });
        expect(selection.missingDependencies.map((entry) => entry.quantity.id)).toEqual(["capacity"]);
        expect(selection.boundaryInputs.map((entry) => entry.id).sort()).toEqual([
            "agents",
            "arrivals",
            "productivity",
        ]);
        await expect(
            extractSubsystem({ input: model, members: ["backlog"], outputs: ["backlog"], label: "Queue" })
        ).rejects.toThrow("Service capacity");
        const packageFile = await extractSubsystem({
            input: model,
            members: ["backlog", "capacity"],
            outputs: ["backlog"],
            label: "Queue",
        });
        expect(simulate({ model: compileModel({ input: packageFile.model }) }).frames[6].values.backlog).toBeCloseTo(
            20
        );
    });

    test("multiple imports use fresh identifiers and preserve existing equations and layout", async () => {
        const model = supportCapacityModel();
        const before = structuredClone(model);
        const packageFile = await extractSubsystem({
            input: model,
            members: ["capacity"],
            outputs: ["capacity"],
            label: "Team",
        });
        const first = await importSubsystem({ input: model, packageInput: packageFile, namespace: "extra" });
        const second = await importSubsystem({ input: first.document, packageInput: packageFile, namespace: "extra" });
        expect(first.mapping.capacity).toBe("extra_capacity");
        expect(second.mapping.capacity).toBe("extra_capacity_2");
        expect(second.document.quantities.slice(0, model.quantities.length)).toEqual(model.quantities);
        expect(new Set(second.document.quantities.map((quantity) => quantity.id)).size).toBe(
            second.document.quantities.length
        );
        expect(second.document.subsystems.at(-1)?.quantities).toEqual(["extra_capacity_2"]);
        const result = simulate({ model: compileModel({ input: second.document }) });
        expect(result.frames[0].values.extra_capacity_2).toBeCloseTo(100);
        expect(model).toEqual(before);
        for (const added of first.document.quantities.filter((quantity) => first.added.includes(quantity.id))) {
            for (const existing of model.quantities) {
                const overlap =
                    Math.abs(added.position.x - existing.position.x) < 240 &&
                    Math.abs(added.position.y - existing.position.y) < 160;
                expect(overlap).toBe(false);
            }
        }
    });

    test("input bindings convert compatible aliases and refuse incompatible or non-input targets", async () => {
        const source = readModelDocument({
            ...formulaModel("duration"),
            quantities: [
                { id: "duration", label: "Duration", kind: "input", value: 1, unit: "day" },
                { id: "answer", label: "Answer", kind: "formula", expression: "duration", unit: "day" },
            ],
        });
        const destination = readModelDocument({
            ...formulaModel("1"),
            quantities: [
                ...formulaModel("1").quantities,
                { id: "elapsed", label: "Elapsed", kind: "input", value: 48, unit: "hour" },
                { id: "distance", label: "Distance", kind: "input", value: 2, unit: "m" },
            ],
        });
        const packageFile = await extractSubsystem({
            input: source,
            members: ["answer"],
            outputs: ["answer"],
            label: "Timing",
        });
        expect(
            subsystemBindingChoices({ input: destination, packageInput: packageFile })[0].candidates.map(
                (entry) => entry.id
            )
        ).toEqual(["elapsed"]);
        const imported = await importSubsystem({
            input: destination,
            packageInput: packageFile,
            namespace: "timing",
            bindings: { duration: "elapsed" },
        });
        expect(imported.added).toEqual(["timing_answer"]);
        expect(simulate({ model: compileModel({ input: imported.document }) }).frames[0].values.timing_answer).toBe(2);
        await expect(
            importSubsystem({
                input: destination,
                packageInput: packageFile,
                namespace: "timing",
                bindings: { duration: "distance" },
            })
        ).rejects.toThrow("compatible");
        await expect(
            importSubsystem({
                input: destination,
                packageInput: packageFile,
                namespace: "timing",
                bindings: { duration: "answer" },
            })
        ).rejects.toThrow("existing input");
        await expect(
            importSubsystem({
                input: destination,
                packageInput: packageFile,
                namespace: "timing",
                bindings: { answer: "elapsed" },
            })
        ).rejects.toThrow("Only subsystem inputs");

        destination.scenarios = [
            {
                id: "without_time",
                label: "Without time",
                color: "#aabbcc",
                description: "",
                overrides: {},
                interventions: [],
                replacements: [],
                removed: ["elapsed"],
            },
        ];
        const before = structuredClone(destination);
        await expect(
            importSubsystem({
                input: destination,
                packageInput: packageFile,
                namespace: "timing",
                bindings: { duration: "elapsed" },
            })
        ).rejects.toThrow("Without time");
        expect(destination).toEqual(before);
    });

    test("equivalent clocks preserve delayed feedback and incompatible steps fail", async () => {
        const source = formulaModel("lag(answer, 1) + 1");
        const packageFile = await extractSubsystem({
            input: source,
            members: ["answer"],
            outputs: ["answer"],
            label: "Counter",
        });
        const destination = convertModelTime({ input: formulaModel("1"), unit: "hour" });
        const imported = await importSubsystem({ input: destination, packageInput: packageFile, namespace: "counter" });
        const expected = simulate({ model: compileModel({ input: source }) }).frames.map(
            (frame) => frame.values.answer
        );
        const actual = simulate({ model: compileModel({ input: imported.document }) }).frames.map(
            (frame) => frame.values.counter_answer
        );
        expect(actual).toEqual(expected);
        destination.time.step = 12;
        await expect(
            importSubsystem({ input: destination, packageInput: packageFile, namespace: "counter" })
        ).rejects.toThrow("physical step");
    });

    test("validates package manifests and refuses numerically invalid executable modules", async () => {
        const packageFile = await extractSubsystem({
            input: formulaModel("1"),
            members: ["answer"],
            outputs: ["answer"],
            label: "Constant",
        });
        expect(() => readSubsystemPackage({ ...packageFile, members: ["answer", "answer"] })).toThrow("duplicate");
        expect(() => readSubsystemPackage({ ...packageFile, outputs: ["missing"] })).toThrow("outputs");
        expect(() => readSubsystemPackage({ ...packageFile, boundaryInputs: ["answer"] })).toThrow();
        expect(() => readSubsystemPackage({ ...packageFile, members: ["missing"] })).toThrow("exist");
        await expect(
            extractSubsystem({
                input: formulaModel("1 / 0"),
                members: ["answer"],
                outputs: ["answer"],
                label: "Invalid",
            })
        ).rejects.toThrow("non-finite");
        await expect(
            importSubsystem({ input: formulaModel("1"), packageInput: packageFile, namespace: "invalid space" })
        ).rejects.toThrow("namespace");
    });

    test("does not mistake inherited object properties for explicit bindings", async () => {
        const input = readModelDocument({
            ...formulaModel("1"),
            quantities: [{ id: "toString", label: "Value", kind: "input", value: 2, unit: "1" }],
        });
        const packageFile = await extractSubsystem({
            input,
            members: ["toString"],
            outputs: ["toString"],
            label: "Value",
        });
        const imported = await importSubsystem({ input, packageInput: packageFile, namespace: "copy" });
        expect(imported.added).toEqual(["copy_toString"]);
        expect(simulate({ model: compileModel({ input: imported.document }) }).frames[0].values.copy_toString).toBe(2);
    });
});

describe("reviewed AI model proposals", () => {
    const unknown = () => ({ value: null, sourceQuote: null, question: "Choose a value." });
    const supplied = (value: number, sourceQuote: string) => ({ value, sourceQuote, question: "" });
    const sourceText = "Use 10 days, a 1 day step and 3 people.";
    function proposal() {
        return {
            format: "genesis-model-room-proposal",
            version: 1,
            title: "Support capacity",
            explanation: "A draft relationship between staffing and capacity.",
            time: { unit: "day", duration: supplied(10, "10 days"), step: supplied(1, "1 day step") },
            quantities: [
                {
                    id: "staff",
                    label: "Staff",
                    unit: "people",
                    kind: "input",
                    description: "Available staff",
                    seed: null,
                    value: supplied(3, "3 people"),
                },
                {
                    id: "rate",
                    label: "Rate",
                    unit: "ticket/person/day",
                    kind: "input",
                    description: "Explicit unknown productivity",
                    seed: null,
                    value: unknown(),
                },
                {
                    id: "capacity",
                    label: "Capacity",
                    unit: "ticket/day",
                    kind: "formula",
                    description: "Capacity assumes constant productivity",
                    seed: null,
                    expression: "staff * rate",
                },
            ],
            outputs: ["capacity"],
        };
    }

    test("keeps unknown coefficients unresolved and does not mutate the proposal", async () => {
        const input = proposal();
        const before = structuredClone(input);
        const review = inspectModelProposal({ input, sourceText });

        expect(review.missing).toEqual([
            { key: "rate.value", label: "Rate", unit: "ticket/person/day", question: "Choose a value." },
        ]);
        expect(input).toEqual(before);
        await expect(resolveModelProposal({ input, sourceText })).rejects.toThrow("rate.value");
    });

    test("only builds an executable document after all missing values are supplied", async () => {
        const document = await resolveModelProposal({
            input: proposal(),
            sourceText,
            answers: { "rate.value": 20 },
        });
        const result = simulate({ model: compileModel({ input: document }) });

        expect(document.quantities).toHaveLength(3);
        expect(result.frames[0].values.capacity).toBeCloseTo(60, 10);
        expect(document.description).toContain("require human review");
        expect(document.quantities.find((quantity) => quantity.id === "rate")?.provenance).toBe("assumption");
        expect(document.quantities.find((quantity) => quantity.id === "capacity")?.provenance).toBe("assumption");
        expect(document.quantities.find((quantity) => quantity.id === "rate")?.description).toContain(
            "Author-reviewed value: 20 ticket/person/day."
        );
    });

    test("an invented source quote becomes a required author answer", () => {
        const input = proposal();
        input.time.duration = supplied(30, "30 days");
        const review = inspectModelProposal({ input, sourceText });

        expect(review.proposal.time.duration.value).toBeNull();
        expect(review.missing.map((field) => field.key)).toContain("time.duration");
        expect(review.warnings).toHaveLength(2);
    });

    test("a real quote containing a different number cannot justify a value", () => {
        const input = proposal();
        input.time.duration = supplied(30, "10 days");

        expect(inspectModelProposal({ input, sourceText }).proposal.time.duration.value).toBeNull();
    });

    test("refuses hidden inline coefficients and accepts explicit zero boundaries", () => {
        const input = proposal();
        Object.assign(input.quantities[2], { expression: "staff * rate * 2" });

        expect(() => inspectModelProposal({ input, sourceText })).toThrow("named inputs");
        Object.assign(input.quantities[2], { expression: "max(0[ticket/day], staff * rate)" });
        expect(inspectModelProposal({ input, sourceText }).missing).toHaveLength(1);
    });

    test("rejects code, unit mismatches, cycles and unknown outputs before review", () => {
        for (const expression of ["process.exit()", "staff + rate", "capacity + rate"]) {
            const input = proposal();
            Object.assign(input.quantities[2], { expression });
            expect(() => inspectModelProposal({ input, sourceText })).toThrow();
        }
        const input = proposal();
        input.outputs = ["missing"];
        expect(() => inspectModelProposal({ input, sourceText })).toThrow();
    });

    test("rejects extra answer fields and non-finite values", async () => {
        await expect(
            resolveModelProposal({
                input: proposal(),
                sourceText,
                answers: { "rate.value": 10, "typo.value": 2 },
            })
        ).rejects.toThrow("Unknown proposal answer");
        await expect(
            resolveModelProposal({
                input: proposal(),
                sourceText,
                answers: { "rate.value": Number.NaN },
            })
        ).rejects.toThrow();
    });

    test("evaluates dynamics before returning a reviewed model", async () => {
        const input = proposal();
        Object.assign(input.quantities[2], { expression: "staff / rate", unit: "person^2 * day / ticket" });

        await expect(
            resolveModelProposal({
                input,
                sourceText,
                answers: { "rate.value": 0 },
            })
        ).rejects.toThrow("non-finite");
    });

    test("requires a positive compatible clock and respects cancellation", async () => {
        await expect(
            resolveModelProposal({
                input: proposal(),
                sourceText,
                answers: { "rate.value": 10, "time.step": 0 },
            })
        ).rejects.toThrow();
        await expect(
            resolveModelProposal({
                input: proposal(),
                sourceText,
                answers: { "rate.value": 10, "time.step": 3 },
            })
        ).rejects.toThrow("exact multiple");
        const controller = new AbortController();
        controller.abort(new Error("review cancelled"));

        await expect(
            resolveModelProposal({
                input: proposal(),
                sourceText,
                answers: { "rate.value": 10 },
                signal: controller.signal,
            })
        ).rejects.toThrow("review cancelled");
    });

    test("bounds the proposal and refuses generated datasets or extra properties", () => {
        const input = proposal();
        expect(() => inspectModelProposal({ input: { ...input, execute: "command" }, sourceText })).toThrow();
        expect(() => inspectModelProposal({ input, sourceText: "x".repeat(16001) })).toThrow("16,000");
        expect(() =>
            inspectModelProposal({
                input: { ...input, quantities: Array.from({ length: 25 }, () => input.quantities[0]) },
                sourceText,
            })
        ).toThrow();
    });
});
