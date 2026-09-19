import { describe, expect, test } from "bun:test";
import type { BrowserMcp } from "../browser/session";
import { createBrowserListenSurface } from "./browser-surface";

const SNAPSHOT = [
    'uid=1_0 RootWebArea "Kick" url="https://kick.com/"',
    '  uid=1_6 searchbox "Search"',
    '  uid=1_8 button "Log In"',
    '  uid=1_17 link "Odablock Old School RuneScape" url="https://kick.com/odablock"',
].join("\n");

function stubMcp(calls: { name: string; args: Record<string, unknown> }[]): BrowserMcp {
    return {
        connectionId: () => "test",
        toolText: (result: unknown) => (result as { text: string }).text,
        async callTool(name: string, args: Record<string, unknown>) {
            calls.push({ name, args });
            if (name === "list_pages") {
                return { text: "0: https://kick.com/ [selected]" };
            }

            if (name === "take_snapshot") {
                return { text: SNAPSHOT };
            }

            return { text: "ok" };
        },
        async close() {},
    } as unknown as BrowserMcp;
}

describe("the browser listen surface", () => {
    test("a page node becomes a choosable row, and its uid is what the act path dispatches", async () => {
        const calls: { name: string; args: Record<string, unknown> }[] = [];
        const surface = createBrowserListenSurface({ port: 9222, pageIndex: 0, mcp: stubMcp(calls) });

        const view = await surface.see();
        expect(view.app).toBe("browser");
        expect(view.window).toContain("kick.com");
        expect(view.snapshot.startsWith("cdp:9222:")).toBe(true);

        const labels = view.candidates.map((candidate) => candidate.label);
        expect(labels).toContain("Log In");
        expect(labels.some((label) => label.includes("Odablock"))).toBe(true);
        expect(view.candidates.find((candidate) => candidate.label === "Log In")?.action).toBe("press");

        const link = view.candidates.find((candidate) => candidate.label.includes("Odablock"));
        const acted = await surface.act({ element: -1, action: "press", uid: link?.id }, view);
        expect(acted.ok).toBe(true);
        expect(calls.some((call) => call.name === "click" && call.args.uid === "1_17")).toBe(true);
    });

    test("a payload naming no row of the current snapshot is refused, not guessed at", async () => {
        const surface = createBrowserListenSurface({ port: 9222, pageIndex: 0, mcp: stubMcp([]) });
        const blank = { app: "browser", window: "", snapshot: "", candidates: [], rows: [] };
        expect(await surface.act({ element: -1, action: "press", uid: "1_17" }, blank)).toEqual({
            ok: false,
            error: "no page snapshot yet; the surface has not been observed",
        });

        const seen = await surface.see();
        void seen;
        const missing = await surface.act({ element: -1, action: "press", uid: "9_99" }, blank);
        expect(missing.ok).toBe(false);
        expect(missing.error).toContain("not a row of the current page snapshot");
    });
});
