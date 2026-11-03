/**
 * A stand-in for `ax-tool` in tests: `--help` names the capture flags, `screens` lists two displays, and `capture
 * --control-stdin` keeps one frame, then takes switch, pause, resume and stop as JSON lines on stdin and answers with
 * events on stderr, as the real recorder does. The end of stdin or SIGINT stops it with the normal result on stdout.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { z } from "zod";

const commandSchema = z.object({ cmd: z.string(), displayId: z.number().optional() });

const args = process.argv.slice(2);
const print = (value: unknown, stream: "stdout" | "stderr" = "stdout") =>
    process[stream].write(`${SafeJSON.stringify(value)}\n`);

if (args[0] === "--help") {
    process.stdout.write("capture: [--display-id ID] [--follow-focus] [--max-long-side PX] [--control-stdin]\n");
    process.exit(0);
}

if (args[0] === "screens") {
    print({
        ok: true,
        screens: [
            {
                displayID: 1,
                index: 0,
                isPrimary: true,
                name: "Built-in",
                position: { x: 0, y: 0 },
                resolution: { width: 1512, height: 982 },
                scaleFactor: 2,
            },
            {
                displayID: 4,
                index: 1,
                isPrimary: false,
                name: "External",
                position: { x: 0, y: 982 },
                resolution: { width: 2560, height: 1440 },
                scaleFactor: 1,
            },
        ],
    });
    process.exit(0);
}

const value = (flag: string) => args[args.indexOf(flag) + 1];
const outDir = value("--out") ?? ".";
let displayId = Number(value("--display-id"));
const frames: Array<Record<string, unknown>> = [];
let finished = false;
mkdirSync(outDir, { recursive: true });

const keep = (reason: string) => {
    const file = `keep-${String(frames.length + 1).padStart(4, "0")}.png`;
    const path = join(outDir, file);
    writeFileSync(path, "png");
    const frame = {
        index: frames.length,
        file,
        path,
        timestampMs: frames.length * 100,
        changePercent: 5,
        reason,
        displayId,
    };
    frames.push(frame);
    print({ event: "frame", ...frame }, "stderr");
};

const finish = (cancelled: boolean) => {
    if (finished) {
        return;
    }

    finished = true;
    print({ ok: true, success: true, data: { frames, cancelled, stats: { keptFrames: frames.length } } });
    process.exit(0);
};

process.on("SIGINT", () => finish(true));
keep("first");
print({ event: "state", state: "recording", displayId }, "stderr");

let pending = "";
process.stdin.on("data", (chunk) => {
    pending += chunk.toString();
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";

    for (const line of lines.filter(Boolean)) {
        const command = commandSchema.parse(SafeJSON.parse(line, { strict: true }));

        if (command.cmd === "switch") {
            if (command.displayId !== 1 && command.displayId !== 4) {
                print(
                    {
                        event: "error",
                        code: "display-missing",
                        message: `display ${command.displayId} is not connected`,
                    },
                    "stderr"
                );
                continue;
            }

            print({ event: "display-switch", from: displayId, to: command.displayId }, "stderr");
            displayId = command.displayId;
            keep("display-switch");
        } else if (command.cmd === "pause" || command.cmd === "resume") {
            print({ event: "state", state: command.cmd === "pause" ? "paused" : "recording" }, "stderr");
        } else if (command.cmd === "stop") {
            finish(false);
        }
    }
});
process.stdin.on("end", () => finish(false));
