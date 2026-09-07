import { expect, test } from "bun:test";
import { join } from "node:path";
import { readAutosaveSession } from "@app/cmux/lib/autosave";
import { loadCapturedCommands } from "@app/cmux/lib/capture-journal";
import { stableSurfaceIdForPanel } from "@app/cmux/lib/capture-surface-identity";
import { isShellPromptReady, waitForTerminalText } from "@app/cmux/lib/terminal-ready";
import { runCmuxJSON, runCmuxOk, sendSurfaceText } from "@genesiscz/utils/cmux/lib/cli";
import { paneList, workspaceCreate } from "@genesiscz/utils/cmux/lib/socket";
import { env } from "@genesiscz/utils/env";

test.skipIf(
    env.getProcessEnv().RUN_LIVE !== "1" ||
        !env.getProcessEnv().CMUX_TEST_WINDOW ||
        !env.getProcessEnv().CMUX_TEST_CAPTURE_HOME
)(
    "installed capture follows a real terminal moved between temporary workspaces",
    async () => {
        const window = env.getProcessEnv().CMUX_TEST_WINDOW!;
        const directory = join(
            env.getProcessEnv().CMUX_TEST_CAPTURE_HOME!,
            ".genesis-tools",
            "cmux",
            "command-journal"
        );
        const created: string[] = [];
        try {
            for (const suffix of ["source", "destination"]) {
                const ws = await workspaceCreate({ window, name: `Capture move check ${suffix}`, cwd: "/private/tmp" });
                created.push(ws.workspace_ref);
            }
            const sourcePane = (await paneList(created[0])).panes[0];
            const destinationPane = (await paneList(created[1])).panes[0];
            const listing = await runCmuxJSON<{ surfaces: Array<{ id: string; ref: string }> }>([
                "--id-format",
                "both",
                "list-pane-surfaces",
                "--workspace",
                created[0],
                "--pane",
                sourcePane.ref,
            ]);
            const surface = listing.surfaces[0];
            await runCmuxOk(["select-workspace", "--workspace", created[0]]);
            await waitForTerminalText({
                workspaceRef: created[0],
                surfaceRef: surface.ref,
                matches: isShellPromptReady,
                description: "test shell",
                activateOnUnavailable: true,
            });
            let stableId: string | undefined;
            for (let i = 0; i < 120; i++) {
                stableId = stableSurfaceIdForPanel(surface.id, readAutosaveSession().windows);
                if (stableId) {
                    break;
                }
                await Bun.sleep(100);
            }
            expect(stableId).toBeDefined();
            await sendSurfaceText({ surfaceRef: surface.ref, text: "print -r -- CMUX_BEFORE_MOVE_PROOF\n" });
            await waitForTerminalText({
                workspaceRef: created[0],
                surfaceRef: surface.ref,
                matches: (t) => t.includes("CMUX_BEFORE_MOVE_PROOF") && isShellPromptReady(t),
                description: "first probe",
            });
            await runCmuxOk([
                "move-surface",
                "--surface",
                surface.ref,
                "--workspace",
                created[1],
                "--pane",
                destinationPane.ref,
                "--focus",
                "false",
            ]);
            await runCmuxOk(["select-workspace", "--workspace", created[1]]);
            await sendSurfaceText({ surfaceRef: surface.ref, text: "print -r -- CMUX_AFTER_MOVE_PROOF\n" });
            await waitForTerminalText({
                workspaceRef: created[1],
                surfaceRef: surface.ref,
                matches: (t) => t.includes("CMUX_AFTER_MOVE_PROOF") && isShellPromptReady(t),
                description: "moved probe",
            });
            let captured = loadCapturedCommands({ directory }).get(stableId!);
            for (let i = 0; i < 30 && captured?.command !== "print -r -- CMUX_AFTER_MOVE_PROOF"; i++) {
                await Bun.sleep(100);
                captured = loadCapturedCommands({ directory }).get(stableId!);
            }
            expect(captured?.command).toBe("print -r -- CMUX_AFTER_MOVE_PROOF");
            expect(captured?.stableSurfaceId).toBe(stableId);
            expect(captured?.cwd).toBe("/private/tmp");
        } finally {
            const remaining = await runCmuxJSON<{ workspaces: Array<{ ref: string }> }>([
                "list-workspaces",
                "--window",
                window,
            ]);
            for (const ref of created.filter((ref) => remaining.workspaces.some((ws) => ws.ref === ref))) {
                await runCmuxOk(["close-workspace", "--workspace", ref]);
            }
        }
    },
    60_000
);
