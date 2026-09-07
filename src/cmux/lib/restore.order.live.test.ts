import { expect, test } from "bun:test";
import { restoreProfile } from "@app/cmux/lib/restore";
import type { Profile } from "@app/cmux/lib/types";
import { runCmuxJSON, runCmuxOk } from "@genesiscz/utils/cmux/lib/cli";
import { env } from "@genesiscz/utils/env";

// Regression test: 2026-09-07 live audit — workspace insertion reverses the saved order.
test.skipIf(env.getProcessEnv().RUN_LIVE !== "1" || !env.getProcessEnv().CMUX_TEST_WINDOW)(
    "restores workspace order in the real cmux window",
    async () => {
        const created: string[] = [];
        const profile: Profile = {
            version: 1,
            name: "restore-order-test",
            scope: "window",
            captured_at: "2026-09-07T00:00:00Z",
            cmux_version: "test",
            windows: [
                {
                    ref: "window:source",
                    title: "test",
                    container_frame: { width: 800, height: 600 },
                    workspaces: ["first", "second", "third"].map((title, i) => ({
                        ref: `workspace:source-${i}`,
                        title: `Restore verification ${title}`,
                        selected: i === 0,
                        panes: [],
                    })),
                },
            ],
        };
        try {
            await restoreProfile(
                profile,
                {
                    prefix: "",
                    replay: false,
                    enter: false,
                    yes: true,
                    dryRun: false,
                    window: env.getProcessEnv().CMUX_TEST_WINDOW,
                },
                {
                    onWorkspaceDone: ({ ref }) => {
                        created.push(ref);
                    },
                }
            );
            const layout = await runCmuxJSON<{ window_ref: string }>(["list-panes", "--workspace", created[0]]);
            const live = await runCmuxJSON<{ workspaces: Array<{ ref: string; index: number }> }>([
                "list-workspaces",
                "--window",
                layout.window_ref,
            ]);
            expect(
                live.workspaces
                    .filter((ws) => created.includes(ws.ref))
                    .sort((a, b) => a.index - b.index)
                    .map((ws) => ws.ref)
            ).toEqual(created);
        } finally {
            for (const ref of created) {
                await runCmuxOk(["close-workspace", "--workspace", ref]);
            }
        }
    },
    30_000
);
