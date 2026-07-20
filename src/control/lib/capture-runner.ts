/**
 * Capture orchestration: owns the whole recording timeline in one process —
 * starts `peekaboo capture live`, detects the actual recording start (first
 * frame on disk), fires each action at its exact offset, then composites
 * crops/strip and optionally publishes to vitrinka.
 *
 * Solves the agent-latency problem: an LLM driving capture + UI actions through
 * separate tool calls is seconds late (model thinking + MCP round-trips), so
 * the recording misses the transition.
 */

import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { renderAnnotationPlan } from "@genesiscz/utils/image";
import { SafeJSON } from "@genesiscz/utils/json";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import {
    type Action,
    type CropOut,
    coordsToString,
    extractCropSpecs,
    type FiredAction,
    type FrameInfo,
    type Plan,
    validatePlan,
} from "./capture-plan";
import { applyCrops } from "./crop-compositing";
import {
    AX_TOOL_AVAILABLE,
    AX_TOOL_PATH,
    CHROMIUM_APPS,
    focusWindow,
    killTree,
    listScreens,
    listWindowBounds,
    MEDIA_KEY_SCRIPTS,
    navigateBrowser,
    pickLargestWindow,
    resolveRelativeCoords,
    resolveTargetRegion,
    runAxAction,
    runCmd,
    runCountdown,
    runPeekabooJson,
    type ScreenInfo,
    startCapture,
    stripBypassFlags,
    type WindowBounds,
} from "./peekaboo";
import { publishVitrinka } from "./vitrinka-publish";

/** Operational failure of a capture-family command; exitCode preserves the legacy script's codes. */
export class CaptureRunError extends Error {
    exitCode: number;

    constructor(message: string, exitCode = 2) {
        super(message);
        this.exitCode = exitCode;
    }
}

export interface RunResult {
    ok: boolean;
    sessionDir: string;
    exitCode: number | null;
    warnings: string[];
    actions: FiredAction[];
    crops: CropOut[];
    strip: string | null;
    stripReview: string | null;
    /** plan.annotate outputs — one annotated copy per kept frame. */
    annotated?: string[];
    vitrinka?: { ok: boolean; urls: string[]; error?: string };
    capture: unknown;
    captureFailed: boolean;
}

const REFOCUS_ACTIONS = new Set(["click", "type", "hotkey", "ax-set", "ax-press", "ax-perform"]);

const MOTION_ACTIONS = new Set([
    "click",
    "url",
    "osascript",
    "hotkey",
    "type",
    "scroll",
    "ax-set",
    "ax-press",
    "ax-perform",
]);

/** Accept `steps` as an alias for `actions` (unified plan schema grace). */
export function normalizePlan(plan: Plan): Plan {
    if (!plan.actions && (plan as unknown as { steps?: Action[] }).steps) {
        plan.actions = (plan as unknown as { steps?: Action[] }).steps ?? [];
    }
    plan.actions ??= [];
    return plan;
}

export async function runCapturePlan(plan: Plan): Promise<RunResult> {
    normalizePlan(plan);
    const cap = plan.capture;
    if (!cap?.mode || !cap?.duration) {
        throw new CaptureRunError("plan.capture.mode and plan.capture.duration are required");
    }

    const warnings = validatePlan(plan);
    for (const w of warnings) {
        console.error(`capture-with-actions: WARNING: ${w}`);
    }

    const hasTargetCrops = (plan.actions ?? []).some((a) => a.do === "crop" && a.target && !a.region);
    if (hasTargetCrops && cap.mode !== "screen") {
        warnings.push("crop target markers only work with capture.mode 'screen' — they will be dropped");
    }

    if (plan.focus) {
        const f = focusWindow(plan.focus);
        if (!f.ok) {
            warnings.push(`focus ${plan.focus.app} failed (peekaboo AND osascript): ${f.detail}`);
        } else {
            if (f.via === "osascript") {
                warnings.push(
                    `focus ${plan.focus.app}: peekaboo window focus failed (bridge?), fell back to osascript activate (windowTitle ignored)`
                );
            }

            await Bun.sleep(300);
        }
    }

    const args = ["capture", "live", "--mode", cap.mode, "--duration", String(cap.duration), "--json"];
    if (cap.screenIndex !== undefined) {
        args.push("--screen-index", String(cap.screenIndex));
    }
    if (cap.app) {
        args.push("--app", cap.app);
    }
    if (cap.windowTitle) {
        args.push("--window-title", cap.windowTitle);
    }
    if (cap.windowIndex !== undefined) {
        args.push("--window-index", String(cap.windowIndex));
    }
    if (cap.region) {
        args.push("--region", cap.region);
    }
    if (cap.activeFps !== undefined) {
        args.push("--active-fps", String(cap.activeFps));
    }
    if (cap.idleFps !== undefined) {
        args.push("--idle-fps", String(cap.idleFps));
    }
    if (cap.threshold !== undefined) {
        args.push("--threshold", String(cap.threshold));
    }
    if (cap.videoOut) {
        args.push("--video-out", cap.videoOut);
    }
    if (cap.noRemote) {
        args.push("--no-remote");
    }
    if (cap.captureEngine) {
        args.push("--capture-engine", cap.captureEngine);
    }

    if (cap.countdownSec && cap.countdownSec > 0) {
        await runCountdown(Math.min(cap.countdownSec, 10));
    }

    let attempt = await startCapture(args);

    // Self-heal by flipping transport — the two paths fail for DIFFERENT reasons.
    // Bridge runs stall when the bridge socket wedges or a fallback host lacks
    // Screen Recording; bypass runs (--no-remote, in-process CG) fail when THIS
    // process's own TCC ancestry lacks the grant — exactly the case where a bridge
    // host (GUI app with its own grant) still works. So the retry always takes the
    // path attempt 1 did NOT take.
    if (!attempt.sessionDir) {
        const bypassed = Boolean(cap.noRemote);
        const diag1 = attempt.failDiag;
        const retryArgs = bypassed
            ? stripBypassFlags(args)
            : [...args, "--no-remote", ...(cap.captureEngine ? [] : ["--capture-engine", "cg"])];
        warnings.push(
            `recording never started via ${bypassed ? "bypass (--no-remote)" : "bridge"} — ${diag1} — retrying once via ${bypassed ? "bridge" : "--no-remote --capture-engine cg"}`
        );
        await Bun.sleep(2_000);
        attempt = await startCapture(retryArgs);

        if (!attempt.sessionDir) {
            throw new CaptureRunError(
                `recording never started on either transport.\n  attempt 1 (${bypassed ? "bypass" : "bridge"}): ${diag1}\n  retry (${bypassed ? "bridge" : "bypass"}): ${attempt.failDiag}`
            );
        }
    }

    const proc = attempt.proc;
    // non-null: the retry block above throws when no attempt produced a dir
    const sessionDir = attempt.sessionDir!;

    const t0 = Date.now();
    const fired: FiredAction[] = [];
    let aborted = false;

    // Crop markers with a target STAY in the timeline: their bounds lookup runs at
    // their atMs (freeze-at-marker-time semantics). Region markers and crop-stop
    // fire nothing and are excluded.
    let screensCache: ScreenInfo[] | null = null;

    // Focus decays MID-recording (the runner's own shell-outs, OS focus drift, the
    // user touching another window), and macOS silently eats synthetic input on
    // non-frontmost windows — so focus is re-asserted before EVERY input action
    // (click/type/hotkey), not just at recording start. Deliberately osascript
    // activate, NOT peekaboo window focus: app-level focus is all a mid-recording
    // refocus needs and it's ~120ms vs a measured ~2s bridge roundtrip. The
    // ambient target starts as plan.focus (else capture.app for window-mode
    // captures) and is steerable mid-timeline by "focus"/"focus-stop" markers.
    let ambientFocusApp = plan.focus?.app ?? (cap.mode === "window" ? cap.app : undefined);
    let refocusWarned = false;

    const sortedActions = [...plan.actions]
        .filter((a) => (a.do === "crop" ? a.target !== undefined && a.region === undefined : a.do !== "crop-stop"))
        .sort((a, b) => a.atMs - b.atMs);
    for (const action of sortedActions) {
        if (aborted) {
            fired.push({ action, plannedMs: action.atMs, actualMs: -1, ok: false, skipped: true });
            continue;
        }

        const wait = action.atMs - (Date.now() - t0);
        if (wait > 0) {
            await Bun.sleep(wait);
        }

        const actualMs = Date.now() - t0;
        let result: { ok: boolean; stdout: string; stderr: string; data?: unknown };

        if (ambientFocusApp && REFOCUS_ACTIONS.has(action.do)) {
            const f = runCmd(["osascript", "-e", `tell application "${ambientFocusApp}" to activate`], 3_000);
            if (!f.ok && !refocusWarned) {
                refocusWarned = true;
                warnings.push(
                    `pre-input refocus of ${ambientFocusApp} failed (${f.stderr || f.stdout}) — input may be eaten by macOS click-to-focus`
                );
            }
        }

        switch (action.do) {
            case "url":
                result = navigateBrowser(
                    action.app ?? plan.browser ?? "Brave Browser",
                    action.url,
                    action.target ?? "new-tab"
                );
                break;
            case "osascript":
                result = runCmd(["osascript", "-e", action.script]);
                break;
            case "click": {
                let clickCoords = coordsToString(action.coords);
                if (action.relativeTo) {
                    const resolved = resolveRelativeCoords(action.coords, action.relativeTo);
                    if ("error" in resolved) {
                        result = { ok: false, stdout: "", stderr: resolved.error };
                        break;
                    }
                    clickCoords = resolved.global;
                }
                result = runPeekabooJson(["click", "--coords", clickCoords]);
                break;
            }
            case "focus": {
                // full assertion (window-level, bridge with osascript fallback)
                // once at the marker; cheap per-input re-asserts take over after
                const f = focusWindow({ app: action.app, windowTitle: action.windowTitle }, 3_000);
                ambientFocusApp = action.app;
                result = {
                    ok: f.ok,
                    stdout: f.ok ? `focused via ${f.via}; ambient refocus target -> ${action.app}` : "",
                    stderr: f.detail,
                };
                break;
            }
            case "focus-stop":
                ambientFocusApp = undefined;
                result = { ok: true, stdout: "ambient refocus disabled", stderr: "" };
                break;
            case "hotkey": {
                const media = MEDIA_KEY_SCRIPTS[action.keys.toLowerCase().trim()];
                if (media) {
                    result = runCmd(["osascript", "-e", media]);
                    break;
                }

                const cmd = ["hotkey", "--keys", action.keys];
                if (action.holdMs !== undefined) {
                    cmd.push("--hold-duration", String(action.holdMs));
                }

                result = runPeekabooJson(cmd);
                if (!result.ok) {
                    result.stderr = `${result.stderr} (valid keys: cmd/shift/alt/ctrl/fn, a-z, 0-9, space/return/tab/escape/delete/arrows, f1-f12; media keys only via volumeup/volumedown/mute/unmute rewrite)`;
                }

                break;
            }
            case "type":
                result = runPeekabooJson([
                    "type",
                    action.text,
                    "--profile",
                    "linear",
                    "--delay",
                    String(action.delayMs ?? 0),
                ]);
                break;
            case "ax-set": {
                result = runAxAction(action.app, action.axId, "set", action.value, undefined, action.q);
                break;
            }
            case "ax-press": {
                result = runAxAction(action.app, action.axId, "press", undefined, undefined, action.q);
                break;
            }
            case "ax-perform": {
                result = runAxAction(action.app, action.axId, "perform", undefined, action.action, action.q);
                break;
            }
            case "scroll": {
                if (action.coords) {
                    let scrollCoords = coordsToString(action.coords);
                    if (action.relativeTo) {
                        const resolved = resolveRelativeCoords(action.coords, action.relativeTo);
                        if ("error" in resolved) {
                            result = { ok: false, stdout: "", stderr: resolved.error };
                            break;
                        }
                        scrollCoords = resolved.global;
                    }
                    const [cx, cy] = scrollCoords.split(",").map(Number);
                    if (cx < 0 || cy < 0) {
                        warnings.push(
                            `scroll at ${action.atMs}ms: peekaboo move rejects negative coords (${cx},${cy}) — scrolling at current cursor position`
                        );
                    } else {
                        runCmd(["peekaboo", "move", "--coords", `${cx},${cy}`]);
                    }
                }

                const cmd = ["scroll", "--direction", action.direction, "--amount", String(action.amount ?? 3)];
                if (action.app) {
                    cmd.push("--app", action.app);
                }

                if (action.windowTitle) {
                    cmd.push("--window-title", action.windowTitle);
                }

                result = runPeekabooJson(cmd);
                break;
            }
            case "crop": {
                // target marker: freeze the window's bounds NOW, write region back
                // so extractCropSpecs picks it up after capture
                screensCache ??= listScreens();
                const screen = screensCache.find((s) => s.index === (cap.screenIndex ?? 0));
                if (!screen || cap.mode !== "screen") {
                    result = {
                        ok: false,
                        stdout: "",
                        stderr: `crop target needs screen-mode capture with a known screenIndex`,
                    };
                    break;
                }

                const resolved = resolveTargetRegion(action.target!, screen);
                if ("error" in resolved) {
                    result = { ok: false, stdout: "", stderr: resolved.error };
                    warnings.push(`crop target at ${action.atMs}ms dropped: ${resolved.error}`);
                } else {
                    action.region = resolved.region;
                    result = { ok: true, stdout: `region ${SafeJSON.stringify(resolved.region)}`, stderr: "" };
                }

                break;
            }
            default:
                result = { ok: false, stdout: "", stderr: "unknown action type" };
        }

        fired.push({
            action,
            plannedMs: action.atMs,
            actualMs,
            ok: result.ok,
            stdout: result.stdout || undefined,
            data: result.data,
            error: result.ok ? undefined : result.stderr || result.stdout || "failed",
        });

        if (!result.ok && (action.onError ?? "continue") === "abort") {
            aborted = true;
        }
    }

    // Bounded exit wait: peekaboo occasionally hangs after (or instead of)
    // finishing — observed live with a duration-2 capture still alive minutes
    // later, wedging the whole CG capture stack for every later run
    // (CGDisplayCreateImage returned nil). Never leave a zombie behind.
    const exitGraceMs = 30_000;
    const exitedInTime = await Promise.race([
        proc.exited.then(() => true),
        Bun.sleep(cap.duration * 1000 + exitGraceMs).then(() => false),
    ]);

    if (!exitedInTime) {
        warnings.push(
            `peekaboo did not exit within ${cap.duration}s+${exitGraceMs / 1000}s — killed its process tree; frames salvaged from the session dir (timestamps from file mtimes)`
        );
        killTree(proc.pid);
    }

    const stdoutText = await attempt.stdoutText;
    const stderrText = await attempt.stderrText;

    let captureResult: unknown;
    const jsonStart = stdoutText.indexOf("{");
    try {
        if (jsonStart < 0) {
            throw new Error("no JSON object in peekaboo stdout");
        }

        captureResult = SafeJSON.parse(stdoutText.slice(jsonStart));
    } catch {
        const exitCode = exitedInTime ? await proc.exited : null;
        const diagnosis =
            stdoutText.length === 0
                ? `peekaboo 'capture live' produced NO output${exitCode != null ? ` (exit ${exitCode}${exitCode === 133 ? " = SIGTRAP crash" : ""})` : ""} — the peekaboo binary itself is failing on this system. Verify standalone: peekaboo capture live --mode screen --duration 2 --json. Element control, screenshots, and OCR do not use this path and keep working.`
                : "peekaboo stdout was not valid JSON";
        captureResult = {
            failed: true,
            parseError: true,
            exitCode,
            error: diagnosis,
            raw: stdoutText.slice(0, 2000),
            stderr: stderrText.slice(0, 1000),
        };
        warnings.push(`capture failed: ${diagnosis}`);
    }

    let frames: FrameInfo[] = ((captureResult as { data?: { frames?: FrameInfo[] } })?.data?.frames ?? [])
        .slice()
        .sort((a, b) => a.timestampMs - b.timestampMs);

    if (frames.length === 0) {
        // killed or crashed peekaboo → no result JSON; the kept PNGs are still on
        // disk. Rebuild FrameInfo from mtimes (relative to the first frame).
        const keeps = readdirSync(sessionDir)
            .filter((f) => /^keep-\d+\.png$/.test(f))
            .sort();
        if (keeps.length > 0) {
            const t0mtime = statSync(join(sessionDir, keeps[0])).mtimeMs;
            frames = keeps.map((f) => ({
                file: f,
                path: join(sessionDir, f),
                timestampMs: Math.round(statSync(join(sessionDir, f)).mtimeMs - t0mtime),
            }));
        }
    }

    let crops: CropOut[] = [];
    let strip: string | null = null;
    let stripReview: string | null = null;
    const cropSpecs = extractCropSpecs(plan.actions);
    if (cropSpecs.length > 0 && frames.length > 0) {
        ({ crops, strip, stripReview } = await applyCrops(sessionDir, frames, cropSpecs));
    }

    let annotated: string[] | undefined;
    if (plan.annotate?.annotations?.length && frames.length > 0) {
        annotated = [];
        const annotatedDir = join(sessionDir, "annotated");
        mkdirSync(annotatedDir, { recursive: true });
        for (const f of frames) {
            try {
                const r = await renderAnnotationPlan({
                    input: f.path,
                    annotations: plan.annotate.annotations,
                    preset: plan.annotate.preset,
                });
                const outPath = join(annotatedDir, f.file);
                await Bun.write(outPath, r.png);
                annotated.push(outPath);
            } catch (e) {
                warnings.push(`annotate ${f.file}: ${e instanceof Error ? e.message : String(e)}`);
            }
        }
    }

    // "actions succeeded" != "pixels moved": scroll over dead UI, wrong screen, or
    // wrong focus all leave peekaboo with a 1-frame noMotion result.
    const motionFired = fired.some((f) => f.ok && MOTION_ACTIONS.has(f.action.do));
    if (motionFired && frames.length <= 1) {
        warnings.push(
            `actions fired ok but capture kept ${frames.length} frame(s) — no visual motion reached the recorded screen (wrong screenIndex? wrong focus? scroll over non-scrolling UI?)`
        );
    }

    let vitrinka: { ok: boolean; urls: string[]; error?: string } | undefined;
    if (plan.vitrinka) {
        if (motionFired && frames.length <= 1 && !plan.vitrinka.force) {
            vitrinka = {
                ok: false,
                urls: [],
                error: "refusing to publish a 1-frame no-motion capture (this is what litters boards with dead sets); fix the plan or set vitrinka.force",
            };
        } else {
            vitrinka = publishVitrinka(plan.vitrinka, sessionDir, frames, crops, strip);
        }
    }

    const captureFailed = (captureResult as { failed?: boolean })?.failed === true;
    const actionsFailed = fired.some((f) => !f.ok && !f.skipped);

    return {
        ok: !captureFailed && !actionsFailed,
        sessionDir,
        exitCode: proc.exitCode,
        warnings,
        actions: fired,
        crops,
        strip,
        stripReview,
        annotated,
        vitrinka,
        capture: captureResult,
        captureFailed,
    };
}

export interface RecropResult {
    sessionDir: string;
    mode: "recrop";
    warnings: string[];
    crops: CropOut[];
    strip: string | null;
    stripReview: string | null;
    vitrinka?: { ok: boolean; urls: string[]; error?: string };
}

export async function runRecrop(resultPath: string, planPath: string): Promise<RecropResult> {
    const prior = SafeJSON.parse(await Bun.file(resultPath).text());
    if (!prior || typeof prior !== "object") {
        throw new CaptureRunError("invalid prior result: expected a JSON object");
    }

    const plan: Plan = SafeJSON.parse(await Bun.file(planPath).text());
    if (!plan || typeof plan !== "object") {
        throw new CaptureRunError("invalid plan: expected a JSON object");
    }

    normalizePlan(plan);
    const frames: FrameInfo[] = (prior?.capture?.data?.frames ?? [])
        .slice()
        .sort((a: FrameInfo, b: FrameInfo) => a.timestampMs - b.timestampMs);
    if (frames.length === 0) {
        throw new CaptureRunError("prior result has no frames");
    }

    const missing = frames.filter((f) => !existsSync(f.path));
    if (missing.length > 0) {
        throw new CaptureRunError(`frames deleted (peekaboo autoclean?): ${missing[0].path}`);
    }

    const warnings = validatePlan(plan);
    for (const a of plan.actions ?? []) {
        if (a.do === "crop" && a.target && !a.region) {
            warnings.push(
                `crop target at ${a.atMs}ms cannot be resolved in recrop mode (bounds would be from NOW, not recording time) — dropped`
            );
        }
    }

    const { crops, strip, stripReview } = await applyCrops(
        prior.sessionDir,
        frames,
        extractCropSpecs(plan.actions ?? [])
    );
    const vitrinka = plan.vitrinka ? publishVitrinka(plan.vitrinka, prior.sessionDir, frames, crops, strip) : undefined;
    return { sessionDir: prior.sessionDir, mode: "recrop", warnings, crops, strip, stripReview, vitrinka };
}

export function buildPreflightReport(appArg?: string): Record<string, unknown> {
    const screens = listScreens();

    const frontRes = runCmd([
        "osascript",
        "-e",
        'tell application "System Events" to get name of first application process whose frontmost is true',
    ]);
    const app = appArg ?? frontRes.stdout;
    const windows = app ? listWindowBounds(app) : [];
    // Flag phantom strip windows (menu bar, titlebar): full-width x <=50px
    const phantomStrips = windows.filter((w) => w.h <= 50);
    let realWindows = windows.filter((w) => w.h > 50);

    // Cross-check against the AX window list: peekaboo's CGWindowList view
    // includes other-Space/stale windows the AX API doesn't show — picking one
    // of those as the crop basis targets the wrong window (blind-test 6).
    if (app && AX_TOOL_AVAILABLE) {
        const axr = runCmd([AX_TOOL_PATH, "window", "--app", app]);
        if (axr.ok) {
            try {
                const parsed = SafeJSON.parse(axr.stdout) as {
                    windows?: Array<{ title?: string; x?: number; y?: number; width?: number; height?: number }>;
                };
                const axWins = parsed.windows ?? [];
                const axMatch = (w: { title: string; x: number; y: number; w: number; h: number }): boolean =>
                    axWins.some(
                        (a) =>
                            (Math.abs((a.x ?? 0) - w.x) < 6 &&
                                Math.abs((a.y ?? 0) - w.y) < 6 &&
                                Math.abs((a.width ?? 0) - w.w) < 6 &&
                                Math.abs((a.height ?? 0) - w.h) < 6) ||
                            (!!a.title && a.title === w.title)
                    );
                realWindows = realWindows.map((w) => ({ ...w, axVisible: axMatch(w) }));
                const visible = realWindows.filter((w) => (w as { axVisible?: boolean }).axVisible);
                if (visible.length > 0) {
                    realWindows = [...visible, ...realWindows.filter((w) => !(w as { axVisible?: boolean }).axVisible)];
                }
            } catch {
                // ax cross-check unavailable — fall through to CG-only view
            }
        }
    }

    // largest AX-VISIBLE window preferred; CG-only windows only when AX saw none
    const axVisibleWindows = realWindows.filter((w) => (w as { axVisible?: boolean }).axVisible !== false);
    const main = pickLargestWindow(
        axVisibleWindows.length > 0 ? axVisibleWindows : realWindows.length > 0 ? realWindows : windows
    );

    let activeScreen: ScreenInfo | undefined;
    if (main) {
        const cx = main.x + main.w / 2;
        const cy = main.y + main.h / 2;
        activeScreen = screens.find(
            (s) =>
                cx >= s.originCG.x &&
                cx < s.originCG.x + s.points.width &&
                cy >= s.originCG.y &&
                cy < s.originCG.y + s.points.height
        );
    }

    activeScreen ??= screens.find((s) => s.isPrimary) ?? screens[0];

    let browserTab: { url?: string; title?: string } | undefined;
    if (app && (CHROMIUM_APPS.has(app) || app === "Safari")) {
        const urlScript =
            app === "Safari"
                ? `tell application "Safari" to get URL of front document`
                : `tell application "${app}" to get URL of active tab of front window`;
        const titleScript =
            app === "Safari"
                ? `tell application "Safari" to get name of front document`
                : `tell application "${app}" to get title of active tab of front window`;
        const u = runCmd(["osascript", "-e", urlScript]);
        const t = runCmd(["osascript", "-e", titleScript]);
        browserTab = { url: u.ok ? u.stdout : undefined, title: t.ok ? t.stdout : undefined };
    }

    const sf = activeScreen.scaleFactor;
    const mainFramePx = main && {
        x: Math.round((main.x - activeScreen.originCG.x) * sf),
        y: Math.round((main.y - activeScreen.originCG.y) * sf),
        w: Math.round(main.w * sf),
        h: Math.round(main.h * sf),
    };

    return {
        screens,
        frontmost: {
            app,
            // largest-first so the picked window is always visible in the list
            windows: realWindows
                .slice()
                .sort((a, b) => b.w * b.h - a.w * a.h)
                .slice(0, 8),
            phantomStrips:
                phantomStrips.length > 0
                    ? phantomStrips.map((w) => ({
                          title: w.title,
                          index: w.index,
                          isMainWindow: w.isMainWindow,
                          w: w.w,
                          h: w.h,
                      }))
                    : undefined,
            pickedWindow: main ?? null,
            pickedBy:
                "largest AX-visible window (CGWindowList shows other-Space/stale windows the AX API doesn't; isMainWindow lies; <=50px windows filtered as phantom strips)",
            mainWindowPoints: main ? { x: main.x, y: main.y, w: main.w, h: main.h } : null,
            mainWindowFramePx: mainFramePx ?? null,
            activeScreenIndex: activeScreen.index,
            browserTab,
        },
        unitsReminder: {
            clickCoords: "GLOBAL CG points (mainWindowPoints space; negatives legal)",
            cropRegion: `FRAME pixels of the captured screen (points x scaleFactor=${sf}; mainWindowFramePx space)`,
        },
        suggestedPlan: {
            capture: {
                mode: "screen",
                screenIndex: activeScreen.index,
                duration: 6,
                activeFps: 15,
                threshold: 0.1,
                videoOut: "/tmp/run.mp4",
                noRemote: true,
                captureEngine: "cg",
            },
            actions: [
                mainFramePx
                    ? { atMs: 0, do: "crop", region: mainFramePx, label: "window" }
                    : {
                          atMs: 0,
                          do: "crop",
                          region: { x: 0, y: 0, w: activeScreen.framePixels.width, h: 300 },
                          label: "top-band",
                      },
            ],
        },
    };
}

export interface ClickmapOptions {
    app: string;
    windowTitle?: string;
    gridStep: number;
    outPath: string;
}

export interface ClickmapResult {
    out: string;
    raw: string;
    app: string;
    window: { x: number; y: number; w: number; h: number; title: string };
    gridStep: number;
    units: string;
    tip: string;
    windowOrigin: { x: number; y: number };
}

// Browser pages expose no AX tree to peekaboo (`see` draws zero boxes on
// web content), so clicking inside a page means reading coordinates off a
// screenshot — and hand-computing global points from window origin +
// retina scale is exactly where manual attempts burn 2-3 iterations per
// target. clickmap bakes the arithmetic into the image: the grid labels
// ARE global click points; no math left to get wrong.
//
// Thin wrapper over the draw engine (decision 13): capture window → run a
// draw plan with one `grid` annotation whose originOffset is the window's
// global origin, so gridlines land on absolute point multiples.
export async function runClickmap(opts: ClickmapOptions): Promise<ClickmapResult> {
    const wins = listWindowBounds(opts.app);
    const match: WindowBounds | undefined = opts.windowTitle
        ? wins.find((w) => w.title.toLowerCase().includes(opts.windowTitle!.toLowerCase()))
        : pickLargestWindow(wins);
    if (!match) {
        throw new CaptureRunError(
            `no window found for app "${opts.app}"${opts.windowTitle ? ` matching title "${opts.windowTitle}"` : ""}`
        );
    }

    const rawPath = `${opts.outPath.replace(/\.png$/, "")}-raw.png`;
    const shotCmd = ["peekaboo", "image", "--app", opts.app, "--path", rawPath];
    if (opts.windowTitle) {
        shotCmd.push("--window-title", opts.windowTitle);
    }

    const shot = runCmd(shotCmd, 20_000);
    if (!shot.ok || !existsSync(rawPath)) {
        throw new CaptureRunError(`peekaboo image failed: ${shot.stderr || shot.stdout}`);
    }

    // Normalize the shot to point dimensions (retina shots are points x scale),
    // so 1 image px == 1 point and gridlines land exactly on labeled coords.
    const w = Math.round(match.w);
    const h = Math.round(match.h);
    const raw = await loadImage(rawPath);
    const scaled = createCanvas(w, h);
    const sctx = scaled.getContext("2d");
    sctx.imageSmoothingEnabled = true;
    sctx.imageSmoothingQuality = "high";
    sctx.drawImage(raw, 0, 0, w, h);

    const rendered = await renderAnnotationPlan({
        input: scaled.toBuffer("image/png"),
        annotations: [
            { kind: "grid", step: opts.gridStep, originOffset: { x: Math.round(match.x), y: Math.round(match.y) } },
        ],
    });
    await Bun.write(opts.outPath, rendered.png);

    return {
        out: opts.outPath,
        raw: rawPath,
        app: opts.app,
        window: { x: match.x, y: match.y, w: match.w, h: match.h, title: match.title },
        gridStep: opts.gridStep,
        units: "grid labels are GLOBAL screen points (CG POINTS, not pixels) — use directly as click coords {x,y}",
        tip: "Read `out`, interpolate between gridlines for the target, then verify the first click's effect before trusting a whole plan. For relativeTo coords: subtract the window origin (shown below) from the grid label values.",
        windowOrigin: { x: match.x, y: match.y },
    };
}
