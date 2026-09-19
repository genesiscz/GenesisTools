import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { z } from "zod";
import type { Action, CaptureSpec, CropTarget, Plan } from "./capture-plan";
import { type ComputerElement, type ComputerState, ComputerUse } from "./computer-use/session";
import { parseNativeWindowList, parseScreenList, type ScreenInfo } from "./native-record";
import { type AxResult, runAx, runAxAsync } from "./runner";

function required(result: AxResult): AxResult {
    if (!result.ok) {
        throw new Error(result.error ?? "Native inspection failed.");
    }
    return result;
}
export function nativeScreens() {
    return parseScreenList(required(runAx(["screens"])), "cocoa");
}
export function nativeWindows(app: string) {
    return parseNativeWindowList(required(runAx(["window", "--app", app])));
}
export function validateNativeCapturePlan(plan: Plan): void {
    for (const action of plan.actions) {
        if (["url", "osascript"].includes(action.do)) {
            throw new Error(
                `${action.do} is unavailable in native capture. Use explicit native key/input actions, or explicitly choose the legacy peekaboo backend.`
            );
        }
        if (action.do === "hotkey" && /^(volumeup|volumedown|mute|unmute|brightness)/i.test(action.keys)) {
            throw new Error("Media-key scripting is unavailable in native capture.");
        }
        if (action.do === "type" && (action.text.length > 256 || /[\r\n]/.test(action.text))) {
            throw new Error(
                "Native capture type requires at most 256 single-line UTF-16 units; use ax-set for longer exact values."
            );
        }
        if (action.do === "type" && (action.delayMs ?? 0) !== 0) {
            throw new Error("Native capture does not support a custom per-character delay.");
        }
        if (action.do === "hotkey" && action.holdMs !== undefined && action.holdMs !== 50) {
            throw new Error("Native capture key chords use a fixed 50 ms hold.");
        }
    }
}
function match(
    element: ComputerElement,
    action: Extract<Action, { do: "ax-set" | "ax-press" | "ax-perform" }>
): boolean {
    return action.axId !== undefined
        ? element.identifier === action.axId
        : Boolean(action.q) &&
              [element.identifier, element.label, String(element.value ?? "")].some(
                  (value) => value?.toLocaleLowerCase() === action.q!.toLocaleLowerCase()
              );
}
function coordinates(value: string | { x: number; y: number }) {
    const point = typeof value === "string" ? value.split(",").map(Number) : [value.x, value.y];
    return z.tuple([z.number().finite(), z.number().finite()]).parse(point);
}
export class NativeCaptureControls {
    private readonly computer = new ComputerUse();
    constructor(private readonly capture: CaptureSpec) {}
    private async observe(options: { app: string; windowTitle?: string; action?: Action; image?: boolean }) {
        const { app, windowTitle, action } = options;
        if (this.capture.app === app && this.capture.windowId !== undefined) {
            return this.computer.get_app_state({
                app,
                window_id: this.capture.windowId,
                image: options.image ?? false,
                element_limit: 2000,
            });
        }
        const listed = required(await runAxAsync({ args: ["window", "--app", app], timeoutMs: 5000 }));
        const windows = z
            .array(z.object({ title: z.string().optional(), minimized: z.boolean().optional() }))
            .max(10)
            .parse(listed.windows);
        let indexes = windows.flatMap((window, index) =>
            !window.minimized && (windowTitle === undefined || window.title === windowTitle) ? [index] : []
        );
        if (this.capture.app === app && this.capture.windowIndex !== undefined) {
            indexes = indexes.filter((index) => index === this.capture.windowIndex);
        }
        if (indexes.length === 1) {
            return this.computer.get_app_state({
                app,
                window_index: indexes[0],
                image: options.image ?? false,
                element_limit: 2000,
            });
        }
        if (action && (action.do === "ax-set" || action.do === "ax-press" || action.do === "ax-perform")) {
            const matches: ComputerState[] = [];
            for (const windowIndex of indexes) {
                const state = await this.computer.get_app_state({
                    app,
                    window_index: windowIndex,
                    image: false,
                    element_limit: 2000,
                });
                const count = state.elements.filter((element) => match(element, action)).length;
                if (count > 1) {
                    throw new Error("Native capture target is ambiguous.");
                }
                if (count === 1) {
                    matches.push(state);
                }
            }
            if (matches.length === 1) {
                return this.computer.get_app_state({
                    app,
                    window_id: matches[0].window.id,
                    image: false,
                    element_limit: 2000,
                });
            }
        }
        throw new Error(
            "Native capture requires one exact window. Set capture.windowId/windowIndex or an unambiguous windowTitle/AX identifier."
        );
    }
    async focus(target: { app: string; windowTitle?: string }) {
        const state = await this.observe(target);
        const result = await this.computer.focus({ app: target.app, revision: state.revision });
        return { ok: result.ok, via: "ax-tool" as const, detail: result.error ?? "" };
    }
    async run(action: Action, ambient?: { app: string; windowTitle?: string }) {
        try {
            const relative = "relativeTo" in action ? action.relativeTo : undefined;
            const app = ("app" in action ? action.app : undefined) ?? relative?.app ?? ambient?.app ?? this.capture.app;
            if (action.do === "focus-stop") {
                return { ok: true, stdout: "Native ambient focus disabled", stderr: "" };
            }
            if (!app) {
                throw new Error(
                    "Native actions require an explicit app via action, relativeTo, plan.focus or capture.app."
                );
            }
            if (action.do === "focus") {
                const result = await this.focus(action);
                return { ok: result.ok, stdout: result.ok ? "Focused through native AX" : "", stderr: result.detail };
            }
            const windowTitle =
                ("windowTitle" in action ? action.windowTitle : undefined) ??
                relative?.windowTitle ??
                ambient?.windowTitle ??
                this.capture.windowTitle;
            let state = await this.observe({
                app,
                windowTitle,
                action,
                image: action.do === "click" || (action.do === "scroll" && Boolean(action.coords)),
            });
            if (ambient && (action.do === "type" || action.do === "hotkey")) {
                const focused = await this.computer.focus({ app, revision: state.revision });
                if (!focused.ok || !focused.state) {
                    throw new Error(focused.error ?? "Native focus could not be verified.");
                }
                state = focused.state;
            }
            let result: Awaited<ReturnType<ComputerUse["click"]>>;
            switch (action.do) {
                case "ax-set":
                case "ax-press":
                case "ax-perform": {
                    const matches = state.elements.filter((element) => match(element, action));
                    if (matches.length !== 1) {
                        throw new Error("Native AX target must match one current exact identifier or label.");
                    }
                    const target = { app, element_ref: matches[0].ref };
                    result =
                        action.do === "ax-set"
                            ? await this.computer.set_value({ ...target, value: action.value })
                            : action.do === "ax-press"
                              ? await this.computer.perform_secondary_action({ ...target, action: "AXPress" })
                              : await this.computer.perform_secondary_action({ ...target, action: action.action });
                    break;
                }
                case "click": {
                    let [x, y] = coordinates(action.coords);
                    if (relative) {
                        x += state.window.x;
                        y += state.window.y;
                    }
                    result = await this.computer.click({
                        app,
                        revision: state.revision,
                        x,
                        y,
                        coordinate_space: "screen",
                        background: true,
                    });
                    break;
                }
                case "type":
                    result = await this.computer.type_text({ app, revision: state.revision, text: action.text });
                    break;
                case "hotkey":
                    result = await this.computer.press_key({ app, revision: state.revision, key: action.keys });
                    break;
                case "scroll": {
                    const common = {
                        app,
                        revision: state.revision,
                        direction: action.direction,
                        pixels: action.amount ?? 3,
                    };
                    if (action.coords) {
                        let [x, y] = coordinates(action.coords);
                        if (relative) {
                            x += state.window.x;
                            y += state.window.y;
                        }
                        result = await this.computer.scroll({ ...common, x, y, coordinate_space: "screen" });
                    } else {
                        const areas = state.elements.filter((element) => element.role === "AXScrollArea");
                        if (areas.length !== 1) {
                            throw new Error("Native scroll needs coordinates or one observed scroll area.");
                        }
                        result = await this.computer.scroll({ ...common, element_ref: areas[0].ref });
                    }
                    break;
                }
                default:
                    throw new Error(`${action.do} is unavailable in native input routing.`);
            }
            const compact = {
                ok: result.ok,
                action: result.action,
                verification: result.verification,
                error: result.error,
                clipboardRestore: result.clipboardRestore,
                revision: result.state?.revision,
                window: result.state?.window,
            };
            return { ok: result.ok, stdout: SafeJSON.stringify(compact), stderr: result.error ?? "", data: compact };
        } catch (error) {
            logger.debug({ error, action: action.do }, "Native capture action stopped without fallback");
            return { ok: false, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
        }
    }
    dispose() {
        this.computer.close_session();
    }
    [Symbol.dispose]() {
        this.dispose();
    }
}
export function nativeTargetRegion(target: CropTarget, screen: ScreenInfo) {
    const windows = nativeWindows(target.app).filter(
        (window) => target.windowTitle === undefined || window.title === target.windowTitle
    );
    const match = [...windows].sort((a, b) => b.w * b.h - a.w * a.h)[0];
    if (!match) {
        return { error: "No native window matches the crop target." };
    }
    const sf = screen.scaleFactor;
    const x = Math.max(0, Math.round((match.x - screen.originCG.x) * sf));
    const y = Math.max(0, Math.round((match.y - screen.originCG.y) * sf));
    const right = Math.min(screen.framePixels.width, Math.round((match.x - screen.originCG.x + match.w) * sf));
    const bottom = Math.min(screen.framePixels.height, Math.round((match.y - screen.originCG.y + match.h) * sf));
    if (right <= x || bottom <= y) {
        return { error: "Native crop target lies outside the captured screen." };
    }
    return { region: { x, y, w: right - x, h: bottom - y } };
}
export function nativeCapturePreflight(appArg?: string): Record<string, unknown> {
    const snapshot = required(runAx(["snapshot"]));
    const app = appArg ?? z.string().parse(snapshot.app);
    const screens = nativeScreens();
    const windows = nativeWindows(app);
    const main = [...windows].filter((window) => window.h > 50).sort((a, b) => b.w * b.h - a.w * a.h)[0];
    const screen =
        screens.find(
            (screen) =>
                main &&
                main.x + main.w / 2 >= screen.originCG.x &&
                main.x + main.w / 2 < screen.originCG.x + screen.points.width &&
                main.y + main.h / 2 >= screen.originCG.y &&
                main.y + main.h / 2 < screen.originCG.y + screen.points.height
        ) ??
        screens.find((screen) => screen.isPrimary) ??
        screens[0];
    if (!screen) {
        throw new Error("Native screen inventory is empty.");
    }
    const mainFramePx = main
        ? {
              x: Math.round((main.x - screen.originCG.x) * screen.scaleFactor),
              y: Math.round((main.y - screen.originCG.y) * screen.scaleFactor),
              w: Math.round(main.w * screen.scaleFactor),
              h: Math.round(main.h * screen.scaleFactor),
          }
        : null;
    return {
        backend: "native",
        screens,
        frontmost: {
            app,
            windows,
            pickedWindow: main ?? null,
            pickedBy: "largest native AX window; set an exact window for input",
            mainWindowPoints: main ? { x: main.x, y: main.y, w: main.w, h: main.h } : null,
            mainWindowFramePx: mainFramePx,
            activeScreenIndex: screen.index,
        },
        unitsReminder: {
            clickCoords: "Global logical CG points; negatives are allowed.",
            cropRegion: "Captured frame pixels.",
        },
        suggestedPlan: {
            capture: {
                backend: "native",
                mode: "screen",
                screenIndex: screen.index,
                duration: 6,
                activeFps: 15,
                threshold: 0.1,
            },
            actions: mainFramePx ? [{ atMs: 0, do: "crop", region: mainFramePx, label: "window" }] : [],
        },
    };
}
