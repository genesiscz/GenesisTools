import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { registerRestoreCommand } from "@app/cmux/commands/profiles/restore";
import { registerRestoreAfterRestartCommand } from "@app/cmux/commands/restore-after-restart";
import * as replay from "@app/cmux/lib/agent-replay";
import * as restore from "@app/cmux/lib/restore";
import { ProfileStore } from "@app/cmux/lib/store";
import { PROFILE_VERSION, type Profile } from "@app/cmux/lib/types";
import * as prompts from "@clack/prompts";
import * as health from "@genesiscz/utils/cmux/lib/health";
import { Command } from "commander";

const originalExitCode = process.exitCode;
afterEach(() => {
    mock.restore();
    process.exitCode = originalExitCode;
});

test.each([
    { restart: false, failed: true },
    { restart: true, failed: true },
    { restart: false, failed: false },
    { restart: true, failed: false },
])("restore adapters report partial failure accurately: %j", async ({ restart, failed }) => {
    process.exitCode = 0;
    const profile: Profile = {
        version: PROFILE_VERSION,
        name: "fixture",
        scope: "all",
        captured_at: "2026-01-01T00:00:00Z",
        cmux_version: "fixture",
        windows: [],
    };
    spyOn(ProfileStore.prototype, "read").mockReturnValue(profile);
    spyOn(replay, "prepareProfileForRestore").mockResolvedValue(profile);
    spyOn(health, "ensureCmuxResponsive").mockResolvedValue({
        state: "healthy",
        probes: { ping: { ok: true, ms: 1 }, identify: { ok: true, ms: 1 } },
    });
    spyOn(restore, "restoreProfile").mockResolvedValue({
        workspaces: [
            {
                ref: "workspace:1",
                title: "fixture",
                converged: !failed,
                maxCellDelta: failed ? null : 0,
                failures: failed ? [{ paneRef: "pane:1", message: "fixture failure" }] : [],
            },
        ],
    });
    const outro = spyOn(prompts, "outro").mockImplementation(() => {});
    const program = new Command();
    if (restart) {
        registerRestoreAfterRestartCommand(program);
        await program.parseAsync([
            "node",
            "fixture",
            "restore-after-restart",
            "--source",
            "profile",
            "--profile",
            "fixture",
            "--yes",
        ]);
    } else {
        registerRestoreCommand(program);
        await program.parseAsync(["node", "fixture", "restore", "fixture", "--yes"]);
    }
    expect(process.exitCode).toBe(failed ? 1 : 0);
    expect(outro.mock.calls.at(-1)?.[0]).toContain(failed ? "Partial restore" : "Done.");
});
