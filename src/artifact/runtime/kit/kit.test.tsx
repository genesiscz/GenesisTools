import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parsePatch } from "diff";
import { act, useState } from "react";
import { THEME_PREPAINT_SCRIPT } from "../../lib/templates";
import { SERIES_COLOR } from "./charts";
import { contrastRatio, parseCssColor, readableTextOn } from "./color";
import { DataTable, type DataTableCell, Tabs, tabHash, tabIdFromHash } from "./data";
import { Mermaid } from "./diagrams";
import { DiffView, diffFileFromPatch, pairDiffRows } from "./diff";
import { type EditableColumn, type EditableRow, EditableTable, editableTotal } from "./editable";
import { Button, Field, FileInput, NumberInput, parseNumberDraft, TextInput } from "./forms";
import { Md, MdViewer } from "./md";
import { configureMermaid, type MermaidApi } from "./mermaid-core";
import { CodeBlock, Collapse, FilterChips, SegmentedControl, StatGrid, statDeltaTone } from "./primitives";
import { matchRoute } from "./router";
import { moveItem, SortableList } from "./sortable";
import { JsonView, Steps, TreeView, treeFromPaths } from "./structure";
import { mountDom } from "./test-dom";
import { resolvedColorScheme, THEME_STORAGE_KEY, ThemeToggle } from "./theme";
import { placeTooltip, Tooltip, useTooltip } from "./tooltip";
import { CapacityGrid, capacityStatus, Heatmap, Meter, meterTone, Sparkline, sparklinePath } from "./viz";
import { Wizard, type WizardStep } from "./wizard";

const mermaidRendered: string[] = [];
let mermaidFailNext = false;
const fakeMermaid: MermaidApi = {
    initialize() {},
    async render(_id, text) {
        if (mermaidFailNext) {
            mermaidFailNext = false;
            throw new Error("Parse error on line 1");
        }

        mermaidRendered.push(text);

        return { svg: `<svg data-fake="1"><text>${text.length}</text></svg>` };
    },
};

/** Let the async fence hydration (load, then render) settle. */
async function settle(): Promise<void> {
    for (let i = 0; i < 3; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}

beforeAll(() => {
    // Never the CDN in tests: the loader is injected.
    configureMermaid({ load: async () => fakeMermaid });
});

describe("Tabs hash round-trip", () => {
    test("an id with a space survives write then read", () => {
        expect(tabHash("my tab")).toBe("#my%20tab");
        expect(tabIdFromHash(tabHash("my tab"))).toBe("my tab");
        expect(tabIdFromHash(tabHash("a/b?c#d"))).toBe("a/b?c#d");
    });

    test("a malformed hash is returned raw instead of throwing", () => {
        expect(tabIdFromHash("#100%")).toBe("100%");
    });

    test("a deep link to an ENCODED tab id opens that tab, not the first one", async () => {
        const tabs = [
            { id: "first", label: "First", content: <p>first body</p> },
            { id: "my tab", label: "Second", content: <p>second body</p> },
        ];
        const dom = await mountDom(<Tabs tabs={tabs} />, "http://localhost/demo#my%20tab");

        expect(dom.html()).toContain("second body");
        expect(dom.html()).not.toContain("first body");

        await dom.unmount();
    });

    test("clicking a tab writes an encoded hash", async () => {
        const tabs = [
            { id: "first", label: "First", content: <p>first body</p> },
            { id: "my tab", label: "Second", content: <p>second body</p> },
        ];
        const dom = await mountDom(<Tabs tabs={tabs} />, "http://localhost/demo");
        const buttons = dom.container.querySelectorAll("button");
        await dom.click(buttons[1]);

        expect(dom.window.location.hash).toBe("#my%20tab");

        await dom.unmount();
    });

    test("a badge renders next to the label and sticky is on by default", async () => {
        const tabs = [{ id: "a", label: "Alpha", badge: { text: "MERGED", tone: "ok" as const }, content: <p>x</p> }];
        const dom = await mountDom(<Tabs tabs={tabs} />);

        expect(dom.html()).toContain("MERGED");
        expect(dom.html()).toContain("sticky");

        const plain = await mountDom(<Tabs tabs={tabs} sticky={false} />);
        expect(plain.html()).not.toContain("sticky");

        await dom.unmount();
        await plain.unmount();
    });
});

describe("Tabs accessibility", () => {
    test("the bar is a tablist and only the active tab is aria-selected", async () => {
        const tabs = [
            { id: "first", label: "First", content: <p>first body</p> },
            { id: "my tab", label: "Second", content: <p>second body</p> },
        ];
        const dom = await mountDom(<Tabs tabs={tabs} />, "http://localhost/demo");

        expect(dom.container.querySelectorAll('[role="tablist"]')).toHaveLength(1);
        const buttons = [...dom.container.querySelectorAll('[role="tab"]')];
        expect(buttons).toHaveLength(2);
        expect(buttons.map((b) => b.getAttribute("aria-selected"))).toEqual(["true", "false"]);

        await dom.click(buttons[1]);
        expect([...dom.container.querySelectorAll('[role="tab"]')].map((b) => b.getAttribute("aria-selected"))).toEqual(
            ["false", "true"]
        );

        await dom.unmount();
    });

    test("the panel points back at its tab, with ids safe for an arbitrary tab id", async () => {
        const tabs = [{ id: "my tab", label: "Second", content: <p>second body</p> }];
        const dom = await mountDom(<Tabs tabs={tabs} />, "http://localhost/demo");
        const button = dom.container.querySelector('[role="tab"]');
        const panel = dom.container.querySelector('[role="tabpanel"]');

        expect(button?.getAttribute("id")).toBe("akit-tab-my%20tab");
        expect(panel?.getAttribute("aria-labelledby")).toBe(button?.getAttribute("id"));
        expect(button?.getAttribute("aria-controls")).toBe(panel?.getAttribute("id"));
        expect(panel?.textContent).toContain("second body");

        await dom.unmount();
    });
});

describe("Tabs keyboard model", () => {
    const tabs = [
        { id: "first", label: "First", content: <p>first body</p> },
        { id: "my tab", label: "Second", content: <p>second body</p> },
        { id: "third", label: "Third", content: <p>third body</p> },
    ];

    test("arrows move the selection and wrap, Home and End jump to the ends", async () => {
        const dom = await mountDom(<Tabs tabs={tabs} />, "http://localhost/demo");
        const selected = (): string | null =>
            dom.container.querySelector('[role="tab"][aria-selected="true"]')?.textContent ?? null;
        const bar = (): Element[] => [...dom.container.querySelectorAll('[role="tab"]')];

        await dom.press(bar()[0], "ArrowRight");
        expect(selected()).toBe("Second");

        await dom.press(bar()[1], "End");
        expect(selected()).toBe("Third");

        // Wrapping past the last tab returns to the first.
        await dom.press(bar()[2], "ArrowRight");
        expect(selected()).toBe("First");

        // And backwards off the first wraps to the last.
        await dom.press(bar()[0], "ArrowLeft");
        expect(selected()).toBe("Third");

        await dom.press(bar()[2], "Home");
        expect(selected()).toBe("First");

        await dom.unmount();
    });

    test("the tablist is one tab stop and focus follows the selection", async () => {
        const dom = await mountDom(<Tabs tabs={tabs} />, "http://localhost/demo");
        const tabIndexes = (): (string | null)[] =>
            [...dom.container.querySelectorAll('[role="tab"]')].map((b) => b.getAttribute("tabindex"));

        expect(tabIndexes()).toEqual(["0", "-1", "-1"]);

        await dom.press(dom.container.querySelectorAll('[role="tab"]')[0], "ArrowRight");
        expect(tabIndexes()).toEqual(["-1", "0", "-1"]);
        expect(dom.window.document.activeElement?.textContent).toBe("Second");

        await dom.unmount();
    });

    test("an unrelated key is left to the browser", async () => {
        const dom = await mountDom(<Tabs tabs={tabs} />, "http://localhost/demo");
        await dom.press(dom.container.querySelectorAll('[role="tab"]')[0], "a");

        expect(dom.container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("First");

        await dom.unmount();
    });
});

describe("DataTable accessibility", () => {
    test("the filter input has an accessible name that survives typing", async () => {
        const dom = await mountDom(
            <DataTable
                caption="Runs"
                filter
                columns={[{ key: "name", label: "Name" }]}
                rows={[{ name: "alpha" }, { name: "beta" }]}
            />
        );
        const input = dom.container.querySelector("input");

        // The placeholder disappears once the user types; aria-label does not.
        expect(input?.getAttribute("aria-label")).toBe("filter rows: Runs");

        await dom.unmount();
    });
});

describe("SegmentedControl accessibility", () => {
    const options = [
        { value: "day", label: "Day" },
        { value: "week", label: "Week" },
    ];

    test("the active option is announced, not just tinted", async () => {
        const dom = await mountDom(<SegmentedControl options={options} value="week" onChange={() => {}} />);
        const buttons = [...dom.container.querySelectorAll("button")];

        expect(buttons.map((b) => b.getAttribute("role"))).toEqual(["radio", "radio"]);
        expect(buttons.map((b) => b.getAttribute("aria-checked"))).toEqual(["false", "true"]);

        await dom.unmount();
    });

    test("the visible label names the group programmatically", async () => {
        const dom = await mountDom(
            <SegmentedControl options={options} value="day" onChange={() => {}} label="Range" />
        );
        const group = dom.container.querySelector('[role="radiogroup"]');
        const labelledBy = group?.getAttribute("aria-labelledby");

        // getElementById, not a selector: React's useId emits colons (":r1:"),
        // which are not valid in a CSS id selector without escaping.
        expect(labelledBy).toBeTruthy();
        expect(dom.window.document.getElementById(labelledBy ?? "")?.textContent).toBe("Range");

        await dom.unmount();
    });

    test("with no label the group carries no dangling aria-labelledby", async () => {
        const dom = await mountDom(<SegmentedControl options={options} value="day" onChange={() => {}} />);
        const group = dom.container.querySelector('[role="radiogroup"]');

        expect(group?.hasAttribute("aria-labelledby")).toBe(false);

        await dom.unmount();
    });
});

describe("DataTable unsearchable-column scan", () => {
    /** Rows whose cells report every read, so a scan that should not run is observable. */
    function countingRows(reads: { n: number }): Array<Record<string, DataTableCell>> {
        const make = (value: string): Record<string, DataTableCell> => ({
            get name(): DataTableCell {
                reads.n += 1;

                return value;
            },
        });

        return [make("alpha"), make("beta"), make("gamma")];
    }

    test("a non-filterable table never scans its cells for unsearchable columns", async () => {
        const reads = { n: 0 };
        const dom = await mountDom(<DataTable columns={[{ key: "name", label: "Name" }]} rows={countingRows(reads)} />);
        // Three reads render the three body cells. The unsearchable scan would add its own.
        expect(reads.n).toBe(3);

        await dom.unmount();
    });

    test("the scan runs once the filter box actually has a query", async () => {
        const reads = { n: 0 };
        const dom = await mountDom(
            <DataTable filter columns={[{ key: "name", label: "Name" }]} rows={countingRows(reads)} />
        );
        const before = reads.n;
        const input = dom.container.querySelector("input");
        await dom.type(input, "al");

        expect(reads.n).toBeGreaterThan(before);
        expect(dom.html()).toContain("1/3");

        await dom.unmount();
    });
});

describe("MdViewer", () => {
    test("an EMPTY markdown source renders as empty content, not a stuck loader", async () => {
        const dom = await mountDom(<MdViewer source="" />);

        expect(dom.html()).not.toContain("Loading");
        expect(dom.html()).toContain("0/0 sections");

        await dom.unmount();
    });

    test("a real source renders its sections", async () => {
        const dom = await mountDom(<MdViewer source={"# Title\n\nbody text\n"} />);

        expect(dom.html()).toContain("body text");
        expect(dom.html()).not.toContain("Loading");

        await dom.unmount();
    });
});

describe("CodeBlock", () => {
    test("plain and line-marked bodies share ONE pre element and its classes", async () => {
        const plain = await mountDom(<CodeBlock copy={false}>{"one\ntwo"}</CodeBlock>);
        const plainPre = plain.container.querySelectorAll("pre");

        expect(plainPre).toHaveLength(1);
        expect(plainPre[0].querySelectorAll("span")).toHaveLength(0);
        expect(plainPre[0].textContent).toBe("one\ntwo");
        const className = plainPre[0].getAttribute("class");

        await plain.unmount();

        const marked = await mountDom(
            <CodeBlock copy={false} badLines={[2]} highlightLines={[1]}>
                {"one\ntwo"}
            </CodeBlock>
        );
        const markedPre = marked.container.querySelectorAll("pre");

        expect(markedPre).toHaveLength(1);
        expect(markedPre[0].getAttribute("class")).toBe(className);
        const lines = [...markedPre[0].querySelectorAll("span")].map((el) => el.getAttribute("class"));
        expect(lines).toEqual(["block bg-accent/10", "block bg-err/15 text-err"]);

        await marked.unmount();
    });

    test("wrap adds the wrapping class in both modes", async () => {
        const plain = await mountDom(
            <CodeBlock copy={false} wrap>
                {"x"}
            </CodeBlock>
        );
        expect(plain.container.querySelector("pre")?.getAttribute("class")).toContain("whitespace-pre-wrap");
        await plain.unmount();

        const marked = await mountDom(
            <CodeBlock copy={false} wrap badLines={[1]}>
                {"x"}
            </CodeBlock>
        );
        expect(marked.container.querySelector("pre")?.getAttribute("class")).toContain("whitespace-pre-wrap");
        await marked.unmount();
    });
});

describe("Collapse", () => {
    test("the disclosure triangle is hidden from assistive technology", async () => {
        const dom = await mountDom(
            <Collapse summary="Details">
                <p>inner</p>
            </Collapse>
        );

        expect(dom.html()).toContain('aria-hidden="true"');

        await dom.unmount();
    });
});

describe("matchRoute", () => {
    test("matches nested params and decodes them", () => {
        expect(matchRoute("/item/:id", "/item/42")).toEqual({ id: "42" });
        expect(matchRoute("/a/:x/b/:y", "/a/one/b/two%20three")).toEqual({ x: "one", y: "two three" });
        expect(matchRoute("/item/:id", "/item/42/extra")).toBeNull();
        expect(matchRoute("/", "/")).toEqual({});
    });
});

describe("mermaid in markdown", () => {
    test("a ```mermaid fence in Md becomes the rendered SVG, other fences stay code", async () => {
        const dom = await mountDom(<Md>{"```mermaid\ngraph TD; A-->B\n```\n\n```ts\nconst a = 1;\n```\n"}</Md>);
        await settle();

        expect(dom.container.querySelector(".akit-mermaid svg")).not.toBeNull();
        expect(dom.container.querySelector("code.language-mermaid")).toBeNull();
        expect(mermaidRendered.at(-1)).toBe("graph TD; A-->B");
        // The ts fence is highlighted by the shared renderer and left alone.
        expect(dom.html()).toContain("hljs-keyword");
        expect(dom.container.querySelectorAll("pre")).toHaveLength(1);

        await dom.unmount();
    });

    test("a fence mermaid rejects keeps its source and gets the error above it", async () => {
        mermaidFailNext = true;
        const dom = await mountDom(<Md>{"```mermaid\ngraph TD; A--\n```\n"}</Md>);
        await settle();

        const error = dom.container.querySelector(".akit-mermaid-error");
        expect(error?.textContent).toBe("mermaid: Parse error on line 1");
        expect(dom.container.querySelector("code.language-mermaid")?.textContent).toBe("graph TD; A--");
        expect(dom.container.querySelector("svg")).toBeNull();

        await dom.unmount();
    });

    test("the Mermaid component renders through the same loader and its toolbar zooms", async () => {
        const dom = await mountDom(<Mermaid chart="sequenceDiagram\n  A->>B: hi" caption="handshake" />);
        await settle();
        await dom.render(<Mermaid chart="sequenceDiagram\n  A->>B: hi" caption="handshake" />);

        expect(dom.container.querySelector(".akit-mermaid svg")).not.toBeNull();
        expect(dom.html()).toContain("handshake");
        const zoomIn = [...dom.container.querySelectorAll("button")].find(
            (b) => b.getAttribute("aria-label") === "zoom in"
        );
        await dom.click(zoomIn);
        expect(dom.html()).toContain("125%");

        await dom.unmount();
    });
});

describe("CodeBlock lang", () => {
    test("a known language highlights the whole block, and per line when lines are marked", async () => {
        const whole = await mountDom(
            <CodeBlock copy={false} lang="ts">
                {"const a = 1;\nlet b = a;"}
            </CodeBlock>
        );
        expect(whole.container.querySelectorAll("pre code.hljs")).toHaveLength(1);
        expect(whole.html()).toContain("hljs-keyword");
        expect(whole.container.querySelector("pre")?.textContent).toBe("const a = 1;\nlet b = a;");
        await whole.unmount();

        const marked = await mountDom(
            <CodeBlock copy={false} lang="ts" badLines={[2]}>
                {"const a = 1;\nlet b = a;"}
            </CodeBlock>
        );
        const lines = [...marked.container.querySelectorAll("pre > span")];
        expect(lines).toHaveLength(2);
        expect(lines[1].getAttribute("class")).toContain("bg-err/15");
        expect(lines[1].innerHTML).toContain("hljs-keyword");
        await marked.unmount();
    });

    test("an unknown language renders plain text", async () => {
        const dom = await mountDom(
            <CodeBlock copy={false} lang="nope">
                {"<b>raw</b>"}
            </CodeBlock>
        );
        expect(dom.container.querySelector("pre")?.textContent).toBe("<b>raw</b>");
        expect(dom.container.querySelectorAll("span")).toHaveLength(0);
        await dom.unmount();
    });
});

describe("DiffView", () => {
    const PATCH = [
        "--- a/x.ts",
        "+++ b/x.ts",
        "@@ -1,3 +1,4 @@",
        " a",
        "-b",
        "+B",
        " c",
        "+d",
        "\\ No newline at end of file",
    ].join("\n");

    test("a unified patch flattens into numbered rows, skipping the no-newline marker", () => {
        const file = diffFileFromPatch(parsePatch(PATCH)[0]);
        expect(file.name).toBe("a/x.ts → b/x.ts");
        expect(file.added).toBe(2);
        expect(file.removed).toBe(1);
        expect(file.hunks[0].rows.map((r) => `${r.kind}:${r.oldNo ?? "-"}/${r.newNo ?? "-"}`)).toEqual([
            "ctx:1/1",
            "del:2/-",
            "add:-/2",
            "ctx:3/3",
            "add:-/4",
        ]);
    });

    test("split mode pairs a removed line with the added line that replaced it", () => {
        const rows = diffFileFromPatch(parsePatch(PATCH)[0]).hunks[0].rows;
        const pairs = pairDiffRows(rows).map((p) => `${p.left?.text ?? "·"}|${p.right?.text ?? "·"}`);
        expect(pairs).toEqual(["a|a", "b|B", "c|c", "·|d"]);
    });

    test("before/after renders the counts and tones lines; identical input says so", async () => {
        const dom = await mountDom(<DiffView before={"a\nb\nc\n"} after={"a\nB\nc\nd\n"} labels={["old", "new"]} />);
        expect(dom.html()).toContain("+2");
        expect(dom.html()).toContain("-1");
        expect(dom.container.querySelectorAll("tr.bg-ok\\/10")).toHaveLength(2);
        expect(dom.container.querySelectorAll("tr.bg-err\\/10")).toHaveLength(1);
        await dom.unmount();

        const same = await mountDom(<DiffView before="x" after="x" />);
        expect(same.html()).toContain("no changes");
        await same.unmount();
    });
});

describe("structure", () => {
    test("treeFromPaths nests, sorts directories first and decorates leaves", () => {
        const tree = treeFromPaths([
            "src/z.ts",
            { path: "src/lib/a.ts", tone: "ok", badge: "new" },
            "README.md",
            "docs/",
        ]);
        expect(tree.map((n) => n.label)).toEqual(["docs", "src", "README.md"]);
        expect(tree[0].children).toEqual([]);
        const src = tree[1];
        expect(src.children?.map((n) => n.label)).toEqual(["lib", "z.ts"]);
        expect(src.children?.[0].children?.[0]).toEqual({ label: "a.ts", tone: "ok", badge: "new" });
    });

    test("TreeView opens only the levels asked for", async () => {
        const nodes = treeFromPaths(["a/b/c.ts"]);
        const dom = await mountDom(<TreeView nodes={nodes} open={1} />);
        const details = [...dom.container.querySelectorAll("details")];
        expect(details.map((d) => d.hasAttribute("open"))).toEqual([true, false]);
        expect(dom.html()).toContain("c.ts");
        await dom.unmount();
    });

    test("Steps exposes each status and JsonView counts keys and truncates long strings", async () => {
        const steps = await mountDom(
            <Steps
                steps={[{ label: "lint", status: "done" }, { label: "test", status: "failed" }, { label: "ship" }]}
            />
        );
        expect(
            [...steps.container.querySelectorAll("[aria-label]")].map((el) => el.getAttribute("aria-label"))
        ).toEqual(["done", "failed", "pending"]);
        await steps.unmount();

        const json = await mountDom(<JsonView value={{ a: 1, list: ["x".repeat(10)] }} maxString={4} name="root" />);
        expect(json.html()).toContain("2 keys");
        expect(json.html()).toContain("1 item");
        expect(json.html()).toContain('"xxxx…"');
        await json.unmount();
    });

    test("JsonView marks a back-reference instead of recursing, and prints a Date instead of {}", async () => {
        const payload: { name: string; when: Date; self?: unknown } = {
            name: "root",
            when: new Date("2026-09-16T12:00:00Z"),
        };
        payload.self = payload;
        const dom = await mountDom(<JsonView value={payload} open={3} />);
        expect(dom.html()).toContain("[circular]");
        expect(dom.html()).toContain('"2026-09-16T12:00:00.000Z"');
        await dom.unmount();
    });
});

describe("viz", () => {
    test("meterTone follows the thresholds and the meter exposes its value", async () => {
        expect(meterTone(50, { warn: 70, err: 90 })).toBe("ok");
        expect(meterTone(75, { warn: 70, err: 90 })).toBe("warn");
        expect(meterTone(95, { warn: 70, err: 90 })).toBe("err");
        expect(meterTone(95, { warn: 70, err: 90 }, "info")).toBe("info");

        const dom = await mountDom(<Meter value={82} label="cache hit" thresholds={{ warn: 70, err: 90 }} />);
        const meter = dom.container.querySelector('[role="meter"]');
        expect(meter?.getAttribute("aria-valuenow")).toBe("82");
        expect(dom.html()).toContain("82%");
        expect(dom.html()).toContain("bg-warn");
        await dom.unmount();
    });

    test("sparklinePath spans the width and the SVG carries an accessible name", async () => {
        const path = sparklinePath([1, 3, 2], 100, 20);
        expect(path.startsWith("M1.50,")).toBe(true);
        expect(path.split(" ")).toHaveLength(3);
        expect(path.endsWith("L98.50,")).toBe(false);
        expect(path).toContain("L98.50,");

        const dom = await mountDom(<Sparkline values={[1, 3, 2]} />);
        expect(dom.container.querySelector("svg")?.getAttribute("aria-label")).toBe("trend of 3 values");
        await dom.unmount();
    });

    test("Heatmap shades every numeric cell and leaves a null cell empty", async () => {
        const dom = await mountDom(
            <Heatmap
                rows={["a", "b"]}
                cols={["1", "2"]}
                values={[
                    [0, 10],
                    [5, null],
                ]}
                format={(v) => `${v}x`}
            />
        );
        const cells = [...dom.container.querySelectorAll("tbody td")];
        expect(cells).toHaveLength(4);
        expect(cells[1].textContent).toBe("10x");
        expect(cells[1].getAttribute("style")).toContain("color-mix");
        expect(cells[3].textContent).toBe("");
        expect(cells[3].getAttribute("title")).toBe("b / 2: no data");
        await dom.unmount();
    });
});

/** A shared token's literal value from runtime/styles.css. */
function stylesToken(name: string): string {
    const css = readFileSync(join(import.meta.dir, "..", "styles.css"), "utf8");
    const match = css.match(new RegExp(`${name}:\\s*([^;]+);`));

    return match?.[1].trim() ?? "";
}

describe("colour maths", () => {
    test("contrast of black on white is 21 and readable text flips on a light fill", () => {
        expect(Math.round(contrastRatio("#000", "#ffffff"))).toBe(21);
        expect(readableTextOn("#eda100")).toBe("#111318");
        expect(readableTextOn("rgb(40, 40, 120)")).toBe("#ffffff");
    });
});

describe("Tooltip", () => {
    const viewport = { viewportWidth: 1024, viewportHeight: 768 };

    test("placement: pointer offset, kept inside on the right, flipped above near the bottom", () => {
        expect(placeTooltip({ x: 100, y: 100, width: 200, height: 80, mode: "pointer", ...viewport })).toEqual({
            left: 114,
            top: 112,
        });
        const right = placeTooltip({ x: 1000, y: 100, width: 200, height: 80, mode: "pointer", ...viewport });
        expect(right.left + 200).toBe(1024 - 8);
        const bottom = placeTooltip({ x: 100, y: 740, width: 200, height: 80, mode: "pointer", ...viewport });
        expect(bottom.top).toBe(740 - 12 - 80);
    });

    test("pointer at (100, 100) places the card at (114, 112) and links aria-describedby", async () => {
        const dom = await mountDom(
            <Tooltip content={{ title: "Task", rows: [{ k: "Hours", v: "8.0 h" }] }}>
                <button type="button">target</button>
            </Tooltip>
        );
        const button = dom.container.querySelector("button");
        await dom.pointer(button, "pointermove", { clientX: 100, clientY: 100, pointerType: "mouse" });
        const card = dom.window.document.querySelector<HTMLElement>('[role="tooltip"]');

        expect(card?.style.left).toBe("114px");
        expect(card?.style.top).toBe("112px");
        expect(card?.textContent).toContain("8.0 h");
        expect(button?.getAttribute("aria-describedby")).toBe(card?.id ?? "missing");

        await dom.pointer(button, "pointerout", { pointerType: "mouse" });
        expect(dom.window.document.querySelector('[role="tooltip"]')).toBeNull();
        expect(button?.hasAttribute("aria-describedby")).toBe(false);
        await dom.unmount();
    });

    test("100 targets share at most one card, and a function content runs only when shown", async () => {
        let calls = 0;
        const content = (): { title: string } => {
            calls += 1;

            return { title: "lazy" };
        };
        function Target() {
            return <span {...useTooltip(content)}>cell</span>;
        }
        function Many() {
            return (
                <div>
                    {Array.from({ length: 100 }, (_, i) => (
                        <Target key={i} />
                    ))}
                </div>
            );
        }
        const dom = await mountDom(<Many />);
        expect(calls).toBe(0);
        const spans = dom.container.querySelectorAll("span");
        await dom.pointer(spans[3], "pointermove", { clientX: 10, clientY: 10, pointerType: "mouse" });
        await dom.pointer(spans[3], "pointermove", { clientX: 12, clientY: 10, pointerType: "mouse" });
        await dom.pointer(spans[50], "pointermove", { clientX: 20, clientY: 10, pointerType: "mouse" });

        expect(dom.window.document.querySelectorAll('[role="tooltip"]').length).toBe(1);
        expect(calls).toBe(2);
        await dom.unmount();
    });

    test("focus shows it, blur and Escape hide it", async () => {
        const dom = await mountDom(
            <Tooltip content="plain text tip">
                <button type="button">target</button>
            </Tooltip>
        );
        const button = dom.container.querySelector("button");
        const doc = dom.window.document;
        await dom.fire(button, new dom.window.FocusEvent("focusin", { bubbles: true }));
        expect(doc.querySelector('[role="tooltip"]')?.textContent).toBe("plain text tip");
        await dom.fire(button, new dom.window.FocusEvent("focusout", { bubbles: true }));
        expect(doc.querySelector('[role="tooltip"]')).toBeNull();

        await dom.fire(button, new dom.window.FocusEvent("focusin", { bubbles: true }));
        await dom.press(button, "Escape");
        expect(doc.querySelector('[role="tooltip"]')).toBeNull();
        expect(button?.hasAttribute("aria-describedby")).toBe(false);
        await dom.unmount();
    });

    test("default tokens: text at least 7:1 and dim at least 4.5:1 on the card", () => {
        const bg = stylesToken("--tooltip-bg");
        expect(contrastRatio(stylesToken("--tooltip-text"), bg)).toBeGreaterThanOrEqual(7);
        expect(contrastRatio(stylesToken("--tooltip-dim"), bg)).toBeGreaterThanOrEqual(4.5);
    });
});

describe("form controls", () => {
    test("Field wires the label, the id and aria-describedby for hint and error", async () => {
        const dom = await mountDom(
            <Field label="Project name" hint="Shown in the header" error="Required" required>
                <TextInput value="" onChange={() => {}} />
            </Field>
        );
        const label = dom.container.querySelector("label");
        const input = dom.container.querySelector("input");
        const describedBy = input?.getAttribute("aria-describedby")?.split(" ") ?? [];

        expect(input?.id).toBeTruthy();
        expect(label?.getAttribute("for")).toBe(input?.id ?? "missing");
        expect(describedBy.length).toBe(2);
        expect(dom.container.querySelector(`[id="${describedBy[0]}"]`)?.textContent).toContain("Shown in the header");
        expect(dom.container.querySelector(`[id="${describedBy[1]}"]`)?.getAttribute("role")).toBe("alert");
        expect(input?.getAttribute("aria-invalid")).toBe("true");
        expect(input?.className).toContain("focus-visible:outline-2");
        await dom.unmount();
    });

    test("parseNumberDraft never yields NaN", () => {
        expect(parseNumberDraft("1.")).toBe(1);
        expect(parseNumberDraft("2,5")).toBe(2.5);
        expect(parseNumberDraft("  ")).toBeNull();
        expect(parseNumberDraft("abc")).toBeUndefined();
    });

    test("NumberInput keeps the draft until blur and never commits NaN", async () => {
        const commits: Array<number | null> = [];
        const dom = await mountDom(<NumberInput value={3} onChange={(v) => commits.push(v)} unit="h" />);
        const input = dom.container.querySelector("input");
        await dom.type(input, "1.");

        expect(input?.value).toBe("1.");
        expect(commits).toEqual([]);

        await dom.fire(input, new dom.window.FocusEvent("focusout", { bubbles: true }));
        expect(commits).toEqual([1]);

        await dom.type(input, "abc");
        await dom.fire(input, new dom.window.FocusEvent("focusout", { bubbles: true }));
        expect(commits).toEqual([1]);
        expect(input?.value).toBe("3");
        await dom.unmount();
    });

    test("Button busy is disabled with aria-busy", async () => {
        const dom = await mountDom(
            <Button variant="primary" busy>
                Save
            </Button>
        );
        const button = dom.container.querySelector("button");

        expect(button?.disabled).toBe(true);
        expect(button?.getAttribute("aria-busy")).toBe("true");
        await dom.unmount();
    });

    test("FileInput rejects a file over maxBytes with visible text and passes a small one with its text", async () => {
        const picked: string[] = [];
        const dom = await mountDom(
            <FileInput maxBytes={10} read="text" onFiles={(files) => picked.push(...files.map((f) => f.text ?? ""))} />
        );
        const input = dom.container.querySelector<HTMLInputElement>("input[type=file]");
        const pick = async (file: File): Promise<void> => {
            Object.defineProperty(input, "files", { value: [file], configurable: true });
            await dom.fire(input, new dom.window.Event("change", { bubbles: true }));
            await new Promise((resolve) => setTimeout(resolve, 5));
        };

        await pick(new dom.window.File(["0123456789abcdef"], "big.csv"));
        expect(dom.container.querySelector('[role="alert"]')?.textContent).toContain("over the 10 B limit");
        expect(picked).toEqual([]);

        await pick(new dom.window.File(["a,b"], "small.csv"));
        expect(dom.container.querySelector('[role="alert"]')).toBeNull();
        expect(picked).toEqual(["a,b"]);
        expect(dom.container.textContent).toContain("small.csv (3 B)");
        await dom.unmount();
    });
});

describe("StatGrid delta", () => {
    test("only the old props render exactly the old markup", async () => {
        const dom = await mountDom(<StatGrid stats={[{ label: "Open", value: "12", tone: "warn" }]} />);

        expect(dom.html()).toBe(
            '<div class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4"><div class="rounded-card border border-line bg-panel/60 p-4"><div class="font-mono text-2xl tracking-tight text-warn">12</div><div class="mt-0.5 text-xs text-dim">Open</div></div></div>'
        );
        await dom.unmount();
    });

    test("delta tone follows the good direction, flat is neutral", () => {
        expect(statDeltaTone({ value: "+8 d", direction: "up", good: "down" })).toBe("err");
        expect(statDeltaTone({ value: "+8 d", direction: "up", good: "up" })).toBe("ok");
        expect(statDeltaTone({ value: "0 d", direction: "flat", good: "up" })).toBe("neutral");
        expect(statDeltaTone({ value: "+1", direction: "up" })).toBe("neutral");
    });

    test("the card renders the err class, a hidden sentence, a hidden glyph, the edge and auto-fit columns", async () => {
        const dom = await mountDom(
            <StatGrid
                min={170}
                stats={[
                    {
                        label: "Launch",
                        value: "4 Feb 2027",
                        edge: "err",
                        delta: { value: "+8 d", direction: "up", good: "down", baseline: "27 Jan 2027" },
                    },
                ]}
            />
        );
        const grid = dom.container.firstElementChild as HTMLElement;
        const card = grid.firstElementChild as HTMLElement;

        expect(grid.style.gridTemplateColumns).toBe("repeat(auto-fit, minmax(170px, 1fr))");
        expect(card.style.borderLeftWidth).toBe("3px");
        expect(card.style.borderLeftColor).toBe("var(--err)");
        expect(dom.container.querySelector(".text-err")).not.toBeNull();
        expect(dom.container.querySelector(".sr-only")?.textContent).toBe("up 8 d versus baseline 27 Jan 2027");
        expect(dom.container.querySelector('[aria-hidden="true"]')?.textContent).toContain("▲");
        await dom.unmount();
    });
});

/** One token from a shipped template's theme.css (the first value; `light-dark()` gives its light half). */
function templateToken(template: string, name: string, scheme: "light" | "dark" = "light"): string {
    const css = readFileSync(join(import.meta.dir, "..", "templates", template, "theme.css"), "utf8");
    const raw = css.match(new RegExp(`${name}:\\s*([^;]+);`))?.[1].trim() ?? "";
    const pair = raw.match(/^light-dark\(\s*([^,]+),\s*([^)]+)\)$/);

    if (pair) {
        return (scheme === "light" ? pair[1] : pair[2]).trim();
    }

    return raw;
}

describe("FilterChips", () => {
    const items = [
        { id: "design", label: "Design", color: "#7c5ce6", count: 4 },
        { id: "build", label: "Build", count: 7 },
        { id: "test", label: "Test", disabled: true },
    ];

    test("uncontrolled: all pressed by default, a click flips one and updates the live region", async () => {
        const seen: string[][] = [];
        const dom = await mountDom(<FilterChips items={items} label="Disciplines" onChange={(v) => seen.push(v)} />);
        const chips = dom.container.querySelectorAll('[role="group"] button');

        expect([...chips].map((c) => c.getAttribute("aria-pressed"))).toEqual(["true", "true", "true"]);
        expect(dom.container.querySelector('[role="group"]')?.getAttribute("aria-label")).toBe("Disciplines");
        await dom.click(chips[1]);

        expect(chips[1].getAttribute("aria-pressed")).toBe("false");
        expect(chips[1].className).toContain("border-dashed");
        expect(seen).toEqual([["design", "test"]]);
        expect(dom.container.querySelector('[aria-live="polite"]')?.textContent).toBe("2 of 3 shown");
        await dom.unmount();
    });

    test("controlled: the value prop decides, and All and None skip disabled chips", async () => {
        const seen: string[][] = [];
        const dom = await mountDom(
            <FilterChips items={items} value={["test"]} bulk label="Disciplines" onChange={(v) => seen.push(v)} />
        );
        const buttons = [...dom.container.querySelectorAll("button")];
        const all = buttons.find((b) => b.textContent === "All");
        const none = buttons.find((b) => b.textContent === "None");
        await dom.click(buttons[0]);
        expect(buttons[0].getAttribute("aria-pressed")).toBe("false");

        await dom.click(all);
        await dom.click(none);
        expect(seen).toEqual([["test", "design"], ["design", "build", "test"], ["test"]]);
        await dom.unmount();
    });

    test("the off state text keeps at least 3:1 in every shipped template", () => {
        for (const template of ["default", "cobalt", "bone", "forest", "steel", "tan"]) {
            expect(contrastRatio(templateToken(template, "--dim"), templateToken(template, "--panel"))).toBeGreaterThan(
                3
            );
        }
    });
});

describe("CapacityGrid", () => {
    const cols = ["S1", "S2", "S3"];

    test("capacityStatus: idle, ok, full, over", () => {
        expect(capacityStatus(0, 10)).toBe("idle");
        expect(capacityStatus(5, 10)).toBe("ok");
        expect(capacityStatus(10, 10)).toBe("full");
        expect(capacityStatus(12, 10)).toBe("over");
        expect(capacityStatus(9, 10, 0.9)).toBe("full");
    });

    test("an over cell has data-status over and the hidden sentence; null renders empty", async () => {
        const dom = await mountDom(
            <CapacityGrid cols={cols} unit="h" rows={[{ label: "Backend", load: [12, null, 0], capacity: 10 }]} />
        );
        const cells = [...dom.container.querySelectorAll("tbody td")];

        expect(cells[0].getAttribute("data-status")).toBe("over");
        expect(cells[0].querySelector(".sr-only")?.textContent).toBe(" over capacity by 2 h");
        expect((cells[0] as HTMLElement).style.outlineOffset).toBe("-1.5px");
        expect(cells[1].textContent).toBe("");
        expect(cells[1].hasAttribute("data-status")).toBe(false);
        expect(cells[2].getAttribute("data-status")).toBe("idle");
        expect(cells[2].textContent).toBe("·");
        expect(dom.container.querySelectorAll('th[scope="col"]').length).toBe(4);
        await dom.unmount();
    });

    test("a per-column capacity changes only that column's status", async () => {
        const status = async (capacity: number | number[]): Promise<Array<string | null>> => {
            const dom = await mountDom(
                <CapacityGrid cols={cols} rows={[{ label: "Design", load: [8, 8, 8], capacity }]} />
            );
            const result = [...dom.container.querySelectorAll("tbody td")].map((td) => td.getAttribute("data-status"));
            await dom.unmount();

            return result;
        };

        expect(await status(10)).toEqual(["ok", "ok", "ok"]);
        expect(await status([10, 6, 10])).toEqual(["ok", "over", "ok"]);
    });

    test("totals sum rows, columns and the grand total, ignoring nulls", async () => {
        const dom = await mountDom(
            <CapacityGrid
                cols={cols}
                totals
                rows={[
                    { label: "A", load: [1, 2, null], capacity: 10 },
                    { label: "B", load: [3, 4.5, 5], capacity: 10 },
                ]}
            />
        );
        const texts = (sel: string): string[] =>
            [...dom.container.querySelectorAll(sel)].map((n) => n.textContent ?? "");

        expect(texts('[data-total="row"]')).toEqual(["3", "12.5"]);
        expect(texts('[data-total="col"]')).toEqual(["4", "6.5", "5"]);
        expect(texts('[data-total="all"]')).toEqual(["15.5"]);
        await dom.unmount();
    });

    test("turning a cell over changes no layout input: same classes for size, an inset outline only", async () => {
        const render = async (load: number): Promise<HTMLElement | null> => {
            const dom = await mountDom(
                <CapacityGrid cols={["S1"]} rows={[{ label: "A", load: [load], capacity: 10 }]} />
            );
            const td = dom.container.querySelector<HTMLElement>("tbody td");
            await dom.unmount();

            return td;
        };
        const ok = await render(9);
        const over = await render(11);
        const sizing = (td: HTMLElement | null): string =>
            (td?.className ?? "")
                .split(" ")
                .filter((c) => /^(p[xy]?|m|w|h|text-\[|rounded)/.test(c))
                .join(" ");

        expect(sizing(over)).toBe(sizing(ok));
        expect(over?.style.outline).toContain("1.5px");
        expect(over?.style.outlineOffset).toBe("-1.5px");
    });
});

describe("auto theme", () => {
    const TONES = ["--dim", "--ok", "--warn", "--err", "--info"];

    test("contrast holds in both schemes: text 7:1, dim and tones 4.5:1 on bg and panel", () => {
        for (const scheme of ["light", "dark"] as const) {
            const token = (name: string): string => templateToken("auto", name, scheme);

            for (const surface of ["--bg", "--panel"]) {
                expect({ scheme, surface, ratio: contrastRatio(token("--text"), token(surface)) >= 7 }).toEqual({
                    scheme,
                    surface,
                    ratio: true,
                });

                for (const tone of TONES) {
                    expect({ scheme, surface, tone, ok: contrastRatio(token(tone), token(surface)) >= 4.5 }).toEqual({
                        scheme,
                        surface,
                        tone,
                        ok: true,
                    });
                }
            }
        }
    });

    test("the auto palette is cobalt by day and graphite by night", () => {
        for (const name of ["--bg", "--panel", "--text", "--dim", "--accent", "--ok", "--warn", "--err", "--info"]) {
            expect(templateToken("auto", name, "light")).toBe(templateToken("cobalt", name));
            expect(templateToken("auto", name, "dark")).toBe(templateToken("default", name));
        }
    });

    test("SERIES_COLOR has 8 entries and neighbours stay apart in both schemes", () => {
        expect(SERIES_COLOR.length).toBe(8);

        for (const scheme of ["light", "dark"] as const) {
            const colours = SERIES_COLOR.map((_, i) => {
                const raw = stylesToken(`--series-${i + 1}`);
                const pair = raw.match(/^light-dark\(\s*([^,]+),\s*([^)]+)\)$/);

                return parseCssColor((scheme === "light" ? pair?.[1] : pair?.[2]) ?? "");
            });

            for (let i = 1; i < colours.length; i += 1) {
                const a = colours[i - 1];
                const b = colours[i];
                expect(a && b).toBeTruthy();
                const distance = a && b ? Math.hypot(a.r - b.r, a.g - b.g, a.b - b.b) : 0;
                expect(distance).toBeGreaterThan(60);
            }
        }
    });

    test("the chrome pages carry the pre-paint script, keyed on THEME_STORAGE_KEY", () => {
        expect(THEME_PREPAINT_SCRIPT).toContain(`"${THEME_STORAGE_KEY}"`);

        for (const page of ["tsx.html", "page.html", "catalog.html"]) {
            const html = readFileSync(join(import.meta.dir, "..", "templates", "default", page), "utf8");
            expect(html).toContain(THEME_PREPAINT_SCRIPT);
        }
    });

    test("data-theme wins over the system, and ThemeToggle writes it and the stored choice", async () => {
        const dom = await mountDom(<ThemeToggle />);
        const root = dom.window.document.documentElement;
        const light = [...dom.container.querySelectorAll('[role="radio"]')].find((b) => b.textContent === "Light");
        await dom.click(light);

        expect(root.getAttribute("data-theme")).toBe("light");
        expect(dom.window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
        expect(resolvedColorScheme()).toBe("light");
        expect(light?.getAttribute("aria-checked")).toBe("true");

        const system = [...dom.container.querySelectorAll('[role="radio"]')].find((b) => b.textContent === "System");
        await dom.click(system);
        expect(root.hasAttribute("data-theme")).toBe(false);
        expect(dom.window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
        await dom.unmount();
    });

    test("a fenced diagram renders again after a scheme flip", async () => {
        const dom = await mountDom(<Md>{"```mermaid\ngraph TD; Q-->R\n```\n"}</Md>);
        await settle();
        const before = mermaidRendered.length;
        dom.window.document.documentElement.setAttribute("data-theme", "light");
        await settle();

        expect(mermaidRendered.length).toBeGreaterThan(before);
        expect(dom.container.querySelector("[data-mermaid-source]")).not.toBeNull();
        await dom.unmount();
    });
});

describe("SortableList", () => {
    const ITEMS = ["Alpha", "Bravo", "Charlie", "Delta"].map((name) => ({ id: name.toLowerCase(), content: name }));

    async function mountList(items = ITEMS) {
        const calls: Array<{ ids: string[]; moved: { id: string; from: number; to: number } }> = [];
        const dom = await mountDom(
            <SortableList items={items} label="Steps" onReorder={(ids, moved) => calls.push({ ids, moved })} />
        );
        const grip = (id: string): Element | null => dom.container.querySelector(`[data-sortable-item="${id}"] button`);

        return { dom, calls, grip };
    }

    test("moveItem returns a new array and leaves the input alone", () => {
        const input = ["a", "b", "c"];
        expect(moveItem(input, 0, 2)).toEqual(["b", "c", "a"]);
        expect(input).toEqual(["a", "b", "c"]);
    });

    test("Space, Down, Space reorders once with the right move and announces it", async () => {
        const { dom, calls, grip } = await mountList();
        expect(grip("alpha")?.getAttribute("aria-label")).toBe("Reorder Alpha, position 1 of 4");
        await dom.press(grip("alpha"), " ");
        await dom.press(grip("alpha"), "ArrowDown");
        expect(calls).toEqual([]);
        await dom.press(grip("alpha"), " ");

        expect(calls).toEqual([
            { ids: ["bravo", "alpha", "charlie", "delta"], moved: { id: "alpha", from: 0, to: 1 } },
        ]);
        expect(dom.container.querySelector("[data-sortable-live]")?.textContent).toBe("Moved Alpha to position 2 of 4");
        await dom.unmount();
    });

    test("Escape during a keyboard move restores and calls nothing", async () => {
        const { dom, calls, grip } = await mountList();
        await dom.press(grip("bravo"), " ");
        await dom.press(grip("bravo"), "ArrowDown");
        await dom.press(grip("bravo"), "Escape");
        const order = [...dom.container.querySelectorAll("[data-sortable-item]")].map((li) =>
            li.getAttribute("data-sortable-item")
        );

        expect(calls).toEqual([]);
        expect(order).toEqual(["alpha", "bravo", "charlie", "delta"]);
        await dom.unmount();
    });

    test("a pointer drag past the third item reorders once, on release", async () => {
        const { dom, calls, grip } = await mountList();
        dom.container.querySelectorAll<HTMLElement>("[data-sortable-item]").forEach((li, i) => {
            li.getBoundingClientRect = () => new dom.window.DOMRect(0, i * 40, 200, 36);
        });
        await dom.pointer(grip("alpha"), "pointerdown", { clientY: 18, button: 0 });
        await dom.pointer(grip("alpha"), "pointermove", { clientY: 100 });
        await dom.pointer(grip("alpha"), "pointermove", { clientY: 104 });
        expect(calls).toEqual([]);
        await dom.pointer(grip("alpha"), "pointerup", { clientY: 104 });

        expect(calls).toEqual([
            { ids: ["bravo", "charlie", "alpha", "delta"], moved: { id: "alpha", from: 0, to: 2 } },
        ]);
        await dom.unmount();
    });

    test("a disabled item can be neither picked up nor displaced", async () => {
        const items = ITEMS.map((item) => (item.id === "charlie" ? { ...item, disabled: true } : item));
        const { dom, calls, grip } = await mountList(items);
        await dom.press(grip("charlie"), " ");
        await dom.press(grip("charlie"), "ArrowDown");
        await dom.press(grip("charlie"), " ");
        expect(calls).toEqual([]);

        await dom.press(grip("alpha"), " ");
        await dom.press(grip("alpha"), "ArrowDown");
        await dom.press(grip("alpha"), "ArrowDown");
        await dom.press(grip("alpha"), " ");
        expect(calls.map((c) => c.moved)).toEqual([{ id: "alpha", from: 0, to: 1 }]);
        await dom.unmount();
    });
});

describe("Wizard", () => {
    function NameStep() {
        const [name, setName] = useState("");

        return (
            <Field label="Project name">
                <TextInput value={name} onChange={setName} />
            </Field>
        );
    }

    const tick = (): Promise<void> => act(() => new Promise<void>((resolve) => setTimeout(resolve, 5)));
    const buttonByText = (root: HTMLElement, text: string): HTMLButtonElement | undefined =>
        [...root.querySelectorAll("button")].find((b) => b.textContent?.trim() === text);
    const stepButtons = (root: HTMLElement): HTMLButtonElement[] => [
        ...root.querySelectorAll<HTMLButtonElement>("nav button"),
    ];

    function steps(extra: Partial<Record<string, Partial<WizardStep>>> = {}): WizardStep[] {
        return [
            { id: "source", label: "Source", content: <NameStep />, ...extra.source },
            { id: "map", label: "Map fields", content: <p>map</p>, optional: true, ...extra.map },
            { id: "review", label: "Review", content: <p>review</p>, ...extra.review },
        ];
    }

    test("linear mode: step 3 is locked from step 1 and a click does nothing", async () => {
        const dom = await mountDom(<Wizard steps={steps()} />);
        const third = stepButtons(dom.container)[2];

        expect(third.getAttribute("aria-disabled")).toBe("true");
        await dom.click(third);
        expect(stepButtons(dom.container)[0].getAttribute("aria-current")).toBe("step");
        expect(dom.container.querySelector("nav")?.getAttribute("aria-label")).toBeTruthy();
        await dom.unmount();
    });

    test("a validate message blocks Next and shows in an alert", async () => {
        const dom = await mountDom(<Wizard steps={steps({ source: { validate: () => "Pick a file" } })} />);
        await dom.click(buttonByText(dom.container, "Next"));
        await tick();

        expect(dom.container.querySelector('[role="alert"]')?.textContent).toBe("Pick a file");
        expect(stepButtons(dom.container)[0].getAttribute("aria-current")).toBe("step");
        await dom.unmount();
    });

    test("a typed value survives Next and Back, and the optional step offers Skip", async () => {
        const dom = await mountDom(<Wizard steps={steps()} />);
        await dom.type(dom.container.querySelector("input"), "Atlas");
        await dom.click(buttonByText(dom.container, "Next"));
        await tick();

        expect(stepButtons(dom.container)[1].getAttribute("aria-current")).toBe("step");
        await dom.click(buttonByText(dom.container, "Skip"));
        await tick();
        expect(stepButtons(dom.container)[1].getAttribute("data-status")).toBe("skipped");
        expect(stepButtons(dom.container)[2].getAttribute("aria-current")).toBe("step");

        await dom.click(buttonByText(dom.container, "Back"));
        await dom.click(buttonByText(dom.container, "Back"));
        expect(dom.container.querySelector("input")?.value).toBe("Atlas");
        await dom.unmount();
    });

    test("onFinish runs once, only from the last step, even on a double click", async () => {
        let finished = 0;
        let release: () => void = () => {};
        const onFinish = (): Promise<void> => {
            finished += 1;

            return new Promise((resolve) => {
                release = resolve;
            });
        };
        const dom = await mountDom(<Wizard steps={steps()} mode="free" onFinish={onFinish} />);
        await dom.click(buttonByText(dom.container, "Next"));
        await tick();
        expect(finished).toBe(0);

        await dom.click(stepButtons(dom.container)[2]);
        const finish = buttonByText(dom.container, "Finish");
        await dom.click(finish);
        await tick();
        await dom.click(finish);
        await tick();
        expect(finished).toBe(1);
        release();
        await tick();
        await dom.unmount();
    });

    test("with hash, a reload opens a reachable step from the URL", async () => {
        const free = await mountDom(<Wizard steps={steps()} mode="free" hash />, "http://localhost/setup#review");
        expect(stepButtons(free.container)[2].getAttribute("aria-current")).toBe("step");
        await free.click(stepButtons(free.container)[1]);
        expect(free.window.location.hash).toBe("#map");
        await free.unmount();

        const linear = await mountDom(<Wizard steps={steps()} hash />, "http://localhost/setup#review");
        expect(stepButtons(linear.container)[0].getAttribute("aria-current")).toBe("step");
        await linear.unmount();
    });

    test("Enter in a single-line field runs Next", async () => {
        const dom = await mountDom(<Wizard steps={steps()} />);
        await dom.press(dom.container.querySelector("input"), "Enter");
        await tick();

        expect(stepButtons(dom.container)[1].getAttribute("aria-current")).toBe("step");
        await dom.unmount();
    });
});

describe("EditableTable", () => {
    const COLUMNS: EditableColumn[] = [
        { key: "task", label: "Task", required: true },
        { key: "hours", label: "Hours", type: "number", total: "sum" },
        { key: "start", label: "Start", type: "date", min: "2026-09-01" },
    ];
    const ROWS: EditableRow[] = [
        { task: "Draft", hours: 4, start: "2026-09-10" },
        { task: "Review", hours: null, start: "2026-09-12" },
        { task: "Draft", hours: 2.5, start: "2026-09-14" },
    ];

    function Harness({ initial, log }: { initial: EditableRow[]; log: Array<{ rows: EditableRow[]; type: string }> }) {
        const [rows, setRows] = useState(initial);

        return (
            <EditableTable
                columns={COLUMNS}
                rows={rows}
                newRow={() => ({ task: "", hours: null, start: "" })}
                onChange={(next, change) => {
                    log.push({ rows: next, type: change.type });
                    setRows(next);
                }}
            />
        );
    }

    const cell = (root: HTMLElement, r: number, c: number): HTMLInputElement | null =>
        root.querySelector<HTMLInputElement>(`[data-cell="${r}:${c}"]`);
    const blur = async (dom: Awaited<ReturnType<typeof mountDom>>, el: Element | null): Promise<void> =>
        dom.fire(el, new dom.window.FocusEvent("focusout", { bubbles: true }));

    test("an edit hands over a new array and leaves the input rows untouched", async () => {
        const input = ROWS.map((r) => ({ ...r }));
        const frozen = ROWS.map((r) => ({ ...r }));
        const log: Array<{ rows: EditableRow[]; type: string }> = [];
        const dom = await mountDom(<Harness initial={input} log={log} />);
        await dom.type(cell(dom.container, 0, 0), "Draft plan");
        expect(log).toEqual([]);
        await blur(dom, cell(dom.container, 0, 0));

        expect(log.length).toBe(1);
        expect(log[0].rows).not.toBe(input);
        expect(log[0].rows[0].task).toBe("Draft plan");
        expect(log[0].rows[1]).toBe(input[1]);
        expect(input).toEqual(frozen);
        await dom.unmount();
    });

    test("Add appends newRow() and focuses its first input; Remove drops the right row with repeated keys", async () => {
        const log: Array<{ rows: EditableRow[]; type: string }> = [];
        const dom = await mountDom(<Harness initial={ROWS} log={log} />);
        await dom.click([...dom.container.querySelectorAll("button")].find((b) => b.textContent?.includes("Add row")));

        expect(log[0].rows.length).toBe(4);
        expect(dom.window.document.activeElement).toBe(cell(dom.container, 3, 0));

        await dom.click(dom.container.querySelector('[aria-label="Remove row 3"]'));
        expect(log[1].type).toBe("remove");
        expect(log[1].rows.map((r) => r.hours)).toEqual([4, null, null]);
        await dom.unmount();
    });

    test("required and validate set aria-invalid and fill the problem line", async () => {
        const columns: EditableColumn[] = [
            { key: "task", label: "Task", required: true },
            {
                key: "hours",
                label: "Hours",
                type: "number",
                validate: (v) => (typeof v === "number" && v > 40 ? "Too many" : undefined),
            },
        ];
        const dom = await mountDom(
            <EditableTable columns={columns} rows={[{ task: "", hours: 50 }]} onChange={() => {}} />
        );

        expect(cell(dom.container, 0, 0)?.getAttribute("aria-invalid")).toBe("true");
        expect(cell(dom.container, 0, 1)?.getAttribute("aria-invalid")).toBe("true");
        expect(cell(dom.container, 0, 1)?.title).toBe("Too many");
        expect(dom.container.querySelector("[data-editable-problems]")?.textContent).toBe("2 cells need attention");
        await dom.unmount();
    });

    test("a date below min is rejected, and committed dates stay YYYY-MM-DD", async () => {
        const log: Array<{ rows: EditableRow[]; type: string }> = [];
        const dom = await mountDom(<Harness initial={ROWS} log={log} />);
        await dom.type(cell(dom.container, 0, 2), "2026-08-01");
        await blur(dom, cell(dom.container, 0, 2));
        expect(log).toEqual([]);
        expect(dom.container.querySelector("[data-editable-live]")?.textContent).toContain("on or after 2026-09-01");

        await dom.type(cell(dom.container, 0, 2), "2026-09-20");
        await blur(dom, cell(dom.container, 0, 2));
        expect(log[0].rows[0].start).toBe("2026-09-20");
        await dom.unmount();
    });

    test("Escape restores the cell without calling onChange", async () => {
        const log: Array<{ rows: EditableRow[]; type: string }> = [];
        const dom = await mountDom(<Harness initial={ROWS} log={log} />);
        const target = cell(dom.container, 1, 0);
        await dom.type(target, "Something else");
        await dom.press(target, "Escape");
        await blur(dom, target);

        expect(log).toEqual([]);
        expect(target?.value).toBe("Review");
        await dom.unmount();
    });

    test("total sum ignores nulls", async () => {
        expect(editableTotal(COLUMNS[1], ROWS)).toBe(6.5);
        const dom = await mountDom(<EditableTable columns={COLUMNS} rows={ROWS} onChange={() => {}} />);
        expect(dom.container.querySelector('[data-total="hours"]')?.textContent).toBe("6.5");
        await dom.unmount();
    });
});
