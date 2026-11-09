/**
 * Font lists for text drawn with @napi-rs/canvas. Its generic families do not follow the platform: on macOS
 * `sans-serif`, `monospace`, `system-ui` and every family it does not know resolve to Apple SD Gothic Neo
 * (measured 2026-11-09), a Korean font whose Latin covers only ASCII, so á, č, ě, ř, š and ž drew as boxes, and
 * `monospace` was not monospaced. Each list names a font of macOS, Windows and Linux with Latin Extended-A; the first
 * one installed wins, and the generic family stays last for a machine with none of them.
 */
const SANS_FAMILIES = ['"Helvetica Neue"', "Helvetica", "Arial", '"DejaVu Sans"', '"Noto Sans"', "sans-serif"];
const MONO_FAMILIES = ["Menlo", "Monaco", "Consolas", '"DejaVu Sans Mono"', '"Liberation Mono"', "monospace"];

/** A `ctx.font` value: `canvasFont({ sizePx: 24, weight: 600 })`. */
export function canvasFont({ sizePx, weight, mono }: { sizePx: number; weight?: number; mono?: boolean }): string {
    const families = (mono ? MONO_FAMILIES : SANS_FAMILIES).join(", ");
    return `${weight ? `${weight} ` : ""}${sizePx}px ${families}`;
}
