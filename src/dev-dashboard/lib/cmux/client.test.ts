import { describe, expect, test } from "bun:test";
import { fetchSnapshot } from "@app/dev-dashboard/lib/cmux/client";
import type { CmuxRunResult } from "@genesiscz/utils/cmux/lib/cli";
import { redactTerminalPreview } from "@genesiscz/utils/cmux/lib/live-snapshot";

describe("cmux client", () => {
    test("fetchSnapshot returns available=false when cmux CLI throws", async () => {
        const runJson = async <T>(): Promise<T> => {
            throw new Error("cmux not running");
        };

        const snapshot = await fetchSnapshot({ runJson });

        expect(snapshot.available).toBe(false);
        expect(snapshot.error).toContain("cmux not running");
        expect(snapshot.workspaces).toEqual([]);
        expect(snapshot.panes).toEqual([]);
    });

    test("fetchSnapshot maps workspaces, panes, surfaces, and per-surface previews", async () => {
        const runJson = async <T>(args: string[]): Promise<T> => {
            if (args[0] === "list-workspaces") {
                return {
                    workspaces: [{ ref: "workspace:1", id: "WS-UUID", title: "Main", current_directory: "/tmp" }],
                } as T;
            }

            if (args[0] === "list-panes") {
                return {
                    panes: [
                        {
                            id: "PANE-UUID",
                            ref: "pane:1",
                            selected_surface_id: "S2-UUID",
                            selected_surface_ref: "surface:2",
                            focused: true,
                            surface_count: 2,
                        },
                    ],
                } as T;
            }

            if (args[0] === "list-pane-surfaces") {
                return {
                    surfaces: [
                        { id: "S1-UUID", ref: "surface:1", title: "one", type: "terminal", index: 0, selected: false },
                        { id: "S2-UUID", ref: "surface:2", title: "two", type: "terminal", index: 1, selected: true },
                    ],
                } as T;
            }

            throw new Error(`unexpected json command ${args.join(" ")}`);
        };
        const run = async (args: string[]): Promise<CmuxRunResult> => {
            const surface = args[args.indexOf("--surface") + 1];

            return {
                code: 0,
                stdout: `preview ${surface}`,
                stderr: "",
            };
        };

        const snapshot = await fetchSnapshot({ run, runJson });

        expect(snapshot.available).toBe(true);
        // Every id is the cmux UUID; the refs ride along for display (cmux renumbers them at a relaunch).
        expect(snapshot.workspaces).toEqual([{ id: "WS-UUID", ref: "workspace:1", name: "Main" }]);
        expect(snapshot.panes[0]).toEqual({
            id: "PANE-UUID",
            ref: "pane:1",
            workspaceId: "WS-UUID",
            title: "pane:1",
            active: true,
            cwd: "/tmp",
            selectedSurfaceId: "S2-UUID",
            selectedSurfaceRef: "surface:2",
            surfaceCount: 2,
            surfaces: [
                {
                    id: "S1-UUID",
                    ref: "surface:1",
                    title: "one",
                    type: "terminal",
                    index: 0,
                    selected: false,
                    active: false,
                    url: undefined,
                    preview: "preview S1-UUID",
                },
                {
                    id: "S2-UUID",
                    ref: "surface:2",
                    title: "two",
                    type: "terminal",
                    index: 1,
                    selected: true,
                    active: false,
                    url: undefined,
                    preview: "preview S2-UUID",
                },
            ],
            preview: "preview S2-UUID",
        });
    });

    test("redacts generated password lines from terminal previews", () => {
        const preview = [
            "tools dev-dashboard auth reset",
            "username: martin",
            "password: EXAMPLE_SECRET_PW_123",
            "curl -u 'martin:EXAMPLE_SECRET_PW_123' https://dashboard.example.test/",
        ].join("\n");

        expect(redactTerminalPreview(preview)).toContain("password: [redacted]");
        expect(redactTerminalPreview(preview)).toContain("curl -u 'martin:[redacted]' https://dashboard.example.test/");
        expect(redactTerminalPreview(preview)).not.toContain("EXAMPLE_SECRET_PW");
    });
});
