import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerRestoreCommand } from "@app/cmux/commands/profiles/restore";
import { registerRestoreAfterRestartCommand } from "@app/cmux/commands/restore-after-restart";
import * as replay from "@app/cmux/lib/agent-replay";
import * as restore from "@app/cmux/lib/restore";
import * as restartLib from "@app/cmux/lib/restore-after-restart";
import { profileJournalJoin } from "@app/cmux/lib/restore-after-restart";
import { ProfileStore } from "@app/cmux/lib/store";
import { PROFILE_VERSION, type Profile, type Surface } from "@app/cmux/lib/types";
import * as prompts from "@clack/prompts";
import * as health from "@genesiscz/utils/cmux/lib/health";
import { SafeJSON } from "@genesiscz/utils/json";
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
                id: "11111111-1111-4111-8111-111111111111",
                ref: "workspace:1",
                title: "fixture",
                converged: !failed,
                maxCellDelta: failed ? null : 0,
                failures: failed ? [{ pane: "pane:1", message: "fixture failure" }] : [],
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

// F22 of the restore-paths review: an unreadable or empty surface journal gave "no session id resolved" for every
// tab with nothing saying the join itself had failed.
function terminalTab(surfaceId: string | undefined): Surface {
    return { type: "terminal", title: "tab", surface_id: surfaceId };
}

function profileOf(surfaces: Surface[]): Profile {
    return {
        version: PROFILE_VERSION,
        name: "fixture",
        scope: "all",
        captured_at: "2026-01-01T00:00:00Z",
        cmux_version: "fixture",
        windows: [
            {
                ref: "window:1",
                title: "w",
                container_frame: { width: 800, height: 600 },
                workspaces: [
                    {
                        ref: "workspace:1",
                        title: "ws",
                        selected: true,
                        panes: [
                            {
                                ref: "pane:1",
                                index: 0,
                                columns: 80,
                                rows: 24,
                                pixel_frame: { x: 0, y: 0, width: 800, height: 600 },
                                selected_surface_index: 0,
                                surfaces,
                            },
                        ],
                    },
                ],
            },
        ],
    };
}

test("profileJournalJoin counts the terminal tabs the journal names; a tab with no surface UUID is not found", () => {
    const refsPath = join(mkdtempSync(join(tmpdir(), "cmux-join-")), "cmux-refs.jsonl");
    writeFileSync(
        refsPath,
        `${SafeJSON.stringify({ sessionId: "11111111-1111-4111-8111-111111111111", surfaceId: "SURF-1", at: Date.now() })}\n`
    );
    const profile = profileOf([
        terminalTab("surf-1"),
        terminalTab("surf-2"),
        terminalTab(undefined),
        { type: "browser", title: "docs" },
    ]);

    expect(profileJournalJoin(profile, { refsPath })).toMatchObject({ tabs: 3, recorded: 1 });
});

test("the restore plan and the --list output say how many tabs were found in the surface journal", async () => {
    process.exitCode = 0;
    const profile = profileOf([terminalTab("surf-1"), terminalTab("surf-2")]);
    spyOn(ProfileStore.prototype, "read").mockReturnValue(profile);
    spyOn(replay, "prepareProfileForRestore").mockResolvedValue(profile);
    spyOn(restartLib, "profileJournalJoin").mockReturnValue({
        tabs: 14,
        recorded: 13,
        agentTabs: 0,
        unrecordedAgentTabs: [],
    });
    const notes = spyOn(prompts, "note").mockImplementation(() => {});
    const info = spyOn(prompts.log, "info").mockImplementation(() => {});
    spyOn(prompts, "outro").mockImplementation(() => {});

    for (const flag of ["--dry-run", "--list"]) {
        const program = new Command();
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
            flag,
        ]);
    }

    const plan = notes.mock.calls.find((call) => String(call[1]).startsWith("Restore plan"));
    expect(String(plan?.[0])).toContain("13 of 14 tabs found in the surface journal");
    expect(info.mock.calls.map((call) => String(call[0]))).toContain("13 of 14 tabs found in the surface journal");
});
