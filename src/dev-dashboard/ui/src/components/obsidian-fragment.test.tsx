import { afterEach, describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useRevealFragment } from "./obsidian-fragment";

const NOTE = `
    <h2 id="intro">Intro</h2>
    <details><summary>Folded</summary><h2 id="deep">Deep</h2></details>
`;

let root: Root | null = null;

function mountNote(): { scrolled: string[]; container: HTMLElement; fold: HTMLDetailsElement } {
    const dom = new JSDOM(`<!doctype html><html><body><article>${NOTE}</article><div id="app"></div></body></html>`);
    const scrolled: string[] = [];
    // jsdom lays nothing out, so it has no scrollIntoView; the stub records which element was asked to scroll.
    dom.window.HTMLElement.prototype.scrollIntoView = function (this: HTMLElement) {
        scrolled.push(this.id);
    };
    Object.assign(globalThis, {
        window: dom.window,
        document: dom.window.document,
        IS_REACT_ACT_ENVIRONMENT: true,
    });
    const container = dom.window.document.getElementById("app");
    const fold = dom.window.document.querySelector("details");

    if (!container || !fold) {
        throw new Error("fixture note did not parse");
    }

    return { scrolled, container, fold };
}

function Reader({ hash }: { hash: string }) {
    useRevealFragment({ hash, html: NOTE, mounted: true });
    return null;
}

afterEach(() => {
    act(() => root?.unmount());
    root = null;
    Object.assign(globalThis, { window: undefined, document: undefined });
});

describe("useRevealFragment", () => {
    test("a new fragment in the open note opens the folds around its heading and scrolls to it", () => {
        const { scrolled, container, fold } = mountNote();
        const mounted = createRoot(container);
        root = mounted;

        act(() => mounted.render(<Reader hash="intro" />));
        expect(scrolled).toEqual(["intro"]);
        expect(fold.open).toBe(false);

        // Same note, same html: only the route's hash changed, as a `[[#Deep]]` click or a back press leaves it.
        act(() => mounted.render(<Reader hash="deep" />));
        expect(fold.open).toBe(true);
        expect(scrolled).toEqual(["intro", "deep"]);
    });
});
