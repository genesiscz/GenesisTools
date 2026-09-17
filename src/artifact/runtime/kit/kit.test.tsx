import { beforeAll, describe, expect, test } from "bun:test";
import { parsePatch } from "diff";
import { DataTable, type DataTableCell, Tabs, tabHash, tabIdFromHash } from "./data";
import { Mermaid } from "./diagrams";
import { DiffView, diffFileFromPatch, pairDiffRows } from "./diff";
import { Md, MdViewer } from "./md";
import { configureMermaid, type MermaidApi } from "./mermaid-core";
import { CodeBlock, Collapse, SegmentedControl } from "./primitives";
import { matchRoute } from "./router";
import { JsonView, Steps, TreeView, treeFromPaths } from "./structure";
import { mountDom } from "./test-dom";
import { Heatmap, Meter, meterTone, Sparkline, sparklinePath } from "./viz";

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
