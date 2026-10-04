import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { env } from "@genesiscz/utils/env";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import type { DashboardKey } from "../dashboards";
import {
    readDashboardTheme,
    resolveDashboardTheme,
    serverDashboardTheme,
    subscribeDashboardTheme,
    syncDocumentClass,
    useDashboardTheme,
    writeDashboardTheme,
} from "./dashboard-theme";

/**
 * The slice of `window` the theme store touches. The in-page choice is module state, so every
 * test that writes uses its own dashboard key.
 */
function installBrowser({
    search = "",
    storage = "works",
    stored = {},
}: {
    search?: string;
    storage?: "works" | "blocked";
    stored?: Record<string, string>;
} = {}) {
    const saved = new Map(Object.entries(stored));
    const replaced: string[] = [];
    const location = { search, href: `http://127.0.0.1:3075/${search}` };
    const blocked = () => {
        throw new Error("localStorage is blocked");
    };

    const fake = {
        location,
        localStorage:
            storage === "blocked"
                ? { getItem: blocked, setItem: blocked }
                : {
                      getItem: (key: string) => saved.get(key) ?? null,
                      setItem: (key: string, value: string) => {
                          saved.set(key, value);
                      },
                  },
        history: {
            state: null,
            replaceState: (_state: unknown, _title: string, url: URL) => {
                replaced.push(url.toString());
                location.search = url.search;
                location.href = url.toString();
            },
        },
    };

    Object.defineProperty(globalThis, "window", { value: fake, configurable: true, writable: true });
    return { saved, replaced, location };
}

afterEach(() => {
    Reflect.deleteProperty(globalThis, "window");
});

describe("resolveDashboardTheme", () => {
    it("lets the URL win over every other source", () => {
        expect(
            resolveDashboardTheme({ url: "gold-bento", picked: "cyberpunk", stored: "native", server: "cyberpunk" })
        ).toBe("gold-bento");
    });

    it("then takes this page's choice, then the saved one, then what the server ships", () => {
        expect(resolveDashboardTheme({ url: null, picked: "native", stored: "gold-bento", server: "cyberpunk" })).toBe(
            "native"
        );
        expect(resolveDashboardTheme({ url: null, picked: undefined, stored: "gold-bento", server: "cyberpunk" })).toBe(
            "gold-bento"
        );
        expect(resolveDashboardTheme({ url: null, picked: undefined, stored: null, server: "cyberpunk" })).toBe(
            "cyberpunk"
        );
    });

    it("skips a value that names no theme", () => {
        expect(resolveDashboardTheme({ url: "neon", picked: undefined, stored: "neon", server: "native" })).toBe(
            "native"
        );
    });
});

describe("serverDashboardTheme", () => {
    it("uses the registry's theme field, and native where it has none", async () => {
        await env.testing.withOverrides({ VITE_GT_UI_THEME: undefined }, () => {
            expect(serverDashboardTheme("spotify")).toBe("cyberpunk");
            expect(serverDashboardTheme("personal-dashboard")).toBe("native");
        });
    });

    it("lets VITE_GT_UI_THEME override the registry, unless it names no theme", async () => {
        await env.testing.withOverrides({ VITE_GT_UI_THEME: "gold-bento" }, () => {
            expect(serverDashboardTheme("spotify")).toBe("gold-bento");
            expect(serverDashboardTheme("personal-dashboard")).toBe("gold-bento");
        });

        await env.testing.withOverrides({ VITE_GT_UI_THEME: "neon" }, () => {
            expect(serverDashboardTheme("spotify")).toBe("cyberpunk");
        });
    });
});

describe("the theme store in a browser", () => {
    it("shows a ?theme= override until the switch is used, and the switch removes it from the URL", () => {
        const browser = installBrowser({ search: "?theme=gold-bento" });
        expect(readDashboardTheme("clarity")).toBe("gold-bento");

        writeDashboardTheme("clarity", "cyberpunk");

        expect(browser.replaced).toEqual(["http://127.0.0.1:3075/"]);
        expect(browser.location.search).toBe("");
        expect(browser.saved.get("gt-ui-theme:clarity")).toBe("cyberpunk");
        expect(readDashboardTheme("clarity")).toBe("cyberpunk");
    });

    it("keeps the URL as it is when there is no override to remove", () => {
        const browser = installBrowser();
        writeDashboardTheme("youtube", "gold-bento");

        expect(browser.replaced).toEqual([]);
    });

    it("still switches on this page when localStorage is blocked", () => {
        installBrowser({ storage: "blocked" });
        const debug = spyOn(console, "debug").mockImplementation(() => {});
        expect(readDashboardTheme("shops")).toBe("cyberpunk");

        expect(() => writeDashboardTheme("shops", "gold-bento")).not.toThrow();
        expect(readDashboardTheme("shops")).toBe("gold-bento");
        expect(debug.mock.calls.map(([message]) => message)).toContain("[dashboard-theme] could not save the theme");
        debug.mockRestore();
    });

    it("applies a saved choice to its own dashboard only", () => {
        installBrowser({ stored: { "gt-ui-theme:reas": "gold-bento" } });

        expect(readDashboardTheme("reas")).toBe("gold-bento");
        expect(readDashboardTheme("jev")).toBe("cyberpunk");
    });

    it("tells the root and the header switch about the same change", () => {
        installBrowser();
        const key: DashboardKey = "monitor";
        const seen = { root: [] as string[], header: [] as string[] };
        const stopRoot = subscribeDashboardTheme(() => seen.root.push(readDashboardTheme(key)));
        const stopHeader = subscribeDashboardTheme(() => seen.header.push(readDashboardTheme(key)));

        writeDashboardTheme(key, "gold-bento");
        stopHeader();
        writeDashboardTheme(key, "cyberpunk");
        stopRoot();

        expect(seen.root).toEqual(["gold-bento", "cyberpunk"]);
        expect(seen.header).toEqual(["gold-bento"]);
    });
});

describe("syncDocumentClass", () => {
    it("replaces the previous theme class and leaves every other class alone", () => {
        const classes = new Set(["dark", "cyberpunk"]);
        const root = {
            classList: {
                add: (...tokens: string[]) => {
                    for (const token of tokens) {
                        classes.add(token);
                    }
                },
                remove: (...tokens: string[]) => {
                    for (const token of tokens) {
                        classes.delete(token);
                    }
                },
            },
        };

        syncDocumentClass("gold-bento", root);
        expect([...classes].sort()).toEqual(["dark", "gold-bento"]);

        syncDocumentClass("native", root);
        expect([...classes]).toEqual(["dark"]);
    });
});

describe("useDashboardTheme on the server", () => {
    function Probe({ themeKey }: { themeKey: DashboardKey }) {
        const { theme, className, documentClassName } = useDashboardTheme(themeKey);
        return createElement("div", { className, "data-theme": theme, "data-document": documentClassName });
    }

    it("renders what the server ships and ignores browser sources, so hydration matches", async () => {
        installBrowser({ search: "?theme=native", stored: { "gt-ui-theme:spotify": "native" } });

        await env.testing.withOverrides({ VITE_GT_UI_THEME: undefined }, () => {
            expect(renderToString(createElement(Probe, { themeKey: "spotify" }))).toBe(
                '<div class="cyberpunk" data-theme="cyberpunk" data-document="cyberpunk"></div>'
            );
        });

        await env.testing.withOverrides({ VITE_GT_UI_THEME: "gold-bento" }, () => {
            expect(renderToString(createElement(Probe, { themeKey: "spotify" }))).toBe(
                '<div class="gold-bento" data-theme="gold-bento" data-document="gold-bento"></div>'
            );
        });
    });
});
