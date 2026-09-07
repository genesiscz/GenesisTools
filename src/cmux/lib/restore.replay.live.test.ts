import { expect, test } from "bun:test";
import { restoreProfile } from "@app/cmux/lib/restore";
import { waitForTerminalText } from "@app/cmux/lib/terminal-ready";
import type { Profile } from "@app/cmux/lib/types";
import { runCmuxJSON, runCmuxOk } from "@genesiscz/utils/cmux/lib/cli";
import { paneList } from "@genesiscz/utils/cmux/lib/socket";
import { env } from "@genesiscz/utils/env";

// Regression test: 2026-09-07 screenshot — exercise the real shell, transport, setup and replay.
test.skipIf(env.getProcessEnv().RUN_LIVE !== "1" || !env.getProcessEnv().CMUX_TEST_WINDOW)(
    "restores a shell without visible setup markers or broken quoting",
    async () => {
        const title = `Restore replay verification ${crypto.randomUUID()}`;
        const profile: Profile = {
            version: 1,
            name: "replay-test",
            scope: "workspace",
            captured_at: "2026-09-07T00:00:00Z",
            cmux_version: "offline (test autosave)",
            windows: [
                {
                    ref: "window:source",
                    title: "test",
                    container_frame: { width: 800, height: 600 },
                    workspaces: [
                        {
                            ref: "workspace:source",
                            title,
                            selected: true,
                            current_directory: "/private/tmp",
                            panes: [
                                {
                                    ref: "pane:source",
                                    index: 0,
                                    columns: 80,
                                    rows: 24,
                                    pixel_frame: { x: 0, y: 0, width: 800, height: 600 },
                                    selected_surface_index: 0,
                                    surfaces: [
                                        {
                                            type: "terminal",
                                            title,
                                            cwd: "/private/tmp",
                                            command_source: "manual",
                                            screen: { text: "SAVED_TRANSCRIPT_FOR_RESTORE\n", rows: 1 },
                                            command: "printf 'CMUX_REPLAY_OK:%s\\n' 'a\\tb'; pwd",
                                        },
                                    ],
                                },
                            ],
                        },
                    ],
                },
            ],
        };
        try {
            const result = await restoreProfile(profile, {
                prefix: "",
                replay: true,
                enter: true,
                yes: true,
                dryRun: false,
                window: env.getProcessEnv().CMUX_TEST_WINDOW,
            });
            expect(result.workspaces[0].maxCellDelta).toBeNull();
            expect(result.workspaces[0].converged).toBe(false);
            const workspaceRef = result.workspaces[0].ref;
            const layout = await paneList(workspaceRef);
            const surfaceRef = layout.panes[0].selected_surface_ref;
            await waitForTerminalText({
                workspaceRef,
                surfaceRef,
                description: "test command output",
                matches: (text) => text.includes("CMUX_REPLAY_OK:a\\tb"),
            });
            const screen = await runCmuxOk(["read-screen", "--surface", surfaceRef]);
            expect(screen.stdout).toContain("CMUX_REPLAY_OK:a\\tb");
            expect(screen.stdout).toContain("/private/tmp");
            expect(screen.stdout).toContain("SAVED_TRANSCRIPT_FOR_RESTORE");
            expect(screen.stdout).not.toContain("quote>");
            expect(screen.stdout).not.toContain("cmux-ready-");
        } finally {
            const live = await runCmuxJSON<{ workspaces: Array<{ ref: string; title: string }> }>([
                "list-workspaces",
                "--window",
                env.getProcessEnv().CMUX_TEST_WINDOW!,
            ]);
            for (const workspace of live.workspaces.filter((ws) => ws.title === title)) {
                await runCmuxOk(["close-workspace", "--workspace", workspace.ref]);
            }
        }
    },
    60_000
);
