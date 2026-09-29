import { describe, expect, test } from "bun:test";
import type { DomAction, DomSnapshot } from "@app/chrome-devtools/lib/dom/in-page";
import type { DomActResult } from "@app/chrome-devtools/lib/dom/page";
import type { DomPageDriver } from "../loop/browser";
import { createBrowserListenSurface } from "./browser-surface";

const KICK: DomSnapshot = {
    url: "https://kick.com/",
    title: "Kick",
    text: "Kick",
    actions: [
        { id: "n6f", node: 6, kind: "fill", role: "searchbox", label: "Search", guard: "g6", value: "" },
        { id: "n8", node: 8, kind: "click", role: "button", label: "Log In", guard: "g8" },
        {
            id: "n17",
            node: 17,
            kind: "click",
            role: "link",
            label: "Odablock Old School RuneScape",
            href: "https://kick.com/odablock",
            guard: "g17",
        },
    ],
    omitted: 0,
    belowFold: 0,
    belowFoldLabels: [],
    secretFields: [],
    canScrollDown: false,
    canScrollUp: false,
    historyLength: 1,
    marker: "k1",
};

function scriptedPage(clicks: string[]): DomPageDriver {
    const done = (): Promise<DomActResult> =>
        Promise.resolve({ ok: true, settled: { reason: "quiet", mutations: 1, ms: 5 } });
    return {
        snapshot: async () => KICK,
        click: (action: DomAction) => {
            clicks.push(action.id);
            return done();
        },
        fill: done,
        select: done,
        scroll: done,
        wait: done,
        back: done,
        reload: done,
        navigate: done,
        close: () => {},
    };
}

describe("the browser listen surface", () => {
    test("a page node becomes a choosable row, and its id is what the act path dispatches", async () => {
        const clicks: string[] = [];
        const surface = createBrowserListenSurface({
            port: 9222,
            pageIndex: 0,
            openPage: async () => scriptedPage(clicks),
        });

        const view = await surface.see();
        expect(view.app).toBe("browser");
        expect(view.window).toContain("kick.com");
        expect(view.snapshot.startsWith("dom:9222:")).toBe(true);

        const labels = view.candidates.map((candidate) => candidate.label);
        expect(labels).toContain("Log In");
        expect(labels.some((label) => label.includes("Odablock"))).toBe(true);
        expect(view.candidates.find((candidate) => candidate.label === "Log In")?.action).toBe("press");

        const link = view.candidates.find((candidate) => candidate.label.includes("Odablock"));
        const acted = await surface.act({ element: -1, action: "press", uid: link?.id }, view);
        expect(acted.ok).toBe(true);
        expect(clicks).toEqual(["n17"]);
    });

    test("a payload naming no row of the current snapshot is refused, not guessed at", async () => {
        const clicks: string[] = [];
        const surface = createBrowserListenSurface({
            port: 9222,
            pageIndex: 0,
            openPage: async () => scriptedPage(clicks),
        });
        const blank = { app: "browser", window: "", snapshot: "", candidates: [], rows: [] };
        expect(await surface.act({ element: -1, action: "press", uid: "n17" }, blank)).toEqual({
            ok: false,
            error: "no page snapshot yet; the surface has not been observed",
        });

        await surface.see();
        const missing = await surface.act({ element: -1, action: "press", uid: "n99" }, blank);
        expect(missing.ok).toBe(false);
        expect(missing.error).toContain("not a row of the current page snapshot");
        expect(clicks).toEqual([]);
    });
});
