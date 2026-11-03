import { describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { outputScaleFor, parseDisplayList } from "./displays";
import { type LiveCommandLine, LiveRecordingWriter, listLiveRecordings, sendLiveCommand } from "./live";
import { captureErrorKind, flagsInHelp, nativeArgv } from "./native";
import { peekabooCaptureError } from "./peekaboo";
import { CaptureError, type CaptureRequest } from "./types";

const axScreens = {
    ok: true,
    screens: [
        {
            displayID: 1,
            index: 0,
            isPrimary: true,
            name: "Built-in",
            position: { x: 0, y: 0 },
            resolution: { width: 2056, height: 1329 },
            scaleFactor: 2,
        },
        {
            displayID: 4,
            index: 1,
            isPrimary: false,
            name: "External",
            position: { x: -410, y: 1329 },
            resolution: { width: 2560, height: 1440 },
            scaleFactor: 1,
        },
    ],
};

const request = (over: Partial<CaptureRequest> = {}): CaptureRequest => ({
    target: { kind: "display", displayId: 4 },
    durationSec: 30,
    activeFps: 1,
    idleFps: 0.1,
    thresholdPercent: 2,
    outDir: "/tmp/piece",
    ...over,
});

describe("displays", () => {
    test("ax-tool's list and peekaboo's envelope give the same displays by id", () => {
        const native = parseDisplayList(axScreens);
        const peekaboo = parseDisplayList({ success: true, data: { screens: axScreens.screens } });

        expect(native).toEqual(peekaboo);
        expect(native.map((display) => [display.id, display.index, display.main])).toEqual([
            [1, 0, true],
            [4, 1, false],
        ]);
    });

    test("the output scale keeps the long side within the cap and never above the display's own", () => {
        const [builtIn, external] = parseDisplayList(axScreens);

        expect(outputScaleFor(builtIn!, 2880)).toBeCloseTo(2880 / 2056);
        expect(outputScaleFor(external!, 2880)).toBe(1);
    });
});

describe("native capture argv", () => {
    const displays = parseDisplayList(axScreens);

    test("without the new flags, a display id becomes its current index and the cap an output scale", () => {
        const argv = nativeArgv({ request: request({ maxLongSidePx: 1280 }), flags: new Set(), displays });

        expect(argv.slice(argv.indexOf("--screen-index"), argv.indexOf("--screen-index") + 2)).toEqual([
            "--screen-index",
            "1",
        ]);
        expect(argv).toContain("--output-scale");
        expect(argv[argv.indexOf("--output-scale") + 1]).toBe(String(Number((1280 / 2560).toFixed(4))));
        expect(argv).not.toContain("--display-id");
        expect(argv).toContain("--no-indicator");
    });

    test("with them, the id and the cap go through as they are", () => {
        const flags = flagsInHelp("  --display-id <id>\n  --max-long-side <px>\n  --heartbeat-sec <s>");
        const argv = nativeArgv({ request: request({ maxLongSidePx: 1280, heartbeatSec: 60 }), flags, displays });

        expect(argv).toEqual(expect.arrayContaining(["--display-id", "4", "--max-long-side", "1280"]));
        expect(argv).toEqual(expect.arrayContaining(["--heartbeat-sec", "60"]));
        expect(argv).not.toContain("--screen-index");
        expect(argv).not.toContain("--output-scale");
    });

    test("a display that is gone is display-missing; follow-focus needs the flag", () => {
        const gone = () =>
            nativeArgv({ request: request({ target: { kind: "display", displayId: 9 } }), flags: new Set(), displays });
        const focus = () =>
            nativeArgv({ request: request({ target: { kind: "follow-focus" } }), flags: new Set(), displays });

        expect(gone).toThrow(CaptureError);
        expect(captureKindOf(gone)).toBe("display-missing");
        expect(captureKindOf(focus)).toBe("unavailable");
    });

    test("the help text names a flag only as a whole word", () => {
        expect([...flagsInHelp("--max-mb-total <n>  --quiet-ms <ms>")]).toEqual(["--quiet-ms"]);
    });

    test("error codes win over the message; old messages still map", () => {
        expect(captureErrorKind("display-missing", "x")).toBe("display-missing");
        expect(captureErrorKind(undefined, "--screen-index outside the current display list")).toBe("display-missing");
        expect(captureErrorKind(undefined, "ScreenCaptureKit refused to enumerate content: denied")).toBe(
            "no-permission"
        );
        expect(captureErrorKind("invalid-argument", "display missing")).toBe("failed");
    });
});

function captureKindOf(run: () => unknown): string | undefined {
    try {
        run();
    } catch (error) {
        return error instanceof CaptureError ? error.kind : "other";
    }

    return undefined;
}

describe("a failed peekaboo capture", () => {
    const stderr = "[Visualizer][INFO] Visualizer client forcing mac-app context via PEEKABOO_VISUALIZER_FORCE_APP";

    test("names peekaboo's own error from its JSON, not its log line", () => {
        const stdout = SafeJSON.stringify({
            success: false,
            error: { code: "INVALID_INPUT", message: "Invalid input: Screen index 1 not found" },
            data: null,
        });
        const err = peekabooCaptureError(1, stdout, stderr);

        expect(err.message).toBe("peekaboo exited 1: Invalid input: Screen index 1 not found");
        expect(err.kind).toBe("display-missing");
    });

    test("another error is no missing display, and output without JSON keeps the log", () => {
        const denied = SafeJSON.stringify({ success: false, error: { message: "Screen Recording permission denied" } });

        expect(peekabooCaptureError(1, denied, stderr).kind).toBe("no-permission");
        expect(peekabooCaptureError(1, "", stderr).message).toBe(`peekaboo exited 1: ${stderr}`);
    });
});

describe("live recordings", () => {
    test("an entry is written, gets commands within a second, and its files go when it closes", async () => {
        const dir = mkdtempSync(join(tmpdir(), "live-rec-"));
        const received: LiveCommandLine[] = [];
        const writer = new LiveRecordingWriter({
            id: "meeting-m1",
            kind: "meeting",
            title: "Planning",
            displays: [{ id: 1, name: "Built-in" }],
            onCommand: (command) => received.push(command),
            dir,
        });

        expect(listLiveRecordings(dir).map((entry) => [entry.id, entry.state, entry.pid])).toEqual([
            ["meeting-m1", "recording", process.pid],
        ]);

        writer.update({ state: "paused", frames: 3, warning: "a note" });
        writer.update({ warning: undefined });
        const saved = SafeJSON.parse(readFileSync(join(dir, "meeting-m1.json"), "utf8"), { strict: true });

        expect(saved).toMatchObject({ version: 1, state: "paused", frames: 3, controls: ["pause", "resume", "stop"] });
        expect(saved).not.toHaveProperty("warning");

        sendLiveCommand({ id: "meeting-m1", command: "stop", from: "test", dir });
        // A half-written line waits for its newline.
        appendFileSync(join(dir, "meeting-m1.commands.jsonl"), '{"command":"pa');
        const deadline = Date.now() + 3_000;

        while (received.length === 0 && Date.now() < deadline) {
            await Bun.sleep(100);
        }

        expect(received.map((line) => [line.command, line.from])).toEqual([["stop", "test"]]);

        writer.close();

        expect(existsSync(join(dir, "meeting-m1.json"))).toBe(false);
        expect(existsSync(join(dir, "meeting-m1.commands.jsonl"))).toBe(false);
        expect(() => sendLiveCommand({ id: "meeting-m1", command: "stop", from: "test", dir })).toThrow(
            /No running recording/
        );
    });

    test("an entry whose process is gone is not listed", () => {
        const dir = mkdtempSync(join(tmpdir(), "live-rec-"));
        appendFileSync(
            join(dir, "gone.json"),
            SafeJSON.stringify({
                version: 1,
                id: "gone",
                kind: "meeting",
                title: "",
                pid: 999_999,
                startedAt: "2026-11-03T12:00:00.000Z",
                state: "recording",
            })
        );

        expect(listLiveRecordings(dir)).toEqual([]);
    });
});
