import { describe, expect, test } from "bun:test";
import { DataTable, Tabs, tabHash, tabIdFromHash } from "./data";
import { MdViewer } from "./md";
import { Collapse } from "./primitives";
import { matchRoute } from "./router";
import { mountDom } from "./test-dom";

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
