import { expect, test } from "bun:test";
import { restoreProfile } from "@app/cmux/lib/restore";
import type { Profile } from "@app/cmux/lib/types";
import { runCmuxJSON, runCmuxOk } from "@genesiscz/utils/cmux/lib/cli";
import { paneList } from "@genesiscz/utils/cmux/lib/socket";
import { env } from "@genesiscz/utils/env";

test.skipIf(env.getProcessEnv().RUN_LIVE !== "1" || !env.getProcessEnv().CMUX_TEST_WINDOW)(
    "restores a browser as the first tab instead of an empty terminal",
    async () => {
        const title = `Browser restore check ${crypto.randomUUID()}`;
        const window = env.getProcessEnv().CMUX_TEST_WINDOW!;
        const profile: Profile = {
            version: 1,
            name: "browser-check",
            scope: "workspace",
            captured_at: "2026-09-07T00:00:00Z",
            cmux_version: "test",
            windows: [
                {
                    ref: "window:source",
                    title: "Example",
                    container_frame: { width: 800, height: 600 },
                    workspaces: [
                        {
                            ref: "workspace:source",
                            title,
                            selected: true,
                            panes: [
                                {
                                    ref: "pane:source",
                                    index: 0,
                                    columns: 80,
                                    rows: 24,
                                    pixel_frame: { x: 0, y: 0, width: 800, height: 600 },
                                    selected_surface_index: 0,
                                    surfaces: [{ type: "browser", title: "Example", url: "about:blank" }],
                                },
                            ],
                        },
                    ],
                },
            ],
        };
        try {
            const outcome = await restoreProfile(profile, {
                prefix: "",
                replay: false,
                enter: false,
                yes: true,
                dryRun: false,
                window,
            });
            const ref = outcome.workspaces[0].ref;
            const pane = (await paneList(ref)).panes[0];
            const listing = await runCmuxJSON<{ surfaces: Array<{ type: string }> }>([
                "list-pane-surfaces",
                "--workspace",
                ref,
                "--pane",
                pane.ref,
            ]);
            expect(listing.surfaces.map((s) => s.type)).toEqual(["browser"]);
        } finally {
            const listing = await runCmuxJSON<{ workspaces: Array<{ ref: string; title: string }> }>([
                "list-workspaces",
                "--window",
                window,
            ]);
            for (const ws of listing.workspaces.filter((w) => w.title === title)) {
                await runCmuxOk(["close-workspace", "--workspace", ws.ref]);
            }
        }
    },
    30_000
);
