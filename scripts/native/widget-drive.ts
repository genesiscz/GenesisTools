#!/usr/bin/env bun
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { captureSessionsRoot } from "@app/control/lib/peekaboo";
import { type ExecResult, execTool } from "@genesiscz/utils/cli";
import { SafeJSON } from "@genesiscz/utils/json";
/**
 * Drives the running widget face without touching the pointer, and records its windows while it does.
 *
 *   bun scripts/native/widget-drive.ts send "expand right 0"
 *   bun scripts/native/widget-drive.ts windows
 *   bun scripts/native/widget-drive.ts record --seconds 6 --out <dir> "0.5:hover right 0" "1.5:expand right 0" "4:collapse"
 *
 * Commands (WidgetWindow.swift runTestCommand): `expand <edge> [group]`, `module <id> <edge> [group]`,
 * `hover <edge> [group]`, `unhover <edge> [group]`, `collapse`, `select <session key>`, `settings [page]`,
 * `passive on|off`. Send `passive on` before `expand` on the user's own screen: an expanded panel otherwise takes the
 * keyboard from the app in front.
 * Edges: top, right, left. The face honours them only with staging on (`bun scripts/native/staging.ts on`) or in the
 * Preview bundle. `--preview` (first argument) drives GenesisTools Preview.app instead of the normal app. `record` films only the widget's own windows (ScreenCaptureKit via `tools control capture record`)
 * and sends each step at its offset in seconds after the recording's first frame.
 */
import { findProcesses } from "@genesiscz/utils/process/processes";

const PREVIEW = process.argv[2] === "--preview";
const NOTIFICATION = PREVIEW
    ? "com.genesiscz.genesistools.widget-preview.widget.test"
    : "com.genesiscz.genesistools.widget.test";
const FACE = PREVIEW ? "MacOS/GenesisWidgetPreview --widget" : "MacOS/GenesisTools --widget";
/** One notification post; osascript answers in well under a second. */
const SEND_DEADLINE_MS = 10_000;
/** `tools control window` including a cold `tools` start. */
const WINDOWS_DEADLINE_MS = 60_000;
/** After the recording's last second: the recorder writes and closes the video. */
const RECORDING_FINISH_MS = 60_000;

/** A tool run that timed out or failed is an error naming the step, never an empty result. */
function checked(step: string, result: ExecResult, deadlineMs: number): ExecResult {
    if (result.timedOut) {
        throw new Error(`${step} did not finish within ${deadlineMs / 1000} s; it was stopped`);
    }

    if (!result.success) {
        throw new Error(`${step} exited ${result.exitCode}: ${result.stderr}`);
    }

    return result;
}

function send(command: string, name = NOTIFICATION): void {
    const script = `ObjC.import("Foundation");
$.NSDistributedNotificationCenter.defaultCenter.postNotificationNameObjectUserInfoDeliverImmediately(
    ${SafeJSON.stringify(name)}, undefined, $({ command: ${SafeJSON.stringify(command)} }), true);`;
    const result = Bun.spawnSync(["osascript", "-l", "JavaScript", "-e", script], {
        stderr: "pipe",
        timeout: SEND_DEADLINE_MS,
    });
    if (result.signalCode) {
        throw new Error(`osascript did not post within ${SEND_DEADLINE_MS / 1000} s; it was stopped`);
    }

    if (result.exitCode !== 0) {
        throw new Error(`osascript failed: ${result.stderr.toString().trim()}`);
    }
}

export function readWidgetPid(): number | undefined {
    return findProcesses({ command: FACE })
        .map((entry) => entry.pid)
        .sort((a, b) => a - b)[0];
}

function widgetPid(): number {
    const pid = readWidgetPid();
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

/**
 * The face's windows that the window server can address. While the screen is locked `tools control window` still lists
 * the windows but with no id or frame ("the window reported no position or size"); those are dropped, and a locked
 * screen is named, so `record` fails with a reason instead of passing `--window-ids undefined`.
 */
async function windows(): Promise<WindowInfo[]> {
    const pid = widgetPid();
    const result = await execTool(["control", "window", "--app", String(pid), "--json"], {
        timeout: WINDOWS_DEADLINE_MS,
    });
    const parsed = SafeJSON.parse(checked("tools control window", result, WINDOWS_DEADLINE_MS).stdout) as {
        windows?: Partial<WindowInfo>[];
        screenLocked?: boolean;
    };
    const usable = (parsed.windows ?? []).filter(
        (window): window is WindowInfo => typeof window.window_id === "number" && typeof window.width === "number"
    );
    if (usable.length === 0 && parsed.screenLocked) {
        throw new Error("the screen is locked: the window server reports no widget windows until it is unlocked");
    }

    return usable;
}

/** The recorder starts `tools`, checks its native build and sets up ScreenCaptureKit before the first frame. */
const FIRST_FRAME_DEADLINE_MS = 120_000;

/**
 * Resolves when the recorder has its first frame on disk: a new folder under `captureSessionsRoot()` holding
 * `keep-0001.png`, the same signal the capture runner waits for before it starts a plan's own timeline. A step timed
 * from the spawn instead can land before the capture starts and be missing from the recording.
 */
async function firstFrame({
    ended,
    stop,
    before,
}: {
    /** The recorder's result once it has exited; its pipes are read from the start by the tool runner. */
    ended: () => ExecResult | undefined;
    /** Stops the recorder's whole process group and resolves with its result. */
    stop: () => Promise<ExecResult>;
    before: Set<string>;
}): Promise<void> {
    const root = captureSessionsRoot();
    const deadline = Date.now() + FIRST_FRAME_DEADLINE_MS;
    while (Date.now() < deadline) {
        const names = existsSync(root) ? readdirSync(root) : [];
        if (names.some((name) => !before.has(name) && existsSync(join(root, name, "keep-0001.png")))) {
            return;
        }

        const result = ended();
        if (result) {
            throw new Error(`the recorder exited (code ${result.exitCode}) before its first frame: ${result.stderr}`);
        }

        await Bun.sleep(100);
    }

    await stop();
    throw new Error(`the recorder wrote no frame within ${FIRST_FRAME_DEADLINE_MS / 1000} s; it was stopped`);
}

async function record(args: string[]): Promise<void> {
    let seconds = 6;
    let out = "";
    const steps: { at: number; command: string }[] = [];

    for (let index = 0; index < args.length; index++) {
        const arg = args[index];
        if (arg === "--seconds") {
            seconds = Number(args[++index]);
            if (!Number.isFinite(seconds) || seconds <= 0) {
                throw new Error(`--seconds takes a positive number; got ${args[index]}`);
            }
        } else if (arg === "--out") {
            out = resolve(args[++index]);
        } else {
            // "<seconds>:<command>". A step without the colon would be sent at 0 s as one long command, and
            // the recording would look like the face ignored it.
            const colon = arg.indexOf(":");
            const at = Number(arg.slice(0, colon));
            const command = arg.slice(colon + 1).trim();
            if (colon <= 0 || !Number.isFinite(at) || at < 0 || !command) {
                throw new Error(`a record step is "<seconds>:<command>", e.g. "1.5:expand right 0"; got ${arg}`);
            }

            steps.push({ at, command });
        }
    }

    if (!out) {
        throw new Error("record needs --out <dir>");
    }

    // A step after the recording's end would be sent unrecorded, possibly long after the run looked finished.
    const late = steps.find((step) => step.at > seconds);
    if (late) {
        throw new Error(`step "${late.at}:${late.command}" is after the recording ends (--seconds ${seconds})`);
    }

    mkdirSync(out, { recursive: true });
    const ids = (await windows()).map((window) => window.window_id);
    if (ids.length === 0) {
        throw new Error("the widget face shows no windows (is the widget turned on?)");
    }

    const sessionsRoot = captureSessionsRoot();
    const before = new Set(existsSync(sessionsRoot) ? readdirSync(sessionsRoot) : []);
    const deadlineMs = FIRST_FRAME_DEADLINE_MS + seconds * 1000 + RECORDING_FINISH_MS;
    const cancel = new AbortController();
    let ended: ExecResult | undefined;
    // The tool runner reads both pipes from the start (the steps below can outlast a pipe buffer) and stops the
    // recorder's process group at the deadline or on `cancel`.
    const recording = execTool(
        [
            "control",
            "capture",
            "record",
            "--window-ids",
            ids.join(","),
            "--duration",
            String(seconds),
            "--active-fps",
            "30",
            "--video-out",
            `${out}/recording.mp4`,
        ],
        { cwd: out, timeout: deadlineMs, signal: cancel.signal }
    ).then((result) => {
        ended = result;
        return result;
    });
    await firstFrame({
        ended: () => ended,
        stop: () => {
            cancel.abort();
            return recording;
        },
        before,
    });
    const started = performance.now();

    for (const step of steps.sort((a, b) => a.at - b.at)) {
        const wait = step.at * 1000 - (performance.now() - started);
        if (wait > 0) {
            await Bun.sleep(wait);
        }

        if (ended) {
            throw new Error(
                `the recorder exited (code ${ended.exitCode}) before step "${step.at}:${step.command}": ${ended.stderr}`
            );
        }

        send(step.command);
        console.log(`${((performance.now() - started) / 1000).toFixed(2)}s  ${step.command}`);
    }

    const result = await recording;
    console.log(result.stdout);
    checked("the recorder", result, deadlineMs);
}

if (import.meta.main) {
    const [verb, ...rest] = process.argv.slice(PREVIEW ? 3 : 2);

    if (verb === "send" && rest[0]) {
        send(rest.join(" "));
    } else if (verb === "windows") {
        for (const window of await windows()) {
            console.log(
                `${window.window_id}  ${window.title}  ${window.x},${window.y} ${window.width}x${window.height}`
            );
        }
    } else if (verb === "record") {
        await record(rest);
    } else {
        console.error(
            'usage: bun scripts/native/widget-drive.ts send "<command>" | windows | record --seconds N --out <dir> "<t>:<command>"…'
        );
        process.exit(2);
    }
}
