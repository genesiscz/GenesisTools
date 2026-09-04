/**
 * Whether the in-process Vite preview is mid-restart. The preview runner and the
 * public front proxy live in the same process, so the proxy reads this to tag
 * every 502 it returns: a gateway error raised while the preview is swapping is
 * a different failure from one raised against a steady-state upstream.
 */
let restarting = false;

export function setPreviewRestarting(value: boolean): void {
    restarting = value;
}

export function isPreviewRestarting(): boolean {
    return restarting;
}
