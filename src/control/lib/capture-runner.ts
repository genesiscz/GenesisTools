/**
 * Capture orchestration: owns the whole recording timeline in one process —
 * starts the selected native or legacy recorder, detects the actual recording start (first
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
import { NativeCaptureControls, nativeScreens, nativeTargetRegion, validateNativeCapturePlan } from "./capture-native";
import {
    type Action,
    type CropOut,
    coordsToString,
    extractCropSpecs,
    type FiredAction,
    type FrameInfo,
    invalidBackend,
    type Plan,
    validatePlan,
} from "./capture-plan";
import { applyCrops } from "./crop-compositing";
import { nativeCaptureArgv } from "./native-record";
import {
    AX_TOOL_PATH,
    axToolAvailable,
    captureSessionsRoot,
    clickArgv,
    focusWindow,
    killTree,
    listScreens,
    listWindowBounds,
    MEDIA_KEY_SCRIPTS,
    moveArgv,
    navigateBrowser,
    pickLargestWindow,
    pressArgv,
    resolveRelativeCoords,
    resolveTargetRegion,
    runAxAction,
    runCmd,
    runCountdown,
    runPeekabooJson,
    type ScreenInfo,
    scrollArgv,
    startCapture,
    stripBypassFlags,
    typeArgv,
    type WindowBounds,
    windowShotArgv,
} from "./peekaboo";
import { ensureBinary } from "./runner";
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

/**
 * A plan's `capture.duration` is SECONDS, but peekaboo reads a BARE `--duration` as
 * MILLISECONDS ("Duration; bare values are milliseconds" in `capture live --help`), so
 * forwarding it raw asked for a 2 ms recording when the plan said 2 s. The suffix states
 * the unit at the boundary instead of depending on either side's default.
 */
export function peekabooDurationArg(seconds: number): string {
    return `${seconds}s`;
}

/**
 * Recorder diagnostics name the binary that actually ran, including explicitly selected legacy transports.
 */
export function captureToolCommand(tool: string): { command: string; standalone: string } {
    if (tool === "peekaboo") {
        return {
            command: "peekaboo 'capture live'",
            standalone: `peekaboo capture live --mode screen --duration ${peekabooDurationArg(2)} --json`,
        };
    }

    return {
        command: `${tool} capture`,
        standalone: `${tool} capture --mode screen --duration 2 --out /tmp/capture-probe`,
    };
}

type CaptureAttempt = Awaited<ReturnType<typeof startCapture>>;
type CaptureSpec = NonNullable<Plan["capture"]>;

/**
 * Start Peekaboo 4's recorder. Self-heals by flipping transport: bridge runs stall when the
 * bridge socket wedges or a fallback host lacks Screen Recording; bypass runs (--no-remote,
 * in-process CG) fail when THIS process's own TCC ancestry lacks the grant, exactly the case
 * where a bridge host still works. The retry always takes the path attempt 1 did not.
 */
async function startPeekabooCapture(cap: CaptureSpec, warnings: string[]): Promise<CaptureAttempt> {
    const args = ["capture", "live", "--mode", cap.mode, "--duration", peekabooDurationArg(cap.duration), "--json"];
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

    let attempt = await startCapture(["peekaboo", ...args]);
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
        attempt = await startCapture(["peekaboo", ...retryArgs]);

        if (!attempt.sessionDir) {
            throw new CaptureRunError(
                `recording never started on either transport.\n  attempt 1 (${bypassed ? "bypass" : "bridge"}): ${diag1}\n  retry (${bypassed ? "bridge" : "bypass"}): ${attempt.failDiag}`
            );
        }
    }

    return attempt;
}

export async function runCapturePlan(plan: Plan): Promise<RunResult> {
    normalizePlan(plan);
    const cap = plan.capture;
    if (!cap?.mode || !cap?.duration) {
        throw new CaptureRunError("plan.capture.mode and plan.capture.duration are required");
    }

    const badBackend = invalidBackend(plan);
    if (badBackend) {
        throw new CaptureRunError(badBackend);
    }

    const warnings = validatePlan(plan);
    for (const w of warnings) {
        console.error(`capture-with-actions: WARNING: ${w}`);
    }

    const hasTargetCrops = (plan.actions ?? []).some((a) => a.do === "crop" && a.target && !a.region);
    if (hasTargetCrops && cap.mode !== "screen") {
        warnings.push("crop target markers only work with capture.mode 'screen' — they will be dropped");
    }

    const backend = cap.backend ?? "native";
    let axTool = AX_TOOL_PATH;
    if (backend === "native") {
        validateNativeCapturePlan(plan);
        axTool = ensureBinary();
    }
    using nativeControls = backend === "native" ? new NativeCaptureControls(cap) : undefined;

    // CAPTURE_HELP still recommends noRemote/captureEngine, which are peekaboo transport flags.
    // nativeCaptureArgv drops both; report ignored legacy transport flags explicitly.
    if (backend === "native" && (cap.noRemote || cap.captureEngine)) {
        warnings.push(
            "capture.noRemote/captureEngine apply to the peekaboo backend only — the native recorder ignores them"
        );
    }

    if (backend === "native" && cap.mode === "window" && cap.windowIndex !== undefined && cap.windowId === undefined) {
        warnings.push(
            "capture.windowIndex is AX-ordered but the native recorder indexes its own CGWindowList — set capture.windowId (see's window.id) to name the window exactly"
        );
    }

    if (plan.focus) {
        const f = nativeControls ? await nativeControls.focus(plan.focus) : focusWindow(plan.focus);
        if (!f.ok) {
            if (nativeControls) {
                throw new CaptureRunError(`Native focus failed: ${f.detail}`);
            }
            warnings.push(`focus ${plan.focus.app} failed: ${f.detail}`);
        } else {
            if (f.via === "osascript") {
                warnings.push(
                    `focus ${plan.focus.app}: peekaboo window focus failed (bridge?), fell back to osascript activate (windowTitle ignored)`
                );
            }

            await Bun.sleep(300);
        }
    }

    if (cap.countdownSec && cap.countdownSec > 0) {
        await runCountdown(Math.min(cap.countdownSec, 10));
    }

    let attempt: CaptureAttempt;
    if (backend === "native") {
        const outDir = join(captureSessionsRoot(), `native-${Date.now()}`);
        attempt = await startCapture([axTool, ...nativeCaptureArgv(cap, outDir)]);

        if (!attempt.sessionDir) {
            throw new CaptureRunError(
                `Native recording never started: ${attempt.failDiag}. No fallback was attempted.`
            );
        }
    } else {
        attempt = await startPeekabooCapture(cap, warnings);
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
    let ambientFocusWindow = plan.focus?.windowTitle ?? cap.windowTitle;
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

        if (!nativeControls && ambientFocusApp && REFOCUS_ACTIONS.has(action.do)) {
            const f = runCmd(["osascript", "-e", `tell application "${ambientFocusApp}" to activate`], 3_000);
            if (!f.ok && !refocusWarned) {
                refocusWarned = true;
                warnings.push(
                    `pre-input refocus of ${ambientFocusApp} failed (${f.stderr || f.stdout}) — input may be eaten by macOS click-to-focus`
                );
            }
        }

        if (nativeControls && action.do !== "crop") {
            result = await nativeControls.run(
                action,
                ambientFocusApp ? { app: ambientFocusApp, windowTitle: ambientFocusWindow } : undefined
            );
            if (action.do === "focus" && result.ok) {
                ambientFocusApp = action.app;
                ambientFocusWindow = action.windowTitle;
            }
            if (action.do === "focus-stop") {
                ambientFocusApp = undefined;
                ambientFocusWindow = undefined;
            }
        } else {
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
                    result = runPeekabooJson(clickArgv(clickCoords));
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

                    result = runPeekabooJson(pressArgv(action.keys, action.holdMs));
                    if (!result.ok) {
                        result.stderr = `${result.stderr} (valid keys: cmd/shift/alt/ctrl/fn, a-z, 0-9, space/return/tab/escape/delete/arrows, f1-f12; media keys only via volumeup/volumedown/mute/unmute rewrite)`;
                    }

                    break;
                }
                case "type":
                    result = runPeekabooJson(typeArgv(action.text, action.delayMs ?? 0));
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
                            runCmd(["peekaboo", ...moveArgv(`${cx},${cy}`)]);
                        }
                    }

                    result = runPeekabooJson(
                        scrollArgv({
                            direction: action.direction,
                            amount: action.amount,
                            app: action.app,
                            windowTitle: action.windowTitle,
                        })
                    );
                    break;
                }
                case "crop": {
                    // target marker: freeze the window's bounds NOW, write region back
                    // so extractCropSpecs picks it up after capture
                    screensCache ??= nativeControls ? nativeScreens() : listScreens();
                    const screen = screensCache.find((s) => s.index === (cap.screenIndex ?? 0));
                    if (!screen || cap.mode !== "screen") {
                        result = {
                            ok: false,
                            stdout: "",
                            stderr: `crop target needs screen-mode capture with a known screenIndex`,
                        };
                        break;
                    }

                    const resolved = nativeControls
                        ? nativeTargetRegion(action.target!, screen)
                        : resolveTargetRegion(action.target!, screen);
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
    // That observation predates peekabooDurationArg, so the request was really
    // 2 ms; the hang may well have been the unit bug. Keep the guard anyway —
    // a wedged CG stack costs every later capture, and it is cheap insurance.
    // The losing timer must be cleared: a pending 33 s sleep keeps the process alive long
    // after the result is printed, which read as a 38 s runner for a 3 s capture.
    const exitGraceMs = 30_000;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    const exitedInTime = await Promise.race([
        proc.exited.then(() => true),
        new Promise<boolean>((resolve) => {
            graceTimer = setTimeout(() => resolve(false), cap.duration * 1000 + exitGraceMs);
        }),
    ]);
    clearTimeout(graceTimer);

    if (!exitedInTime) {
        warnings.push(
            `${attempt.tool} did not exit within ${cap.duration}s+${exitGraceMs / 1000}s — killed its process tree; frames salvaged from the session dir (timestamps from file mtimes)`
        );
        killTree(proc.pid);
    }

    const stdoutText = await attempt.stdoutText;
    const stderrText = await attempt.stderrText;

    let captureResult: unknown;
    const jsonStart = stdoutText.indexOf("{");
    try {
        if (jsonStart < 0) {
            throw new Error(`no JSON object in ${attempt.tool} stdout`);
        }

        captureResult = SafeJSON.parse(stdoutText.slice(jsonStart));
    } catch {
        const exitCode = exitedInTime ? await proc.exited : null;
        const { command, standalone } = captureToolCommand(attempt.tool);
        const diagnosis =
            stdoutText.length === 0
                ? `${command} produced NO output${exitCode != null ? ` (exit ${exitCode}${exitCode === 133 ? " = SIGTRAP crash" : ""})` : ""} — the ${attempt.tool} binary itself is failing on this system. Verify standalone: ${standalone}. Element control, screenshots, and OCR do not use this path and keep working.`
                : `${attempt.tool} stdout was not valid JSON`;
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
    const shotCmd = windowShotArgv({
        axToolPath: axToolAvailable() ? AX_TOOL_PATH : undefined,
        app: opts.app,
        path: rawPath,
        windowTitle: opts.windowTitle,
    });
    const shot = runCmd(shotCmd, 20_000);
    if (!shot.ok || !existsSync(rawPath)) {
        throw new CaptureRunError(`window screenshot failed (${shotCmd[0]}): ${shot.stderr || shot.stdout}`);
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
