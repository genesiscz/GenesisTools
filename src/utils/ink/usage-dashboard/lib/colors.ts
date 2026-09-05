import type { LimitKind, LimitWindow } from "@genesiscz/utils/ai/providers/account-features";

export type UsageColor = "red" | "yellow" | "green";

/** Ink colour name for a window's own identity, as opposed to how spent it is. */
export type WindowColor = string;

/**
 * One colour per limit window, provider-neutral. The claude keys keep the exact colours
 * the History tab has always drawn them in (`BUCKET_INK_COLORS` before the 2026-09 split),
 * and codex and grok reuse the same session/weekly/monthly reading of the same palette so
 * one colour means one thing across providers.
 */
const WINDOW_KEY_COLORS: Record<string, WindowColor> = {
    // anthropic-sub
    five_hour: "cyan",
    seven_day: "yellow",
    seven_day_opus: "magenta",
    seven_day_sonnet: "green",
    seven_day_oauth_apps: "blue",
    // Never had a colour of its own; pinned so the fallback below cannot change it.
    extra_usage: "magenta",
    // openai-sub
    primary: "cyan",
    secondary: "yellow",
    // grok-sub
    weekly: "yellow",
    monthly: "blue",
    credit: "green",
};

const WINDOW_PALETTE: WindowColor[] = ["cyan", "yellow", "green", "blue", "magenta"];

/** djb2, so a key picks the same palette slot on every run and on every machine. */
function paletteIndex(key: string): number {
    let hash = 5381;

    for (let i = 0; i < key.length; i++) {
        hash = ((hash << 5) + hash + key.charCodeAt(i)) | 0;
    }

    return Math.abs(hash) % WINDOW_PALETTE.length;
}

/**
 * Colour for a window key. Unknown `seven_day_*` windows (a scoped model the mapper has
 * not been taught yet) stay magenta, which is what the claude History tab drew them in;
 * every other unknown key gets a stable palette slot, so grok's `product:grokcode` and
 * `product:grokimagine` do not collapse into one colour.
 */
export function colorForWindowKey(key: string): WindowColor {
    const known = WINDOW_KEY_COLORS[key];

    if (known) {
        return known;
    }

    if (key.startsWith("seven_day_")) {
        return "magenta";
    }

    return WINDOW_PALETTE[paletteIndex(key)];
}

export function colorForPercent(pct: number): UsageColor {
    if (pct >= 80) {
        return "red";
    }

    if (pct >= 50) {
        return "yellow";
    }

    return "green";
}

/**
 * How close a reset has to be before a spent window stops reading as a problem.
 * A session window refilling in 20 minutes is not worth a red bar; a weekly one
 * refilling tonight is not either.
 */
export const DEFAULT_IMMINENT_RESET_MS: Record<LimitKind, number> = {
    session: 30 * 60 * 1000,
    weekly: 6 * 60 * 60 * 1000,
    scoped: 6 * 60 * 60 * 1000,
    monthly: 24 * 60 * 60 * 1000,
    credit: 24 * 60 * 60 * 1000,
};

export function isResetImminent(
    window: LimitWindow,
    now: number,
    thresholds: Partial<Record<LimitKind, number>> = {}
): boolean {
    if (!window.resetsAt) {
        return false;
    }

    const resetMs = Date.parse(window.resetsAt);

    if (!Number.isFinite(resetMs)) {
        return false;
    }

    const remaining = resetMs - now;

    if (remaining <= 0) {
        // Already rolled over — the cache just has not caught up.
        return true;
    }

    return remaining <= (thresholds[window.kind] ?? DEFAULT_IMMINENT_RESET_MS[window.kind]);
}

/** Percent colour that accounts for the refill: low-but-about-to-reset reads green. */
export function colorForWindow(
    window: LimitWindow,
    now: number,
    thresholds?: Partial<Record<LimitKind, number>>
): UsageColor {
    if (isResetImminent(window, now, thresholds)) {
        return "green";
    }

    return colorForPercent(window.percentUsed);
}
