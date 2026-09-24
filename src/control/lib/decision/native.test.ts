import { describe, expect, test } from "bun:test";
import type { AxResult } from "../runner";
import { deeperSeeDepth, MAX_SEE_DEPTH, NativeControlDriver, overflowsObservation } from "./native";
import { candidatesFor } from "./observation";

function observation(): AxResult {
    return {
        ok: true,
        app: "Electron App",
        pid: 4242,
        snapshot: "eyJkZXB0aCI6",
        window: { id: 7, title: "Electron App" },
        scope: "window",
        elements: [{ index: 0, depth: 0, role: "AXWindow", AXTitle: "Electron App" }],
    } as unknown as AxResult;
}

describe("see depth escalation", () => {
    test("deeperSeeDepth doubles the refused depth and stops at the ax-tool ceiling", () => {
        expect(deeperSeeDepth("AX tree exceeds --depth 20; increase depth and run see again")).toBe(40);
        expect(deeperSeeDepth("AX tree exceeds --depth 40; increase depth and run see again")).toBe(MAX_SEE_DEPTH);
        expect(deeperSeeDepth("AX tree exceeds --depth 50; increase depth and run see again")).toBeNull();
        expect(deeperSeeDepth("element does not expose AXRaise")).toBeNull();
        expect(deeperSeeDepth(undefined)).toBeNull();
    });

    test("observe retries deeper when ax-tool refuses a shallow tree, and keeps the depth", async () => {
        const seen: string[][] = [];
        const driver = new NativeControlDriver({
            app: "Electron App",
            run: async ({ args }) => {
                seen.push(args);
                const depth = args.includes("--depth") ? Number(args[args.indexOf("--depth") + 1]) : 20;
                if (depth < 40) {
                    return {
                        ok: false,
                        error: `AX tree exceeds --depth ${depth}; increase depth and run see again`,
                    } as AxResult;
                }

                return observation();
            },
        });

        expect((await driver.observe({})).pid).toBe(4242);
        expect(seen).toHaveLength(2);
        expect(seen[0]).not.toContain("--depth");
        expect(seen[1].slice(seen[1].indexOf("--depth"), seen[1].indexOf("--depth") + 2)).toEqual(["--depth", "40"]);

        await driver.observe({});
        expect(seen).toHaveLength(3);
        expect(seen[2]).toContain("40");
    });

    test("observe still fails when the ceiling itself is refused", async () => {
        const driver = new NativeControlDriver({
            app: "Electron App",
            depth: MAX_SEE_DEPTH,
            run: async () =>
                ({
                    ok: false,
                    error: `AX tree exceeds --depth ${MAX_SEE_DEPTH}; increase depth and run see again`,
                }) as AxResult,
        });

        await expect(driver.observe({})).rejects.toThrow(/exceeds --depth 50/);
    });

    test("overflowsObservation names only the too-large-to-observe refusals", () => {
        expect(overflowsObservation("AX tree exceeds 4000 elements; snapshot refused rather than truncated")).toBe(
            true
        );
        expect(overflowsObservation("scope exceeds traversal budget")).toBe(true);
        expect(overflowsObservation('[{"code":"too_big","maximum":2000}]')).toBe(true);
        expect(overflowsObservation("AX tree exceeds --depth 20; increase depth and run see again")).toBe(false);
        expect(overflowsObservation(undefined)).toBe(false);
    });

    test("a window too large to observe whole narrows to the browser chrome once, then gives up", async () => {
        const scopes: string[] = [];
        const driver = new NativeControlDriver({
            app: "Brave Browser",
            run: async ({ args }) => {
                const scope = args[args.indexOf("--scope") + 1];
                scopes.push(scope);
                if (scope === "window") {
                    return {
                        ok: false,
                        error: "AX tree exceeds 4000 elements; snapshot refused rather than truncated",
                    } as AxResult;
                }

                return observation();
            },
        });

        expect((await driver.observe({})).pid).toBe(4242);
        expect(scopes).toEqual(["window", "chrome"]);

        const stubborn = new NativeControlDriver({
            app: "Brave Browser",
            scope: "chrome",
            run: async () => ({ ok: false, error: "AX tree exceeds 4000 elements; snapshot refused" }) as AxResult,
        });
        await expect(stubborn.observe({})).rejects.toThrow(/exceeds 4000 elements/);
    });
});

describe("act options follow the action actually dispatched", () => {
    const key = "a".repeat(64);

    function menuWindow(): AxResult {
        return {
            ...observation(),
            elements: [
                { index: 0, depth: 0, role: "AXWindow", AXTitle: "Electron App", AXFocused: true, stableKey: key },
                {
                    index: 1,
                    depth: 1,
                    role: "AXMenuButton",
                    AXTitle: "More",
                    actions: ["AXShowMenu"],
                    x: 10,
                    y: 10,
                    width: 20,
                    height: 20,
                    stableKey: key,
                    targetKey: key,
                },
            ],
        } as unknown as AxResult;
    }

    async function actArguments(action: "focus" | "press", prepare: boolean): Promise<string[]> {
        let acted: string[] = [];
        const driver = new NativeControlDriver({
            app: "Electron App",
            prepare,
            run: async ({ args }) => {
                if (args[0] === "act") {
                    acted = args;
                    return { ok: true } as AxResult;
                }

                return menuWindow();
            },
        });
        const observed = await driver.observe({});
        const candidate = candidatesFor({ observation: observed, action }).at(-1);

        if (!candidate) {
            throw new Error(`no ${action} candidate in the fixture`);
        }

        await driver.act({ observation: observed, candidate });

        return acted;
    }

    test("focus never carries --target-key, which native refuses for focus", async () => {
        const args = await actArguments("focus", false);

        expect(args).toContain("focus");
        expect(args).not.toContain("--target-key");
    });

    test("a press rewritten to perform is not prepared, which native refuses for perform", async () => {
        const args = await actArguments("press", true);

        expect(args.slice(args.indexOf("--action"), args.indexOf("--action") + 4)).toEqual([
            "--action",
            "perform",
            "--ax-action",
            "AXShowMenu",
        ]);
        expect(args).not.toContain("--prepare");
        expect(args).toContain("--target-key");
    });
});
