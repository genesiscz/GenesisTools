import { JSDOM } from "jsdom";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

/**
 * Minimal DOM harness for the kit's component tests. The kit runs in a browser,
 * so its hash/effect/lifecycle behaviour cannot be pinned by a pure function
 * test; jsdom plus React's own `act` is enough and needs no extra dependency.
 */
export interface DomHarness {
    window: JSDOM["window"];
    container: HTMLElement;
    render: (node: ReactNode) => Promise<void>;
    /** Dispatch a click and flush the React work it schedules. */
    click: (element: Element | null | undefined) => Promise<void>;
    /** Dispatch a keydown and flush the React work it schedules. */
    press: (element: Element | null | undefined, key: string) => Promise<void>;
    html: () => string;
    unmount: () => Promise<void>;
}

export async function mountDom(node: ReactNode, url = "http://localhost/"): Promise<DomHarness> {
    const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url });
    Object.assign(globalThis, {
        window: dom.window,
        document: dom.window.document,
        navigator: dom.window.navigator,
        history: dom.window.history,
        location: dom.window.location,
        getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
        HTMLElement: dom.window.HTMLElement,
        Element: dom.window.Element,
        Node: dom.window.Node,
        IS_REACT_ACT_ENVIRONMENT: true,
    });

    const container = dom.window.document.getElementById("root") as unknown as HTMLElement;
    let root: Root | null = createRoot(container);

    const render = async (next: ReactNode): Promise<void> => {
        await act(async () => {
            root?.render(next);
        });
    };

    await render(node);

    const click = async (element: Element | null | undefined): Promise<void> => {
        await act(async () => {
            element?.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
        });
    };

    const press = async (element: Element | null | undefined, key: string): Promise<void> => {
        await act(async () => {
            element?.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key, bubbles: true }));
        });
    };

    return {
        window: dom.window,
        container,
        render,
        click,
        press,
        html: () => container.innerHTML,
        unmount: async () => {
            await act(async () => {
                root?.unmount();
                root = null;
            });
        },
    };
}
