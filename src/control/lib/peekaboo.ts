/**
 * Process-level helpers for the capture runner: peekaboo/osascript/ax-tool
 * spawning, screen + window geometry lookups, focus management, and the
 * recording-start detection with transport self-heal.
 */

import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { tmpdir } from "@genesiscz/utils/paths";
import type { Coords, CropTarget, RelativeTo } from "./capture-plan";

export const CHROMIUM_APPS = new Set([
    "Brave Browser",
    "Google Chrome",
    "Chromium",
    "Microsoft Edge",
    "Arc",
    "Vivaldi",
    "Opera",
]);

// Every spawned command gets a hard timeout: a wedged bridge makes peekaboo
// block for 20s+, and ONE blocking lookup inside the action loop shoves every
// later action off the timeline (observed live: atMs 2000 fired at 20369ms).
export function runCmd(cmd: string[], timeoutMs = 15_000): { ok: boolean; stdout: string; stderr: string } {
    const r = Bun.spawnSync(cmd, { timeout: timeoutMs, killSignal: "SIGKILL" });
    return {
        ok: r.exitCode === 0,
        stdout: r.stdout.toString().trim().slice(0, 500),
        stderr: (r.stderr.toString().trim() || (r.exitCode !== 0 ? `timed out/killed after ${timeoutMs}ms` : "")).slice(
            0,
            500
        ),
    };
}

// peekaboo occasionally prefixes stdout with visualizer/info noise lines —
// parse from the first "{" so --json output survives it.
export function runPeekabooJson(
    args: string[],
    timeoutMs = 15_000
): { ok: boolean; data?: unknown; stdout: string; stderr: string } {
    const r = Bun.spawnSync(["peekaboo", ...args, "--json"], { timeout: timeoutMs, killSignal: "SIGKILL" });
    const raw = r.stdout.toString();
    const start = raw.indexOf("{");
    let data: unknown;

    if (start >= 0) {
        try {
            const parsed: unknown = SafeJSON.parse(raw.slice(start));
            // keep results small: peekaboo envelopes carry debug_logs/metadata
            // noise — the useful payload is .data
            data =
                parsed !== null && typeof parsed === "object" && "data" in parsed
                    ? (parsed as { data: unknown }).data
                    : parsed;
        } catch {
            data = undefined;
        }
    }

    return {
        ok: r.exitCode === 0,
        data,
        stdout: raw.trim().slice(0, 500),
        stderr: r.stderr.toString().trim().slice(0, 500),
    };
}

export interface ScreenInfo {
    index: number;
    name: string;
    isPrimary: boolean;
    points: { width: number; height: number };
    scaleFactor: number;
    framePixels: { width: number; height: number };
    // top-left origin of this screen in GLOBAL CG points — the space click
    // coords and window bounds live in (peekaboo `list screens` positions are
    // Cocoa-flipped; converted here so agents never have to)
    originCG: { x: number; y: number };
}

// list lookups run inside the action timeline — keep them FAST: 4s via the
// bridge, then one --no-remote retry (local AX/CG; works when the bridge is
// wedged, may lack grants in exotic setups — the caller surfaces a warning).
export function runPeekabooListJson(args: string[]): { ok: boolean; data?: unknown; stdout: string; stderr: string } {
    const r = runPeekabooJson(args, 4_000);
    if (r.ok && r.data !== undefined) {
        return r;
    }

    return runPeekabooJson([...args, "--no-remote"], 6_000);
}

export function listScreens(): ScreenInfo[] {
    const r = runPeekabooListJson(["list", "screens"]);
    // runPeekabooJson already unwrapped the envelope's .data
    const screens =
        (
            r.data as {
                screens?: {
                    index: number;
                    name: string;
                    isPrimary: boolean;
                    scaleFactor: number;
                    position: { x: number; y: number };
                    resolution: { width: number; height: number };
                }[];
            }
        )?.screens ?? [];
    const primary = screens.find((s) => s.isPrimary) ?? screens[0];
    const primaryH = primary?.resolution.height ?? 0;

    return screens.map((s) => ({
        index: s.index,
        name: s.name,
        isPrimary: s.isPrimary,
        points: { width: s.resolution.width, height: s.resolution.height },
        scaleFactor: s.scaleFactor,
        framePixels: { width: s.resolution.width * s.scaleFactor, height: s.resolution.height * s.scaleFactor },
        originCG: { x: s.position.x, y: primaryH - (s.position.y + s.resolution.height) },
    }));
}

export interface WindowBounds {
    title: string;
    index: number;
    isMainWindow: boolean;
    // CG points: [[x, y], [w, h]]
    x: number;
    y: number;
    w: number;
    h: number;
}

export function listWindowBounds(app: string): WindowBounds[] {
    const r = runPeekabooListJson(["list", "windows", "--app", app, "--include-details", "bounds"]);
    const wins =
        (
            r.data as {
                windows?: {
                    title: string;
                    index: number;
                    isMainWindow: boolean;
                    isMinimized: boolean;
                    bounds?: [[number, number], [number, number]];
                }[];
            }
        )?.windows ?? [];

    return wins
        .filter((w) => !w.isMinimized && w.bounds)
        .map((w) => ({
            title: w.title,
            index: w.index,
            isMainWindow: w.isMainWindow,
            x: w.bounds![0][0],
            y: w.bounds![0][1],
            w: w.bounds![1][0],
            h: w.bounds![1][1],
        }));
}

export function pickLargestWindow(wins: WindowBounds[]): WindowBounds | undefined {
    // Some apps report phantom AX windows with absurd bounds (observed live:
    // cmux "window" of 250157x350019 points) — largest-area must not pick those.
    const plausible = wins.filter((w) => w.w <= 20_000 && w.h <= 20_000);
    return (plausible.length > 0 ? plausible : wins).slice().sort((a, b) => b.w * b.h - a.w * a.h)[0];
}

// Freeze a target window's bounds NOW and convert to frame pixels of the
// captured screen. Returns an error (with a reason) when unresolvable.
export function resolveTargetRegion(
    target: CropTarget,
    screen: ScreenInfo
): { region: { x: number; y: number; w: number; h: number } } | { error: string } {
    const wins = listWindowBounds(target.app);
    if (wins.length === 0) {
        return { error: `no windows for app "${target.app}"` };
    }

    // Only windows intersecting the CAPTURED screen can appear in the recording
    // — local AX lookups also list windows on other displays/Spaces (observed:
    // a stale window on another Space kept winning largest-area). Rank inside
    // the screen first; isMainWindow stays untrusted (menu-strip phantoms).
    const sx = screen.originCG.x;
    const sy = screen.originCG.y;
    const onScreen = wins.filter(
        (w) => w.x < sx + screen.points.width && w.x + w.w > sx && w.y < sy + screen.points.height && w.y + w.h > sy
    );
    const pool = onScreen.length > 0 ? onScreen : wins;

    const match = target.windowTitle
        ? pool.find((w) => w.title.toLowerCase().includes(target.windowTitle!.toLowerCase()))
        : pickLargestWindow(pool);
    if (!match) {
        return {
            error: `no window of "${target.app}" matches title "${target.windowTitle}" on captured screen ${screen.index}`,
        };
    }

    const sf = screen.scaleFactor;
    const region = {
        x: Math.round((match.x - screen.originCG.x) * sf),
        y: Math.round((match.y - screen.originCG.y) * sf),
        w: Math.round(match.w * sf),
        h: Math.round(match.h * sf),
    };

    if (
        region.x + region.w <= 0 ||
        region.y + region.h <= 0 ||
        region.x >= screen.framePixels.width ||
        region.y >= screen.framePixels.height
    ) {
        return { error: `window "${match.title || target.app}" lies outside captured screen ${screen.index}` };
    }

    // clamp to the frame so the crop never reaches outside it
    const x = Math.max(0, region.x);
    const y = Math.max(0, region.y);
    return {
        region: {
            x,
            y,
            w: Math.min(region.w - (x - region.x), screen.framePixels.width - x),
            h: Math.min(region.h - (y - region.y), screen.framePixels.height - y),
        },
    };
}

// Resolve window-relative coords to global CG coords at fire time.
// coords are offsets from the window's top-left in CG points; this looks up
// the window's current position and adds the offset. Returns the global coords
// string "x,y" or an error.
export function resolveRelativeCoords(coords: Coords, rel: RelativeTo): { global: string } | { error: string } {
    const wins = listWindowBounds(rel.app);
    if (wins.length === 0) {
        return { error: `relativeTo: no windows for "${rel.app}"` };
    }

    const match = rel.windowTitle
        ? wins.find((w) => w.title.toLowerCase().includes(rel.windowTitle!.toLowerCase()))
        : pickLargestWindow(wins.filter((w) => w.h > 50));
    if (!match) {
        return { error: `relativeTo: no window of "${rel.app}" matches title "${rel.windowTitle}"` };
    }

    const c =
        typeof coords === "string"
            ? (() => {
                  const [x, y] = coords.split(",").map(Number);
                  return { x, y };
              })()
            : coords;

    return { global: `${match.x + c.x},${match.y + c.y}` };
}

// ax-tool binary: compiled Swift CLI (~30-75x faster than osascript).
// Source of truth is native/ax-tool/ in this repo (`bun run build:native`).
// Falls back to osascript if not built.
export const AX_TOOL_PATH = join(
    import.meta.dir,
    "..",
    "..",
    "..",
    "native",
    "ax-tool",
    ".build",
    "release",
    "ax-tool"
);
export const AX_TOOL_AVAILABLE = existsSync(AX_TOOL_PATH);

export function runAxAction(
    app: string,
    axId: string | undefined,
    mode: "set" | "press" | "perform",
    value?: string,
    axAction?: string,
    q?: string
): { ok: boolean; stdout: string; stderr: string } {
    if (AX_TOOL_AVAILABLE) {
        return runAxActionFast(app, axId, mode, value, axAction, q);
    }
    if (mode === "perform" || q) {
        return {
            ok: false,
            stdout: "",
            stderr: "ax-perform and --q targeting require ax-tool binary (not built); only ax-set/ax-press with axId have osascript fallback",
        };
    }
    if (!axId) {
        return { ok: false, stdout: "", stderr: "axId required for osascript fallback" };
    }
    return runAxActionOsascript(app, axId, mode, value);
}

// Fast path: compiled Swift CLI calling C AX API directly (~50-200ms)
function runAxActionFast(
    app: string,
    axId: string | undefined,
    mode: "set" | "press" | "perform",
    value?: string,
    axAction?: string,
    q?: string
): { ok: boolean; stdout: string; stderr: string } {
    const args = [AX_TOOL_PATH, mode, "--app", app];
    if (q) {
        args.push("--q", q);
    } else if (axId) {
        args.push("--id", axId);
    }
    if (mode === "set" && value !== undefined) {
        args.push("--value", value);
    }
    if (mode === "perform" && axAction !== undefined) {
        args.push("--action", axAction);
    }
    const r = runCmd(args, 6_000);
    // ax-tool outputs JSON; parse to check ok field
    try {
        const parsed = SafeJSON.parse(r.stdout);
        if (parsed.ok === false) {
            return { ok: false, stdout: r.stdout, stderr: parsed.error || r.stderr };
        }
        return { ok: true, stdout: r.stdout, stderr: "" };
    } catch {
        return r;
    }
}

// Slow fallback: osascript + System Events (~2-5s)
function runAxActionOsascript(
    app: string,
    axId: string,
    mode: "set" | "press",
    value?: string
): { ok: boolean; stdout: string; stderr: string } {
    const escapedId = axId.replace(/"/g, '\\"');
    const escapedApp = app.replace(/"/g, '\\"');

    let script: string;
    if (mode === "set") {
        const escapedVal = (value ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
        script = `
tell application "System Events"
    tell process "${escapedApp}"
        set allElements to entire contents of window 1
        repeat with e in allElements
            try
                if value of attribute "AXIdentifier" of e is "${escapedId}" then
                    set value of e to "${escapedVal}"
                    return "ok"
                end if
            end try
        end repeat
        return "not found: ${escapedId}"
    end tell
end tell`;
    } else {
        script = `
tell application "System Events"
    tell process "${escapedApp}"
        set allElements to entire contents of window 1
        repeat with e in allElements
            try
                if value of attribute "AXIdentifier" of e is "${escapedId}" then
                    perform action "AXPress" of e
                    return "ok"
                end if
            end try
        end repeat
        return "not found: ${escapedId}"
    end tell
end tell`;
    }

    const r = runCmd(["osascript", "-e", script], 10_000);
    if (r.ok && r.stdout.includes("not found")) {
        return { ok: false, stdout: r.stdout, stderr: `AX element "${axId}" not found in ${app}` };
    }

    return r;
}

// Media keys are not in peekaboo's key vocabulary — rewrite the common ones to
// osascript so "hotkey volumeup" does what the author meant instead of erroring.
export const MEDIA_KEY_SCRIPTS: Record<string, string> = {
    volumeup: "set volume output volume (((output volume of (get volume settings)) + 10))",
    volumedown: "set volume output volume (((output volume of (get volume settings)) - 10))",
    mute: "set volume with output muted",
    unmute: "set volume without output muted",
};

// "Recording in N…" countdown for user-driven captures. stderr always; plus a
// best-effort floating overlay near the mouse via JXA NSPanel. JXA landmines
// (from live debugging, do not "simplify"): CALayer.setBackgroundColor hangs
// the runtime — use NSPanel.setBackgroundColor; orderFrontRegardless/close are
// silent no-ops without the () call parens.
function countdownOverlayScript(sec: number): string {
    return `ObjC.import('Cocoa'); ObjC.import('CoreGraphics');
function run() {
  var app = $.NSApplication.sharedApplication;
  app.setActivationPolicy($.NSApplicationActivationPolicyAccessory);
  var loc = $.CGEventGetLocation($.CGEventCreate(null));
  var screenHeight = $.NSScreen.mainScreen.frame.size.height;
  var winW = 300, winH = 70;
  var rect = $.NSMakeRect(loc.x - winW / 2, (screenHeight - loc.y) - winH - 40, winW, winH);
  var panel = $.NSPanel.alloc.initWithContentRectStyleMaskBackingDefer(
    rect, $.NSWindowStyleMaskBorderless, $.NSBackingStoreBuffered, false);
  panel.setLevel($.NSFloatingWindowLevel + 1);
  panel.setOpaque(false);
  panel.setBackgroundColor($.NSColor.blackColor.colorWithAlphaComponent(0.8));
  panel.setIgnoresMouseEvents(true);
  var label = $.NSTextField.alloc.initWithFrame($.NSMakeRect(0, 0, winW, winH));
  label.setEditable(false); label.setBordered(false); label.setDrawsBackground(false);
  label.setAlignment($.NSTextAlignmentCenter);
  label.setTextColor($.NSColor.whiteColor);
  label.setFont($.NSFont.boldSystemFontOfSize(20));
  panel.setContentView(label);
  panel.orderFrontRegardless();
  for (var i = ${sec}; i >= 1; i--) {
    label.setStringValue('Recording in ' + i + '\\u2026 don\\u0027t move the mouse');
    $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(1.0));
  }
  panel.close();
}`;
}

export async function runCountdown(sec: number): Promise<void> {
    // overlay runs detached and paces itself; stderr ticks are the guaranteed channel
    const overlay = Bun.spawn(["osascript", "-l", "JavaScript", "-e", countdownOverlayScript(sec)], {
        stdout: "ignore",
        stderr: "ignore",
    });
    overlay.unref();

    for (let i = sec; i >= 1; i--) {
        console.error(`capture-with-actions: recording in ${i}… don't move mouse/keyboard`);
        await Bun.sleep(1000);
    }
}

export function focusWindow(
    target: { app: string; windowTitle?: string },
    timeoutMs = 15_000
): { ok: boolean; via: "ax-tool" | "peekaboo" | "osascript" | "none"; detail: string } {
    // Native ax-tool first: activates + raises without the peekaboo bridge
    // (peekaboo 3.9.4 'window focus' HANGS — observed killed at 30s+).
    if (AX_TOOL_AVAILABLE) {
        const axCmd = target.windowTitle
            ? [AX_TOOL_PATH, "window", "--app", target.app, "--action", "focus", "--window", target.windowTitle]
            : [AX_TOOL_PATH, "focus", "--app", target.app];
        const ax = runCmd(axCmd, 8_000);
        if (ax.ok) {
            return { ok: true, via: "ax-tool", detail: "" };
        }
    }

    const cmd = ["peekaboo", "window", "focus", "--app", target.app];
    if (target.windowTitle) {
        cmd.push("--window-title", target.windowTitle);
    }
    const r = runCmd(cmd, Math.min(timeoutMs, 5_000));
    if (r.ok) {
        return { ok: true, via: "peekaboo", detail: "" };
    }

    // window focus routes through the bridge too — osascript activate is the
    // bridge-free fallback (app-level only; windowTitle ignored)
    const f = runCmd(["osascript", "-e", `tell application "${target.app}" to activate`], timeoutMs);
    return f.ok
        ? { ok: true, via: "osascript", detail: "" }
        : { ok: false, via: "none", detail: f.stderr || f.stdout || r.stderr || r.stdout };
}

export function navigateBrowser(app: string, url: string, target: "new-tab" | "active-tab") {
    if (target === "active-tab") {
        if (app === "Safari") {
            return runCmd(["osascript", "-e", `tell application "Safari" to set URL of front document to "${url}"`]);
        }

        if (CHROMIUM_APPS.has(app)) {
            return runCmd([
                "osascript",
                "-e",
                `tell application "${app}" to set URL of active tab of front window to "${url}"`,
            ]);
        }
        // No AppleScript dialect (Firefox & friends) — new tab is the only option.
    }

    return runCmd(["open", "-a", app, url]);
}

// peekaboo is a polter shim: killing the spawned pid alone orphans the REAL
// capture process, which keeps recording and then wedges the retry as a
// "concurrent capture" (observed live: auto-retry failed 4/5 while a direct
// bypass run succeeded 2/2 — the corpse of attempt 1 was the difference).
export function killTree(pid: number): void {
    const kids = Bun.spawnSync(["pgrep", "-P", String(pid)], { timeout: 2_000 })
        .stdout.toString()
        .trim()
        .split("\n")
        .filter(Boolean);
    for (const k of kids) {
        killTree(Number(k));
    }

    try {
        process.kill(pid, "SIGKILL");
    } catch (e) {
        // ESRCH: already exited — exactly what we want
        void e;
    }
}

export function captureSessionsRoot(): string {
    return join(tmpdir({ preferRoot: false }), "peekaboo", "capture-sessions");
}

export interface CaptureAttempt {
    proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
    sessionDir: string | null;
    stdoutText: Promise<string>;
    stderrText: Promise<string>;
    failDiag: string;
}

// Recording-start detection: peekaboo writes keep-0001.png into a fresh
// capture-<UUID> dir the moment the first frame is grabbed.
export async function startCapture(captureArgs: string[]): Promise<CaptureAttempt> {
    const sessionsRoot = captureSessionsRoot();
    mkdirSync(sessionsRoot, { recursive: true });
    const preexisting = new Set(readdirSync(sessionsRoot));
    const p = Bun.spawn(["peekaboo", ...captureArgs], { stdout: "pipe", stderr: "pipe" });
    // Drain both pipes from spawn time: an undrained 64KB pipe blocks peekaboo
    // mid-write (large final JSON on long captures, or visualizer logs when
    // PEEKABOO_VISUALIZER_STDOUT=true) and is indistinguishable from a hang.
    const stdoutText = new Response(p.stdout).text();
    const stderrText = new Response(p.stderr).text();

    let dir: string | null = null;
    let exitedEarly = false;
    const armDeadline = Date.now() + 15_000;
    while (Date.now() < armDeadline) {
        const fresh = readdirSync(sessionsRoot).filter(
            (d) => !preexisting.has(d) && existsSync(join(sessionsRoot, d, "keep-0001.png"))
        );

        if (fresh.length > 0) {
            dir = join(sessionsRoot, fresh[0]);
            break;
        }

        if (p.exitCode !== null) {
            exitedEarly = true;
            break;
        }

        await Bun.sleep(50);
    }

    let failDiag = "";
    if (!dir) {
        killTree(p.pid);
        // peekaboo --json puts the REAL error in the STDOUT envelope
        // (error.code/message); stderr usually carries only visualizer noise.
        // Reading only stderr here is how a fast, explicit peekaboo error once
        // masqueraded as "recording never started ... stderr: [Visualizer][INFO] ...".
        const [so, se] = await Promise.all([stdoutText, stderrText]);
        let envelope = "";
        const jsonStart = so.indexOf("{");
        if (jsonStart >= 0) {
            try {
                const parsed = SafeJSON.parse(so.slice(jsonStart)) as { error?: { code?: string; message?: string } };
                if (parsed.error) {
                    envelope = `${parsed.error.code ?? "?"}: ${parsed.error.message ?? "?"}`;
                }
            } catch {
                // not JSON — the raw stdout tail below covers it
            }
        }

        failDiag = [
            exitedEarly
                ? `peekaboo exited (code ${p.exitCode}) before writing a frame`
                : "peekaboo still running with no frame after 15s — killed its process tree",
            envelope ? `error ${envelope}` : `stdout: ${so.trim().slice(0, 300) || "empty"}`,
            `stderr: ${se.trim().slice(0, 300) || "empty"}`,
        ].join(" · ");
    }

    return { proc: p, sessionDir: dir, stdoutText, stderrText, failDiag };
}

export function stripBypassFlags(a: string[]): string[] {
    const kept: string[] = [];
    for (let i = 0; i < a.length; i++) {
        if (a[i] === "--no-remote") {
            continue;
        }

        if (a[i] === "--capture-engine") {
            i++;
            continue;
        }

        kept.push(a[i]);
    }

    return kept;
}
