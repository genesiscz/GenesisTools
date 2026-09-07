import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSavedScreens } from "@app/cmux/lib/screen-cache";
import { collectTerminalScreens } from "@app/cmux/lib/screen-collector";

test("collector reads terminals only, keeps stable identity and survives a dormant terminal", async () => {
    const directory = mkdtempSync(join(tmpdir(), "cmux-collector-test-"));
    const visited: string[] = [];
    const result = await collectTerminalScreens({
        directory,
        session: {
            path: "/fixture",
            savedAtMs: 1,
            windows: [
                {
                    tabManager: {
                        workspaces: [
                            {
                                layout: { type: "pane", pane: { panelIds: [] } },
                                panels: [
                                    {
                                        id: "11111111-1111-4111-8111-111111111111",
                                        stableSurfaceId: "22222222-2222-4222-8222-222222222222",
                                        type: "terminal",
                                    },
                                    { id: "33333333-3333-4333-8333-333333333333", type: "terminal" },
                                    { id: "44444444-4444-4444-8444-444444444444", type: "browser" },
                                ],
                            },
                        ],
                    },
                },
            ],
        },
        readText: async (surfaceId) => {
            visited.push(surfaceId);
            if (surfaceId.startsWith("3333")) {
                throw new Error("Failed to read terminal text");
            }
            return "example output";
        },
    });
    expect(visited).toEqual(["11111111-1111-4111-8111-111111111111", "33333333-3333-4333-8333-333333333333"]);
    expect(result).toMatchObject({ saved: 1, unavailable: 1 });
    expect(loadSavedScreens({ directory }).get("22222222-2222-4222-8222-222222222222")?.text).toBe("example output");
});
