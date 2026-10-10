#!/usr/bin/env bun
/**
 * Drives the running widget face without touching the pointer, and records its windows while it does.
 *
 *   bun scripts/native/widget-drive.ts send "expand right 0"
 *   bun scripts/native/widget-drive.ts windows
 *   bun scripts/native/widget-drive.ts record --seconds 6 --out <dir> "0.5:hover right 0" "1.5:expand right 0" "4:collapse"
 *
 * Commands (WidgetWindow.swift runTestCommand): `expand <edge> [group]`, `module <id> <edge> [group]`,
 * `hover <edge> [group]`, `unhover <edge> [group]`, `collapse`, `select <session key>`, `settings [page]`.
 * Edges: top, right, left. The face honours them only with staging on (`bun scripts/native/staging.ts on`) or in the
 * Preview bundle. `record` films only the widget's own windows (ScreenCaptureKit via `tools control capture record`)
 * and sends each step at its offset in seconds after the recording starts.
 */
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";

const REPO = resolve(import.meta.dir, "..", "..");
const NOTIFICATION = "com.genesiscz.genesistools.widget.test";

function send(command: string, name = NOTIFICATION): void {
    const script = `ObjC.import("Foundation");
$.NSDistributedNotificationCenter.defaultCenter.postNotificationNameObjectUserInfoDeliverImmediately(
    ${SafeJSON.stringify(name)}, $(), $({ command: ${SafeJSON.stringify(command)} }), true);`;
    const result = Bun.spawnSync(["osascript", "-l", "JavaScript", "-e", script], { stderr: "pipe" });
    if (result.exitCode !== 0) {
        throw new Error(`osascript failed: ${result.stderr.toString().trim()}`);
    }
}

function widgetPid(): number {
    const ps = Bun.spawnSync(["pgrep", "-f", "MacOS/GenesisTools --widget"]).stdout.toString().trim().split("\n");
    const pid = Number(ps.filter(Boolean)[0]);
    if (!pid) {
        throw new Error("no running widget face (bun scripts/native/staging.ts start)");
    }

    return pid;
}

interface WindowInfo {
    title: string;
    window_id: number;
    x: number;
    y: number;
    width: number;
    height: number;
}

function windows(): WindowInfo[] {
    const pid = widgetPid();
    const result = Bun.spawnSync([`${REPO}/tools`, "control", "window", "--app", String(pid), "--json"], {
        stderr: "pipe",
    });
    const parsed = SafeJSON.parse(result.stdout.toString()) as { windows?: WindowInfo[] };
    return parsed.windows ?? [];
}

async function record(args: string[]): Promise<void> {
    let seconds = 6;
    let out = "";
    const steps: { at: number; command: string }[] = [];

    for (let index = 0; index < args.length; index++) {
        const arg = args[index];
        if (arg === "--seconds") {
            seconds = Number(args[++index]);
        } else if (arg === "--out") {
            out = resolve(args[++index]);
        } else {
            const colon = arg.indexOf(":");
            steps.push({ at: Number(arg.slice(0, colon)), command: arg.slice(colon + 1) });
        }
    }

    if (!out) {
        throw new Error("record needs --out <dir>");
    }

    mkdirSync(out, { recursive: true });
    const ids = windows().map((window) => window.window_id);
    if (ids.length === 0) {
        throw new Error("the widget face shows no windows (is the widget turned on?)");
    }

    const recorder = Bun.spawn(
        [
            `${REPO}/tools`,
            "control",
            "capture",
            "record",
            "--window-ids",
            ids.join(","),
            "--canvas",
            "display",
            "--duration",
            String(seconds),
            "--active-fps",
            "30",
            "--video-out",
            `${out}/recording.mp4`,
        ],
        { cwd: out, stdout: "pipe", stderr: "pipe" }
    );
    const started = performance.now();

    for (const step of steps.sort((a, b) => a.at - b.at)) {
        const wait = step.at * 1000 - (performance.now() - started);
        if (wait > 0) {
            await Bun.sleep(wait);
        }

        send(step.command);
        console.log(`${((performance.now() - started) / 1000).toFixed(2)}s  ${step.command}`);
    }

    const [stdout, stderr, code] = await Promise.all([
        new Response(recorder.stdout).text(),
        new Response(recorder.stderr).text(),
        recorder.exited,
    ]);
    console.log(stdout.trim());
    if (code !== 0) {
        console.error(stderr.trim());
        process.exit(code);
    }
}

const [verb, ...rest] = process.argv.slice(2);

if (verb === "send" && rest[0]) {
    send(rest.join(" "));
} else if (verb === "windows") {
    for (const window of windows()) {
        console.log(`${window.window_id}  ${window.title}  ${window.x},${window.y} ${window.width}x${window.height}`);
    }
} else if (verb === "record") {
    await record(rest);
} else {
    console.error(
        'usage: bun scripts/native/widget-drive.ts send "<command>" | windows | record --seconds N --out <dir> "<t>:<command>"…'
    );
    process.exit(2);
}
