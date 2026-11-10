/**
 * The one module that loads @napi-rs/canvas. The addon reads every system font when it loads (about 100 ms), so a
 * module that only reads a constant or a planner must not pay it: every drawing function calls `await loadCanvas()`
 * at its first line, and type positions use `import type` from "@napi-rs/canvas", which costs nothing at run time.
 * The lint rule `no-canvas-import-outside-owner` keeps every other value import out.
 */
export type CanvasModule = typeof import("@napi-rs/canvas");

let loading: Promise<CanvasModule> | undefined;

/** Loads the addon once (it reads every system font, about 100 ms). */
export function loadCanvas(): Promise<CanvasModule> {
    loading ??= import("@napi-rs/canvas");
    return loading;
}
