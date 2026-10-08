import { SafeJSON } from "@genesiscz/utils/json";
import { readModelDocument, scenarioDocument } from "../lib/document";
import { comparisonValue, evaluateDocument } from "../lib/evaluation";
import { assumptionsCSV, resultsCSV, serializedModel } from "../lib/exports";

const input: unknown = SafeJSON.parse(document.getElementById("model-document")?.textContent ?? "null", {
    strict: true,
});
let model = readModelDocument(input);
const original = serializedModel(model);
const app = document.getElementById("app");

if (!app) {
    throw new Error("The model presentation is missing its app surface.");
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, text = ""): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    node.textContent = text;
    return node;
}

function button(text: string, action: () => void): HTMLButtonElement {
    const node = element("button", text);
    node.type = "button";
    node.addEventListener("click", action);
    return node;
}

function download({ text, filename, type }: { text: string; filename: string; type: string }): void {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const link = element("a");
    link.href = url;
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

let evaluation: Awaited<ReturnType<typeof evaluateDocument>> | undefined;
let selectedScenario = "";
let outputId = model.presentation.outputs[0] ?? model.quantities[0].id;
let selectedTick = 0;
let revision = 0;
let controller = new AbortController();
const heading = element("header");
const introduction = element("div");
introduction.append(
    element("small", "Model Room · interactive explanation"),
    element("h1", model.title),
    element("p", model.description)
);
const actions = element("div");
actions.className = "toolbar";
actions.append(
    button("Reset", () => {
        const parsed: unknown = SafeJSON.parse(original, { strict: true });
        model = readModelDocument(parsed);
        renderControls();
        void refresh();
    }),
    button("Remix this model", () =>
        download({ text: serializedModel(model), filename: `${model.id}.modelroom.json`, type: "application/json" })
    ),
    button("Results CSV", () => {
        if (evaluation) {
            try {
                download({
                    text: resultsCSV(model, evaluation.scenarios),
                    filename: `${model.id}-results.csv`,
                    type: "text/csv",
                });
            } catch (error) {
                status.textContent = error instanceof Error ? error.message : String(error);
                status.className = "error";
            }
        }
    }),
    button("Assumptions CSV", () =>
        download({ text: assumptionsCSV(model), filename: `${model.id}-assumptions.csv`, type: "text/csv" })
    )
);
heading.append(introduction, actions);
const layout = element("div");
layout.className = "layout";
const controls = element("aside");
const results = element("section");
const title = element("h2", "Follow what changes");
const selection = element("select");
selection.setAttribute("aria-label", "Chart quantity");
const selectableOutputs = new Map(model.quantities.map((quantity) => [quantity.id, quantity]));
for (const scenario of model.scenarios) {
    for (const quantity of scenario.replacements) {
        if (!selectableOutputs.has(quantity.id)) {
            selectableOutputs.set(quantity.id, quantity);
        }
    }
}
for (const quantity of [...selectableOutputs.values()].filter(
    (entry) => model.presentation.outputs.includes(entry.id) || entry.id === outputId
)) {
    const option = element("option", `${quantity.label} · ${quantity.unit}`);
    option.value = quantity.id;
    selection.append(option);
}
selection.value = outputId;
selection.addEventListener("change", () => {
    outputId = selection.value;
    renderResults();
});
const legend = element("div");
legend.className = "legend";
const chart = document.createElementNS("http://www.w3.org/2000/svg", "svg");
chart.setAttribute("viewBox", "0 0 720 330");
chart.setAttribute("role", "img");
const timeLabel = element("label");
timeLabel.htmlFor = "time";
const timeInput = element("input");
timeInput.id = "time";
timeInput.type = "range";
timeInput.min = "0";
timeInput.max = String(Math.round(model.time.duration / model.time.step));
timeInput.step = "1";
timeInput.value = "0";
timeInput.addEventListener("input", () => {
    selectedTick = Number(timeInput.value);
    renderResults();
});
const values = element("div");
const status = element("p", "Calculating locally…");
status.setAttribute("role", "status");
const narrative = element("div");
narrative.className = "narrative";
let narrativeIndex = 0;
const narrativeText = element("div");
const previous = button("Previous", () => selectNarrative(narrativeIndex - 1));
const next = button("Next", () => selectNarrative(narrativeIndex + 1));
narrative.append(narrativeText, previous, next);
const details = element("details");
let tablePage = 0;
details.addEventListener("toggle", () => renderResultTable());
details.append(element("summary", "Inspect every result"));
const tableContainer = element("div");
tableContainer.className = "scroll";
details.append(tableContainer);
results.append(title, selection, legend, chart, timeLabel, timeInput, values, narrative, status, details);
layout.append(controls, results);
app.append(
    heading,
    layout,
    element(
        "footer",
        "Runs entirely in this file, with no network access. Stocks use explicit Euler integration; uncertainty is not inferred from these illustrative scenarios. Open the remixed JSON in Model Room to edit formulas and structure."
    )
);

function renderControls(): void {
    const restoreScenarioFocus = controls.querySelector("select") === document.activeElement;
    controls.replaceChildren(element("h2", "Your assumptions"));
    const scenarioSelect = element("select");
    scenarioSelect.setAttribute("aria-label", "Scenario to edit");
    const baseline = element("option", "Baseline");
    baseline.value = "";
    scenarioSelect.append(baseline);
    for (const scenario of model.scenarios) {
        const option = element("option", scenario.label);
        option.value = scenario.id;
        scenarioSelect.append(option);
    }

    scenarioSelect.value = selectedScenario;
    scenarioSelect.addEventListener("change", () => {
        selectedScenario = scenarioSelect.value;
        renderControls();
        renderResults();
    });
    controls.append(scenarioSelect);

    if (restoreScenarioFocus) {
        scenarioSelect.focus();
    }

    let quantities = model.quantities;
    try {
        quantities = scenarioDocument(model, selectedScenario || undefined).document.quantities;
    } catch (error) {
        controls.append(element("p", error instanceof Error ? error.message : String(error)));
        return;
    }
    for (const quantity of quantities) {
        if (quantity.kind !== "input" || !model.presentation.controls.includes(quantity.id)) {
            continue;
        }

        const label = element("label", `${quantity.label} · ${quantity.unit}`);
        label.htmlFor = quantity.id;
        const slider = element("input");
        slider.id = quantity.id;
        slider.type = quantity.range ? "range" : "number";
        const overrides = model.scenarios.find((scenario) => scenario.id === selectedScenario)?.overrides;
        const value = overrides && Object.hasOwn(overrides, quantity.id) ? overrides[quantity.id] : quantity.value;
        const readout = element("output", String(value));
        readout.htmlFor = slider.id;
        readout.className = "value";

        if (quantity.range) {
            slider.min = String(quantity.range.min);
            slider.max = String(quantity.range.max);
            slider.step = String(quantity.range.step);
        }

        slider.value = String(value);
        slider.addEventListener("input", () => {
            const number = Number(slider.value);

            if (!Number.isFinite(number)) {
                return;
            }

            const scenario = model.scenarios.find((entry) => entry.id === selectedScenario);

            if (scenario) {
                scenario.overrides[quantity.id] = number;
            } else {
                quantity.value = number;
            }

            readout.value = String(number);
            void refresh();
        });
        controls.append(label, slider, readout);
    }
}

function svgNode(tag: string, attributes: Record<string, string>, text = ""): SVGElement {
    const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [key, value] of Object.entries(attributes)) {
        node.setAttribute(key, value);
    }
    node.textContent = text;
    return node;
}

function renderResults(): void {
    if (!evaluation) {
        return;
    }

    const series = evaluation.scenarios.filter((entry) => entry.result);
    const current = series.find((entry) => entry.id === (selectedScenario || null));
    const quantity = current?.quantities[outputId] ?? series[0]?.quantities[outputId];
    const plotted = series.map((scenario) => ({
        scenario,
        points: (scenario.result?.frames ?? []).flatMap((frame) => {
            const value = comparisonValue({
                value: frame.values[outputId],
                source: scenario.quantities[outputId],
                target: quantity,
            });
            return value === undefined ? [] : [{ time: frame.time, value }];
        }),
    }));
    const all = plotted.flatMap((entry) => entry.points.map((point) => point.value));
    for (const option of selection.options) {
        const descriptor = current?.quantities[option.value] ?? series[0]?.quantities[option.value];
        if (descriptor) {
            option.textContent = `${descriptor.label} · ${descriptor.unit}`;
        }
    }
    let minimum = all.reduce((current, value) => Math.min(current, value), 0);
    let maximum = all.reduce((current, value) => Math.max(current, value), 0);

    if (minimum === maximum) {
        minimum -= 1;
        maximum += 1;
    }

    const x = (time: number) => 54 + (time / model.time.duration) * 642;
    const y = (value: number) => 285 - ((value - minimum) / (maximum - minimum)) * 260;
    chart.replaceChildren();
    chart.setAttribute(
        "aria-label",
        `${quantity?.label ?? outputId} (${quantity?.unit ?? ""}) over ${model.time.duration} ${model.time.unit}`
    );
    for (let i = 0; i <= 4; i++) {
        const value = minimum + ((maximum - minimum) * i) / 4;
        chart.append(
            svgNode("line", {
                x1: "54",
                y1: String(y(value)),
                x2: "696",
                y2: String(y(value)),
                stroke: "var(--border)",
            })
        );
        chart.append(
            svgNode(
                "text",
                {
                    x: "44",
                    y: String(y(value) + 4),
                    "text-anchor": "end",
                    fill: "var(--muted-foreground)",
                    "font-size": "11",
                },
                value.toLocaleString(undefined, { maximumFractionDigits: 2 })
            )
        );
    }

    legend.replaceChildren();
    for (const { scenario, points } of plotted) {
        if (points.length) {
            chart.append(
                svgNode("polyline", {
                    points: points.map((point) => `${x(point.time)},${y(point.value)}`).join(" "),
                    fill: "none",
                    stroke: scenario.color,
                    "stroke-width": scenario.id === (selectedScenario || null) ? "3" : "1.6",
                })
            );
        }
        const item = element(
            "span",
            points.length ? scenario.label : `${scenario.label} (absent or incompatible quantity)`
        );
        item.style.color = scenario.color;
        legend.append(item);
    }

    const time = selectedTick * model.time.step;
    chart.append(
        svgNode("line", {
            x1: String(x(time)),
            x2: String(x(time)),
            y1: "25",
            y2: "285",
            stroke: "var(--muted-foreground)",
            "stroke-dasharray": "5 5",
        })
    );
    chart.append(
        svgNode(
            "text",
            { x: "54", y: "312", fill: "var(--muted-foreground)", "font-size": "12" },
            `0 ${model.time.unit}`
        )
    );
    chart.append(
        svgNode(
            "text",
            { x: "696", y: "312", "text-anchor": "end", fill: "var(--muted-foreground)", "font-size": "12" },
            `${model.time.duration} ${model.time.unit}`
        )
    );
    timeLabel.textContent = `Time: ${time} ${model.time.unit}`;
    values.replaceChildren();
    const frame = current?.result?.frames[selectedTick];
    for (const entry of Object.values(current?.quantities ?? {})) {
        const row = element("div");
        row.className = "stat";
        row.append(
            element("span", entry.label),
            element(
                "strong",
                `${frame?.values[entry.id]?.toLocaleString(undefined, { maximumFractionDigits: 3 }) ?? "—"} ${entry.unit}`
            )
        );
        row.dataset.quantity = entry.id;
        row.dataset.value = String(frame?.values[entry.id] ?? "");
        values.append(row);
    }

    renderResultTable();
}

function renderResultTable(): void {
    if (!details.open || !evaluation) {
        tableContainer.replaceChildren();
        return;
    }

    const series = evaluation.scenarios.filter((scenario) => scenario.result);
    const total = series.reduce((count, scenario) => count + (scenario.result?.frames.length ?? 0), 0);
    const pageSize = 100;
    tablePage = Math.max(0, Math.min(tablePage, Math.ceil(total / pageSize) - 1));
    const start = tablePage * pageSize;
    const end = Math.min(total, start + pageSize);
    const current = series.find((scenario) => scenario.id === (selectedScenario || null));
    const quantity = current?.quantities[outputId] ?? series[0]?.quantities[outputId];
    const table = element("table");
    const header = element("tr");
    for (const text of ["Scenario", "Time", quantity ? `${quantity.label} (${quantity.unit})` : outputId]) {
        header.append(element("th", text));
    }

    table.append(header);
    let offset = 0;
    for (const scenario of series) {
        const frames = scenario.result?.frames ?? [];
        for (let index = Math.max(0, start - offset); index < Math.min(frames.length, end - offset); index++) {
            const point = frames[index];
            const row = element("tr");
            const compared = comparisonValue({
                value: point.values[outputId],
                source: scenario.quantities[outputId],
                target: quantity,
            });
            for (const text of [
                scenario.label,
                String(point.time),
                compared === undefined ? "Absent or incompatible quantity" : String(compared),
            ]) {
                row.append(element("td", text));
            }

            table.append(row);
        }

        offset += frames.length;
    }

    const previousPage = button("Previous rows", () => {
        tablePage--;
        renderResultTable();
    });
    const nextPage = button("Next rows", () => {
        tablePage++;
        renderResultTable();
    });
    previousPage.disabled = tablePage === 0;
    nextPage.disabled = end === total;
    tableContainer.replaceChildren(
        element("p", `Rows ${total ? start + 1 : 0}–${end} of ${total}. The CSV includes every row.`),
        previousPage,
        nextPage,
        table
    );
}

function selectNarrative(index: number): void {
    narrativeIndex = Math.max(0, Math.min(model.presentation.steps.length - 1, index));
    const step = model.presentation.steps[narrativeIndex];
    narrative.hidden = !step;

    if (!step) {
        return;
    }

    narrativeText.replaceChildren(
        element("small", "Author’s explanation · this text stays as written when controls change."),
        element("h2", step.title),
        element("p", step.text)
    );
    selectedScenario = step.scenario ?? "";
    selectedTick = Math.min(Number(timeInput.max), Math.round((step.time ?? 0) / model.time.step));
    timeInput.value = String(selectedTick);
    previous.disabled = narrativeIndex === 0;
    next.disabled = narrativeIndex === model.presentation.steps.length - 1;
    renderControls();
    renderResults();
}

async function refresh(): Promise<void> {
    const currentRevision = ++revision;
    controller.abort();
    controller = new AbortController();
    status.textContent = "Calculating locally…";
    status.className = "";
    try {
        const next = await evaluateDocument({ input: model, control: { signal: controller.signal } });

        if (currentRevision !== revision) {
            return;
        }

        evaluation = next;
        renderResults();
        const failures = next.scenarios.filter((scenario) => scenario.error);
        status.textContent = failures.length
            ? failures.map((scenario) => `${scenario.label}: ${scenario.error}`).join(" · ")
            : "Ready · computed locally, using the same engine as Model Room.";
        status.className = failures.length ? "error" : "";
    } catch (error) {
        if (currentRevision === revision) {
            status.textContent = `${error instanceof Error ? error.message : String(error)} Last valid results are retained.`;
            status.className = "error";
        }
    }
}

renderControls();
selectNarrative(0);
void refresh();
