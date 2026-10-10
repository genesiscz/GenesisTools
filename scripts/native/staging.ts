#!/usr/bin/env bun
/**
 * Turns the staging widget and Clicky faces on or off in the NORMAL GenesisTools.app on this machine.
 *
 *   bun scripts/native/staging.ts on|off|status|start
 *
 * The faces are gated (src/macos/GenesisTools/Sources/App/NativePreview.swift, NativeStaging): the Preview bundles
 * run them, the normal app only when the defaults key below is true. Testing in the normal app uses its real
 * privacy grants (com.genesiscz.genesistools) instead of the Preview bundle's. A normal install never sets the key.
 */
import { homedir } from "node:os";
import { join } from "node:path";

const DOMAIN = "com.genesiscz.genesistools";
const KEY = "GenesisToolsStagingFaces";
const APP = join(homedir(), "Applications", "GenesisTools.app");

function run(cmd: string[]): { ok: boolean; out: string } {
    const result = Bun.spawnSync(cmd, { stderr: "pipe" });
    return { ok: result.exitCode === 0, out: `${result.stdout}${result.stderr}`.trim() };
}

function enabled(): boolean {
    return run(["defaults", "read", DOMAIN, KEY]).out === "1";
}

const verb = process.argv[2] ?? "status";

if (verb === "on" || verb === "off") {
    const write = run(["defaults", "write", DOMAIN, KEY, "-bool", verb === "on" ? "YES" : "NO"]);
    if (!write.ok) {
        console.error(`defaults write failed: ${write.out}`);
        process.exit(1);
    }

    console.log(`Staging widget and Clicky faces ${verb === "on" ? "ON" : "OFF"} for ${DOMAIN}.`);
    if (verb === "on") {
        console.log("Start the widget: bun scripts/native/staging.ts start");
    }
} else if (verb === "status") {
    console.log(`${KEY} = ${enabled() ? "on" : "off"} (${DOMAIN})`);
} else if (verb === "start") {
    if (!enabled()) {
        console.error("Staging faces are off. Run: bun scripts/native/staging.ts on");
        process.exit(1);
    }

    const open = run(["open", "-n", "-a", APP, "--args", "--widget"]);
    if (!open.ok) {
        console.error(`open failed: ${open.out}`);
        process.exit(1);
    }

    console.log(`Started the widget from ${APP}.`);
} else {
    console.error("usage: bun scripts/native/staging.ts on|off|status|start");
    process.exit(2);
}
