import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { registerSaveCommand } from "@app/cmux/commands/profiles/save";
import * as offline from "@app/cmux/lib/offline-snapshot";
import * as snapshot from "@app/cmux/lib/snapshot";
import { ProfileStore } from "@app/cmux/lib/store";
import { PROFILE_VERSION } from "@app/cmux/lib/types";
import * as health from "@genesiscz/utils/cmux/lib/health";
import { Command } from "commander";

afterEach(() => mock.restore());

test.each([
    { explicitOffline: false, noScreen: true },
    { explicitOffline: true, noScreen: false },
    { explicitOffline: true, noScreen: true },
])("offline capture preserves the requested screen setting: %j", async ({ explicitOffline, noScreen }) => {
    spyOn(health, "probeCmuxHealth").mockResolvedValue({
        state: "ui-starved",
        probes: { ping: { ok: true, ms: 1 }, identify: { ok: false, ms: 1 } },
    });
    spyOn(snapshot, "getCmuxVersion").mockResolvedValue("fixture");
    spyOn(ProfileStore.prototype, "exists").mockReturnValue(false);
    spyOn(ProfileStore.prototype, "write").mockReturnValue("/tmp/fixture-profile.yaml");
    const capture = spyOn(offline, "captureOfflineProfile").mockResolvedValue({
        version: PROFILE_VERSION,
        name: "fixture",
        scope: "all",
        captured_at: "2026-01-01T00:00:00Z",
        cmux_version: "fixture",
        windows: [],
    });
    const program = new Command();
    registerSaveCommand(program);
    await program.parseAsync([
        "node",
        "fixture",
        "save",
        "fixture",
        ...(explicitOffline ? ["--offline"] : ["--scope", "all"]),
        ...(noScreen ? ["--no-screen"] : []),
        "--force",
    ]);
    expect(capture).toHaveBeenCalledWith({ name: "fixture", note: undefined, captureScreen: !noScreen });
});
