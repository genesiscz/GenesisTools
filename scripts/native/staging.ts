#!/usr/bin/env bun
/**
 * Turns the staging widget and Clicky faces on or off in the NORMAL GenesisTools.app on this machine, and simulates
 * denied privacy permissions there.
 *
 *   bun scripts/native/staging.ts on|off|status|start
 *   bun scripts/native/staging.ts deny <kind[:mode],kind...>
 *   bun scripts/native/staging.ts allow
 *   bun scripts/native/staging.ts show <kind>
 *
 * The faces are gated (src/macos/GenesisTools/Sources/App/NativePreview.swift, NativeStaging): the Preview bundles
 * run them, the normal app only when the defaults key below is true. Testing in the normal app uses its real
 * privacy grants (com.genesiscz.genesistools) instead of the Preview bundle's. A normal install never sets the key.
 *
 * deny writes GenesisToolsSimulateDeniedPermissions (GenesisKit Permissions/PermissionSimulation.swift): every face
 * of the app then reports those kinds as missing and shows the GenesisKit permission dialog where a feature needs
 * them, without touching TCC. Running faces read it on the next check; no relaunch is needed. Kinds:
 * input-monitoring, accessibility, microphone, speech, screen-recording, calendar, reminders, contacts,
 * full-disk-access, automation, desktop, documents, downloads, or all. Modes:
 *   <kind>         denied: the dialog explains the grant and opens its System Settings pane
 *   <kind>:ask     not asked yet: the dialog offers Continue, which lifts the simulation for that process
 *   <kind>:stale   denied in the running process, granted for a new one: the dialog offers Relaunch
 * Example: bun scripts/native/staging.ts deny input-monitoring,microphone:ask
 *
 * allow removes the key: every kind reads the real grant again.
 * show opens the dialog for one kind on its own (GenesisTools --permission-dialog <kind>); it shows only while the
 * kind is missing, so pair it with deny.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { nativeInboxState } from "@genesiscz/utils/macos/native-inbox";

const DOMAIN = "com.genesiscz.genesistools";
const KEY = "GenesisToolsStagingFaces";
const SIMULATE_KEY = "GenesisToolsSimulateDeniedPermissions";
const APP = join(homedir(), "Applications", "GenesisTools.app");

/** The ids and short names PermissionKind(id:) accepts (src/macos/GenesisKit/Sources/GenesisKit/Permissions/PermissionKind.swift). */
const KINDS = [
    "input-monitoring",
    "accessibility",
    "microphone",
    "speech",
    "screen-recording",
    "calendar",
    "reminders",
    "contacts",
    "full-disk-access",
    "automation",
    "desktop",
    "documents",
    "downloads",
    "all",
    "input",
    "listen",
    "listen-event",
    "keyboard",
    "ax",
    "mic",
    "speech-recognition",
    "dictation",
    "screen",
    "screen-capture",
    "capture",
    "calendars",
    "fda",
    "full-disk",
    "all-files",
];
const MODES = ["denied", "ask", "stale"];

function run(cmd: string[]): { ok: boolean; out: string } {
    const result = Bun.spawnSync(cmd, { stderr: "pipe" });
    return { ok: result.exitCode === 0, out: `${result.stdout}${result.stderr}`.trim() };
}

function enabled(): boolean {
    return run(["defaults", "read", DOMAIN, KEY]).out === "1";
}

function simulated(): string | null {
    const read = run(["defaults", "read", DOMAIN, SIMULATE_KEY]);
    return read.ok ? read.out : null;
}

/** Returns the entries that do not parse, so a typo fails here instead of being ignored by the app. */
function invalidEntries(value: string): string[] {
    return value
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => {
            const [kind, mode, ...rest] = entry.split(":");
            return (
                !KINDS.includes(kind.toLowerCase()) || (mode !== undefined && !MODES.includes(mode)) || rest.length > 0
            );
        });
}

const verb = process.argv[2] ?? "status";

if (verb === "on" || verb === "off") {
    const write = run(["defaults", "write", DOMAIN, KEY, "-bool", verb === "on" ? "YES" : "NO"]);
    if (!write.ok) {
        console.error(`defaults write failed: ${write.out}`);
        process.exit(1);
    }

    console.log(`Staging widget and Clicky faces ${verb === "on" ? "ON" : "OFF"} for ${DOMAIN}.`);
    // Agents' instructions follow this (src/question/lib/inbox-guidance.ts); the refresh rewrites the hooks' state file.
    console.log(`Native inbox for agents: ${nativeInboxState({ refresh: true })}`);
    if (verb === "on") {
        console.log("Start the widget: bun scripts/native/staging.ts start");
    }
} else if (verb === "status") {
    console.log(`${KEY} = ${enabled() ? "on" : "off"} (${DOMAIN})`);
    console.log(`${SIMULATE_KEY} = ${simulated() ?? "(not set: real grants)"}`);
    console.log(`Native inbox for agents: ${nativeInboxState({ refresh: true })}`);
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
} else if (verb === "deny") {
    const value = process.argv
        .slice(3)
        .join(",")
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean)
        .join(",");
    if (!value) {
        console.error("usage: bun scripts/native/staging.ts deny <kind[:ask|:stale],kind...>");
        process.exit(2);
    }

    const invalid = invalidEntries(value);
    if (invalid.length > 0) {
        console.error(`Unknown permission entries: ${invalid.join(", ")}`);
        console.error(`Kinds: ${KINDS.slice(0, 14).join(", ")}. Modes: :ask, :stale.`);
        process.exit(2);
    }

    const write = run(["defaults", "write", DOMAIN, SIMULATE_KEY, "-string", value]);
    if (!write.ok) {
        console.error(`defaults write failed: ${write.out}`);
        process.exit(1);
    }

    console.log(`Simulating missing permissions in ${DOMAIN}: ${value}`);
    console.log("Undo: bun scripts/native/staging.ts allow");
} else if (verb === "allow") {
    if (simulated() === null) {
        console.log(`${SIMULATE_KEY} is not set; every permission already reads the real grant.`);
    } else {
        const remove = run(["defaults", "delete", DOMAIN, SIMULATE_KEY]);
        if (!remove.ok) {
            console.error(`defaults delete failed: ${remove.out}`);
            process.exit(1);
        }

        console.log(`Removed ${SIMULATE_KEY}: every permission reads the real grant again.`);
    }
} else if (verb === "show") {
    const kind = process.argv[3];
    if (!kind || invalidEntries(kind).length > 0 || kind.includes(":") || kind === "all") {
        console.error("usage: bun scripts/native/staging.ts show <kind>");
        process.exit(2);
    }

    const open = run(["open", "-n", "-a", APP, "--args", "--permission-dialog", kind]);
    if (!open.ok) {
        console.error(`open failed: ${open.out}`);
        process.exit(1);
    }

    console.log(`Asked ${APP} to show the ${kind} permission dialog (it shows only while the grant is missing).`);
} else {
    console.error("usage: bun scripts/native/staging.ts on|off|status|start|deny <kinds>|allow|show <kind>");
    process.exit(2);
}
