import { describe, expect, test } from "bun:test";
import { act } from "react";
import { contrastRatio, readableTextOn } from "./color";
import { tabHash, tabIdFromHash } from "./data";
import { DecisionBoard, type DecisionPoint, decisionChoicesFromHash, decisionChoicesHash } from "./decision-board";
import { Page } from "./primitives";
import { StickyControls } from "./sticky-controls";
import { mountDom } from "./test-dom";

const POINTS: DecisionPoint[] = [
    {
        key: "source",
        number: "32",
        title: "Source",
        options: [
            { value: "cache", label: "Cache" },
            { value: "live", label: "Live" },
        ],
    },
    {
        key: "format",
        number: "33",
        title: "Format",
        locked: true,
        options: [
            { value: "object", label: "Object" },
            { value: "text", label: "Text" },
        ],
    },
];
const INITIAL = { source: "cache", format: "object" };

describe("DecisionBoard", () => {
    test("midtone foregrounds keep AA when both near-black and white miss", () => {
        expect(contrastRatio("#2a78d6", readableTextOn("#2a78d6"))).toBeGreaterThanOrEqual(4.5);
        expect(
            contrastRatio("color(srgb 0.2 0.5 0.8)", readableTextOn("color(srgb 0.2 0.5 0.8)"))
        ).toBeGreaterThanOrEqual(4.5);
    });

    test("Tabs preserves decision namespaces and reads its own plain segment", () => {
        const hash = tabHash("wiki tab", "#d=source:live&contract=contract:pipeline&ts.cost=r%3D1~2");
        expect(hash).toBe("#wiki%20tab&d=source:live&contract=contract:pipeline&ts.cost=r%3D1~2");
        expect(tabIdFromHash(hash)).toBe("wiki tab");
        expect(tabIdFromHash("#d=source:live")).toBe("");
    });

    test("hash preserves other state and validates unknown and malformed choices", () => {
        const hash = decisionChoicesHash({ hash: "#section&other=keep", choices: { source: "live", format: "text" } });
        expect(hash).toBe("#section&other=keep&d=source:live,format:text");
        expect(decisionChoicesFromHash({ hash, points: POINTS, initial: INITIAL })).toEqual({
            source: "live",
            format: "text",
        });
        expect(
            decisionChoicesFromHash({ hash: "#d=source:bad,unknown:live,%FF:bad", points: POINTS, initial: INITIAL })
        ).toEqual(INITIAL);
    });

    test("preset, changed keys, hash reload and explicit unlock drive the pure result", async () => {
        const page = (
            <DecisionBoard
                points={POINTS}
                initial={INITIAL}
                presets={[{ id: "cached", label: "Cached", choices: INITIAL }]}
            >
                {(choices, api) => <output>{`${choices.source}/${choices.format}/${api.changed.join(",")}`}</output>}
            </DecisionBoard>
        );
        const dom = await mountDom(page);
        await dom.click(dom.container.querySelector('[role="radio"][title="Live"]'));
        const live = [...dom.container.querySelectorAll('[role="radio"]')].find((node) => node.textContent === "Live");
        await dom.click(live);
        expect(dom.container.querySelector("output")?.textContent).toBe("live/object/source");
        expect(dom.window.location.hash).toContain("source:live");
        const text = [...dom.container.querySelectorAll('[role="radio"]')].find((node) =>
            node.textContent?.includes("Text")
        );
        expect(text?.getAttribute("aria-disabled")).toBe("true");
        await dom.click([...dom.container.querySelectorAll("button")].find((node) => node.textContent === "Unlock"));
        await dom.click(
            [...dom.container.querySelectorAll('[role="radio"]')].find((node) => node.textContent === "Text")
        );
        expect(dom.container.querySelector("output")?.textContent).toBe("live/text/source,format");
        const saved = dom.window.location.href;
        await dom.unmount();
        const restored = await mountDom(page, saved);
        expect(restored.container.querySelector("output")?.textContent).toBe("live/text/source,format");
        await restored.unmount();
    });

    test("a section anchor retains the current choices and repairs their hash namespace", async () => {
        const dom = await mountDom(
            <DecisionBoard points={POINTS} initial={INITIAL}>
                {(choices) => <output>{choices.source}</output>}
            </DecisionBoard>
        );
        await dom.click(
            [...dom.container.querySelectorAll('[role="radio"]')].find((node) => node.textContent === "Live")
        );
        await act(async () => {
            dom.window.history.replaceState(null, "", "#section");
            dom.window.dispatchEvent(new dom.window.HashChangeEvent("hashchange"));
        });
        expect(dom.container.querySelector("output")?.textContent).toBe("live");
        expect(dom.window.location.hash).toBe("#section&d=source:live,format:object");
        await dom.unmount();
    });

    test("partial presets retain default choices without false changed tags and respect locks", async () => {
        const dom = await mountDom(
            <DecisionBoard
                points={POINTS}
                initial={INITIAL}
                presets={[
                    { id: "partial", label: "Partial", choices: { source: "live" } },
                    { id: "locked", label: "Change locked", choices: { source: "live", format: "text" } },
                ]}
            >
                {(choices, api) => (
                    <output>{`${choices.source}/${choices.format}/${api.preset ?? "mixed"}/${api.changed.join(",")}`}</output>
                )}
            </DecisionBoard>
        );
        await dom.click(
            [...dom.container.querySelectorAll('[role="radio"]')].find((node) => node.textContent === "Partial")
        );
        expect(dom.container.querySelector("output")?.textContent).toBe("live/object/partial/");
        await dom.click(
            [...dom.container.querySelectorAll('[role="radio"]')].find((node) => node.textContent === "Change locked")
        );
        expect(dom.container.querySelector("output")?.textContent).toBe("live/object/partial/format");
        await dom.unmount();
    });

    test("presets normalize after retaining locked choices and honor an explicit unlock", async () => {
        const points = POINTS.map((point) => ({ ...point, locked: point.key === "source" }));
        const dom = await mountDom(
            <DecisionBoard
                points={points}
                initial={INITIAL}
                hash={false}
                presets={[{ id: "live-text", label: "Live text preset", choices: { source: "live", format: "text" } }]}
                normalize={(choices) => (choices.source === "cache" ? { ...choices, format: "object" } : choices)}
            >
                {(choices) => <output>{`${choices.source}/${choices.format}`}</output>}
            </DecisionBoard>
        );
        try {
            const preset = () =>
                [...dom.container.querySelectorAll('[role="radio"]')].find(
                    (node) => node.textContent === "Live text preset"
                );
            await dom.click(preset());
            expect(dom.container.querySelector("output")?.textContent).toBe("cache/object");
            await dom.click(
                [...dom.container.querySelectorAll("button")].find((node) => node.textContent === "Unlock")
            );
            await dom.click(preset());
            expect(dom.container.querySelector("output")?.textContent).toBe("live/text");
        } finally {
            await dom.unmount();
        }
    });

    test("copy uses human point numbers and expansion has its own bounded scroll", async () => {
        const dom = await mountDom(
            <DecisionBoard points={POINTS} initial={INITIAL}>
                {() => <output>Result</output>}
            </DecisionBoard>
        );
        let copied = "";
        Object.defineProperty(dom.window.navigator, "clipboard", {
            configurable: true,
            value: {
                writeText: async (text: string) => {
                    copied = text;
                },
            },
        });
        await dom.click(
            [...dom.container.querySelectorAll("button")].find((node) => node.textContent === "Copy choices")
        );
        expect(copied).toBe("32: cache, 33: object");
        await dom.click(dom.container.querySelector('[aria-expanded="false"]'));
        expect(dom.container.querySelector('[aria-expanded="true"]')).not.toBeNull();
        expect(dom.html()).toContain("max-h-[62vh]");
        await dom.unmount();
    });

    test("StickyControls follows the actual TopNav height and cleans its resize listener", async () => {
        const dom = await mountDom(
            <Page>
                <nav data-artifact-topnav="">Nav</nav>
                <StickyControls>Controls</StickyControls>
            </Page>
        );
        const nav = dom.container.querySelector("nav");
        if (!nav) {
            throw new Error("navigation missing");
        }

        nav.getBoundingClientRect = () => ({
            height: 91,
            width: 0,
            x: 0,
            y: 0,
            top: 0,
            bottom: 91,
            left: 0,
            right: 0,
            toJSON: () => ({}),
        });
        await act(async () => {
            dom.window.dispatchEvent(new dom.window.Event("resize"));
        });
        expect(dom.container.querySelector<HTMLElement>("[data-sticky-controls]")?.style.top).toBe("95px");
        await dom.unmount();
    });
});
