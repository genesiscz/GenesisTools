import { describe, expect, test } from "bun:test";
import type { CmuxRunResult } from "@app/cmux/lib/cli";
import { redactTerminalPreview } from "@app/cmux/lib/live-snapshot";
import { fetchSnapshot } from "@app/dev-dashboard/lib/cmux/client";

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
                    workspaces: [{ ref: "workspace:1", id: "main", title: "Main", current_directory: "/tmp" }],
                } as T;
            }

            if (args[0] === "list-panes") {
                return {
                    panes: [
                        {
                            ref: "pane:1",
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
                        { ref: "surface:1", title: "one", type: "terminal", index: 0, selected: false },
                        { ref: "surface:2", title: "two", type: "terminal", index: 1, selected: true },
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
        expect(snapshot.workspaces).toEqual([{ id: "workspace:1", name: "Main" }]);
        expect(snapshot.panes[0]).toEqual({
            id: "pane:1",
            workspaceId: "workspace:1",
            title: "pane:1",
            active: true,
            cwd: "/tmp",
            selectedSurfaceRef: "surface:2",
            surfaceCount: 2,
            surfaces: [
                {
                    id: "surface:1",
                    title: "one",
                    type: "terminal",
                    index: 0,
                    selected: false,
                    active: false,
                    url: undefined,
                    preview: "preview surface:1",
                },
                {
                    id: "surface:2",
                    title: "two",
                    type: "terminal",
                    index: 1,
                    selected: true,
                    active: false,
                    url: undefined,
                    preview: "preview surface:2",
                },
            ],
            preview: "preview surface:2",
        });
    });

    test("redacts generated password lines from terminal previews", () => {
        const preview = [
            "tools dev-dashboard auth reset",
            "username: martin",
            "password: goRmcB4-okwe7dip3yYe9mVwqV5BKUAG",
            "curl -u 'martin:goRmcB4-okwe7dip3yYe9mVwqV5BKUAG' https://mac.foltyn.dev/",
        ].join("\n");

        expect(redactTerminalPreview(preview)).toContain("password: [redacted]");
        expect(redactTerminalPreview(preview)).toContain("curl -u 'martin:[redacted]' https://mac.foltyn.dev/");
        expect(redactTerminalPreview(preview)).not.toContain("goRmcB4");
    });
});
