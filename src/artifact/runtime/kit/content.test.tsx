import { describe, expect, test } from "bun:test";
import { SafeJSON } from "@genesiscz/utils/json";
import { parsePatch } from "diff";
import { DataTable } from "./data";
import { DiffView, diffFileFromPatch, pairDiffRows } from "./diff";
import { Card, Claim, ClaimList, CodeBlock, Page, SegmentedControl, Superseded } from "./primitives";
import { mountDom } from "./test-dom";

describe("content contracts", () => {
    test("split context retains each side's line numbers after an insertion", async () => {
        const patch = "--- before\n+++ after\n@@ -1,2 +1,3 @@\n+inserted\n first\n second\n";
        const pairs = pairDiffRows(diffFileFromPatch(parsePatch(patch)[0]).hunks[0].rows);
        expect(pairs[1].left?.oldNo).toBe(1);
        expect(pairs[1].right?.newNo).toBe(2);
        const dom = await mountDom(<DiffView patch={patch} mode="split" wrap />);
        try {
            const row = [...dom.container.querySelectorAll("tr")].find((entry) => entry.textContent?.includes("first"));
            expect(row?.children[0].textContent).toBe("1");
            expect(row?.children[2].textContent).toBe("2");
            expect(dom.container.querySelectorAll("colgroup col")).toHaveLength(4);
            expect(dom.html()).not.toContain("break-all");
        } finally {
            await dom.unmount();
        }
    });

    test("JSON values compare in stable nested key order and preserve array order", async () => {
        const dom = await mountDom(
            <DiffView beforeValue={{ z: [{ b: 2, a: 1 }], a: null }} afterValue={{ a: null, z: [{ a: 1, b: 2 }] }} />
        );
        try {
            expect(dom.container.textContent).toContain("no changes");
            await dom.render(<DiffView beforeValue={[1, 2]} afterValue={[2, 1]} />);
            expect(dom.container.textContent).not.toContain("no changes");
            await dom.render(<DiffView beforeValue={null} afterValue="null" />);
            expect(dom.container.textContent).not.toContain("no changes");
        } finally {
            await dom.unmount();
        }
    });

    test("JSON maxString truncates values, keeps full titles and copies the original", async () => {
        const key = "a deliberately long key";
        const value = 'a long "quoted" value <script> & more';
        const source = SafeJSON.stringify({ [key]: value, small: "ok" }, null, 2);
        const dom = await mountDom(
            <CodeBlock lang="json" wrap maxString={8}>
                {source}
            </CodeBlock>
        );
        let copied = "";
        Object.defineProperty(dom.window.navigator, "clipboard", {
            value: {
                writeText: async (text: string) => {
                    copied = text;
                },
            },
        });
        try {
            expect(dom.container.querySelector("pre")?.textContent).toContain(key);
            expect(dom.container.querySelector("pre")?.textContent).toContain('a long \\"…');
            expect(dom.container.querySelector("[title]")?.getAttribute("title")).toBe(value);
            expect(dom.container.querySelector("script")).toBeNull();
            await dom.click(dom.container.querySelector("button"));
            expect(copied).toBe(source);
            await dom.render(
                <CodeBlock lang="json" copy={false} maxString={8} badLines={[2]}>
                    {source}
                </CodeBlock>
            );
            expect(dom.container.querySelector("[title]")?.getAttribute("title")).toBe(value);
            expect(dom.container.querySelector("pre > span.bg-err\\/15")).not.toBeNull();
        } finally {
            await dom.unmount();
        }
    });

    test("Claim renders inline markdown proof and file marks", async () => {
        const dom = await mountDom(
            <Claim proof="Measured **twice** in `retry()`" marks={[{ path: "src/retry.ts", lines: "3-5" }]}>
                The retry is capped.
            </Claim>
        );
        try {
            expect(dom.container.querySelector("strong")?.textContent).toBe("twice");
            expect(dom.container.textContent).toContain("src/retry.ts:3-5");
            expect(dom.container.querySelector("strong")?.closest("p")).toBeNull();
        } finally {
            await dom.unmount();
        }
    });

    test("disabled segmented options explain their reason and cannot select", async () => {
        const changes: string[] = [];
        const dom = await mountDom(
            <SegmentedControl
                value="live"
                onChange={(value) => changes.push(value)}
                options={[
                    { value: "live", label: "Live" },
                    { value: "preview", label: "Preview", disabled: "Publishing is off" },
                ]}
            />
        );
        try {
            const options = dom.container.querySelectorAll("button");
            expect(options[1].disabled).toBe(true);
            expect(options[1].getAttribute("aria-disabled")).toBe("true");
            expect(options[1].getAttribute("title")).toBe("Publishing is off");
            // Keyboard and screen-reader users get the reason from the group, without a pointer hover.
            const group = dom.container.querySelector('[role="radiogroup"]');
            const reasons = dom.container.querySelector(`[id="${group?.getAttribute("aria-describedby")}"]`);
            expect(reasons?.textContent).toBe("Preview is unavailable: Publishing is off.");
            expect(options[1].className).toContain("line-through");
            await dom.click(options[1]);
            expect(changes).toEqual([]);
            await dom.click(options[0]);
            expect(changes).toEqual(["live"]);
        } finally {
            await dom.unmount();
        }
    });

    test("CodeBlock auto surface follows its Card, with a framed opt-in", async () => {
        const dom = await mountDom(
            <Page>
                <Card kicker="Output">
                    <CodeBlock copy={false}>plain</CodeBlock>
                    <CodeBlock surface="framed" copy={false}>
                        framed
                    </CodeBlock>
                </Card>
                <CodeBlock copy={false}>standalone</CodeBlock>
            </Page>
        );
        try {
            expect(dom.container.querySelector("[data-artifact-page]")).not.toBeNull();
            const blocks = dom.container.querySelectorAll("[data-artifact-codeblock]");
            expect([...blocks].map((block) => block.getAttribute("data-surface"))).toEqual([
                "plain",
                "framed",
                "framed",
            ]);
            expect(dom.container.querySelector("[data-artifact-card] [style]")?.getAttribute("style")).toContain(
                "var(--dim)"
            );
        } finally {
            await dom.unmount();
        }
    });

    test("ClaimList carries every fact's evidence to Claim", async () => {
        const dom = await mountDom(
            <ClaimList
                facts={[
                    {
                        text: "Bounded retries",
                        confidence: 90,
                        proof: "At most **three** attempts",
                        marks: [{ path: "src/retry.ts", lines: "2" }],
                    },
                ]}
            />
        );
        try {
            expect(dom.container.textContent).toContain("90%");
            expect(dom.container.querySelector("strong")?.textContent).toBe("three");
            expect(dom.container.textContent).toContain("src/retry.ts:2");
        } finally {
            await dom.unmount();
        }
    });

    test("Superseded keeps the reason outside the deleted content", async () => {
        const dom = await mountDom(
            <Superseded reason="Replaced after measurement">
                <p>The previous conclusion.</p>
            </Superseded>
        );
        try {
            expect(dom.container.textContent).toContain("Replaced after measurement");
            expect(dom.container.querySelector("del")?.textContent).toBe("The previous conclusion.");
            expect(dom.container.querySelector("del")?.textContent).not.toContain("Replaced after measurement");
        } finally {
            await dom.unmount();
        }
    });

    test("DataTable supports tone with per-cell markdown", async () => {
        const dom = await mountDom(
            <DataTable
                columns={[{ key: "status", label: "Status" }]}
                rows={[{ status: { text: "**Ready** `v2`", tone: "ok", md: true } }]}
            />
        );
        try {
            expect(dom.container.querySelector("td .text-ok strong")?.textContent).toBe("Ready");
            expect(dom.container.querySelector("td code")?.textContent).toBe("v2");
        } finally {
            await dom.unmount();
        }
    });
});
