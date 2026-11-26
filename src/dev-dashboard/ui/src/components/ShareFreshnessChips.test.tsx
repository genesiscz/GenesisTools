import { afterEach, expect, spyOn, test } from "bun:test";
import { JSDOM } from "jsdom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ShareFreshnessChips } from "./ShareFreshnessChips";

let root: Root | undefined;
let restore: (() => void) | undefined;

afterEach(() => {
    act(() => root?.unmount());
    root = undefined;
    restore?.();
    restore = undefined;
});

test.each(["absent", "denied"])("share copy reports an %s clipboard and recovers on success", async (mode) => {
    const dom = new JSDOM("<!doctype html><div id='app'></div>");
    const keys = ["window", "document", "navigator", "IS_REACT_ACT_ENVIRONMENT"] as const;
    const descriptors = keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
    for (const [key, value] of Object.entries({
        window: dom.window,
        document: dom.window.document,
        navigator: dom.window.navigator,
        IS_REACT_ACT_ENVIRONMENT: true,
    })) {
        Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
    }

    restore = () => {
        for (const [key, descriptor] of descriptors) {
            if (descriptor) {
                Object.defineProperty(globalThis, key, descriptor);
            } else {
                Reflect.deleteProperty(globalThis, key);
            }
        }
        dom.window.close();
    };
    Object.defineProperty(dom.window.navigator, "clipboard", {
        configurable: true,
        value:
            mode === "absent"
                ? undefined
                : {
                      writeText: async () => {
                          throw new Error("fixture clipboard denied");
                      },
                  },
    });
    const container = dom.window.document.getElementById("app");
    if (!container) {
        throw new Error("missing clipboard test fixture");
    }

    root = createRoot(container);
    await act(async () =>
        root?.render(
            <ShareFreshnessChips
                editedAt={null}
                shares={[
                    {
                        target: "desk",
                        driver: "paired",
                        live: false,
                        isDefault: true,
                        url: "https://share.example.com/md/fixture",
                        syncedAt: null,
                        sourceModifiedAt: null,
                    },
                ]}
            />
        )
    );
    const button = container.querySelector("button");
    if (!button) {
        throw new Error("copy button did not render");
    }

    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
        await act(async () => {
            button.click();
        });
        expect(container.querySelector('[role="alert"]')?.textContent).toBe("Could not copy the link");
        const copied: string[] = [];
        Object.defineProperty(dom.window.navigator, "clipboard", {
            configurable: true,
            value: {
                writeText: async (url: string) => {
                    copied.push(url);
                },
            },
        });
        await act(async () => {
            button.click();
        });
        expect(copied).toEqual(["https://share.example.com/md/fixture"]);
        expect(container.querySelector('[role="alert"]')).toBeNull();
    } finally {
        warn.mockRestore();
    }
});
