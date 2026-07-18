import type { AIAccountEntry } from "@genesiscz/utils/config/ai.types";
import { stripAnsi } from "@genesiscz/utils/string";
import pc from "picocolors";
import type { ScoredAccount } from "./account-picker";
import type { CompactLimit } from "./compact-limits";

/**
 * Focus highlight: 256-color 75 (#5fafff), bold — a light azure with strong
 * contrast on dark terminal backgrounds, distinct from the cyan frame.
 */
export function accent(text: string): string {
    return `\x1b[1;38;5;75m${text}\x1b[22;39m`;
}

export function visibleWidth(text: string): number {
    return stripAnsi(text).length;
}

/** Pad an ANSI-colored string to a visible width. */
export function padVisible(text: string, width: number, align: "left" | "right" = "left"): string {
    const pad = Math.max(0, width - visibleWidth(text));
    return align === "left" ? text + " ".repeat(pad) : " ".repeat(pad) + text;
}

export const TIER_BADGE: Record<ScoredAccount["tier"], string> = {
    ready: pc.green("●"),
    "session-starved": pc.yellow("◐"),
    "weekly-blocked": pc.red("○"),
    "no-data": pc.dim("?"),
};

function colorByPct(pct: number, text: string): string {
    if (pct < 20) {
        return pc.red(text);
    }

    if (pct <= 50) {
        return pc.yellow(text);
    }

    return pc.green(text);
}

function pctCell(limit: CompactLimit | undefined): string {
    if (!limit) {
        return pc.dim("   —");
    }

    const pct = Math.round(limit.leftPct);
    return colorByPct(pct, `${String(pct).padStart(3)}%`);
}

function hoursUntil(resetsAt: string | null | undefined, now: Date): number | null {
    if (!resetsAt) {
        return null;
    }

    const ms = new Date(resetsAt).getTime() - now.getTime();
    if (!Number.isFinite(ms) || ms <= 0) {
        return null;
    }

    return ms / 3_600_000;
}

/** Coarse duration for the RESETS column: "45m", "24h", "5d". */
function fmtCoarse(hours: number | null): string {
    if (hours === null) {
        return "—";
    }

    if (hours < 1) {
        return `${Math.max(1, Math.round(hours * 60))}m`;
    }

    if (hours < 48) {
        return `${Math.round(hours)}h`;
    }

    return `${Math.round(hours / 24)}d`;
}

/** Compact relative distance for the detail zone: "2d 10h", "5h 20m", "12m". */
function fmtRelative(from: Date, to: Date): string {
    const totalMinutes = Math.max(0, Math.round((to.getTime() - from.getTime()) / 60_000));
    const days = Math.floor(totalMinutes / 1440);
    const hours = Math.floor((totalMinutes % 1440) / 60);
    const minutes = totalMinutes % 60;

    if (days > 0) {
        return `${days}d ${hours}h`;
    }

    if (hours > 0) {
        return `${hours}h ${minutes}m`;
    }

    return `${Math.max(1, minutes)}m`;
}

export interface TableWidths {
    name: number;
}

export function tableWidths(scored: ScoredAccount[]): TableWidths {
    return { name: Math.max(7, ...scored.map((s) => s.accountName.length)) + 2 };
}

const PCT_W = 4;
const GAP = "  ";
const RESETS_W = 12;

/** `  ACCOUNT      5H    WL    FB   RESETS 5H·WL` (dim). */
export function tableHeaderRow(widths: TableWidths): string {
    return pc.dim(
        `${padVisible("ACCOUNT", widths.name)}${GAP}${padVisible("5H", PCT_W, "right")}${GAP}` +
            `${padVisible("WL", PCT_W, "right")}${GAP}${padVisible("FB", PCT_W, "right")}${GAP} ${padVisible("RESETS 5H·WL", RESETS_W)}`
    );
}

/** `ohfixit         100%   99%   98%   2h · 38h` — badge NOT included. */
export function tableRow(scored: ScoredAccount, widths: TableWidths, now: Date = new Date(), focused = false): string {
    const limits = scored.limits;
    const resets = limits
        ? `${fmtCoarse(hoursUntil(limits.session?.resetsAt, now))} · ${fmtCoarse(hoursUntil(limits.weekly?.resetsAt, now))}`
        : "—";
    const name = focused
        ? padVisible(accent(scored.accountName), widths.name)
        : padVisible(scored.accountName, widths.name);

    return (
        `${name}${GAP}${padVisible(pctCell(limits?.session), PCT_W, "right")}${GAP}` +
        `${padVisible(pctCell(limits?.weekly), PCT_W, "right")}${GAP}${padVisible(pctCell(limits?.fable), PCT_W, "right")}${GAP} ` +
        padVisible(pc.dim(resets), RESETS_W)
    );
}

const DETAIL_LABEL_W = 8;
const BAR_W = 10;
const WHY_MAX_W = 66;

/** `████████░░ 78%` — colored by headroom. */
function barCell(limit: CompactLimit | undefined): string {
    if (!limit) {
        return pc.dim("—");
    }

    const pct = Math.round(limit.leftPct);
    const filled = Math.round((pct / 100) * BAR_W);
    const bar = "█".repeat(filled) + pc.dim("░".repeat(BAR_W - filled));
    return `${colorByPct(pct, bar)} ${colorByPct(pct, `${pct}%`)}`;
}

/** `in 2h 5m` / `in 4d 10h` / `—` for a limit's reset. */
function resetCell(limit: CompactLimit | undefined, now: Date): string {
    if (!limit?.resetsAt) {
        return "—";
    }

    const reset = new Date(limit.resetsAt);
    if (!Number.isFinite(reset.getTime()) || reset.getTime() <= now.getTime()) {
        return "—";
    }

    return `in ${fmtRelative(now, reset)}`;
}

/** Same reset moment at minute granularity (the API's timestamps differ by µs). */
function sameResetMoment(a: string | null | undefined, b: string | null | undefined): boolean {
    if (!a || !b) {
        return false;
    }

    const diff = Math.abs(new Date(a).getTime() - new Date(b).getTime());
    return Number.isFinite(diff) && diff < 60_000;
}

function capitalize(text: string): string {
    return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Cap the ranking explanation so the detail zone never wraps (wrap breaks the fixed-height redraw). */
function truncateWhy(why: string): string {
    return why.length > WHY_MAX_W ? `${why.slice(0, WHY_MAX_W - 1)}…` : why;
}

/** `Weekly   ████░░░░░░  20%  in 7h 29m` — one narrow row per limit. */
function limitRow(label: string, limit: CompactLimit | undefined, reset: string): string {
    return `${pc.dim(padVisible(label, DETAIL_LABEL_W))} ${padVisible(barCell(limit), BAR_W + 5, "left")} ${pc.dim(reset)}`;
}

/**
 * The fixed-height (5-line) detail zone for the focused account, kept narrow
 * for quarter-screen terminals:
 *   1. name (accent-highlighted) · email
 *   2. subscription plan · ranking explanation (why this position)
 *   3-5. one row per limit: full name, headroom bar, reset countdown.
 */
export function detailBlock(
    scored: ScoredAccount,
    account: AIAccountEntry | undefined,
    now: Date = new Date()
): string[] {
    const identity = [accent(scored.accountName)];

    if (account?.secondary?.emailAddress) {
        identity.push(pc.dim(account.secondary.emailAddress));
    }

    if (scored.dataNote) {
        identity.push(pc.yellow(`[${scored.dataNote}]`));
    }

    const plan = account?.label ? `${capitalize(account.label)} subscription` : "Subscription";
    const subscription = pc.dim(`${plan} · ${truncateWhy(scored.why)}`);

    const limits = scored.limits;

    if (!limits) {
        return [
            identity.join(" · "),
            subscription,
            limitRow("5 Hour", undefined, "—"),
            limitRow("Weekly", undefined, "—"),
            limitRow("Fable", undefined, "—"),
        ];
    }

    const fableSameAsWeekly = sameResetMoment(limits.fable?.resetsAt, limits.weekly?.resetsAt);
    const fableReset = fableSameAsWeekly ? "= weekly" : resetCell(limits.fable, now);

    return [
        identity.join(" · "),
        subscription,
        limitRow("5 Hour", limits.session, resetCell(limits.session, now)),
        limitRow("Weekly", limits.weekly, resetCell(limits.weekly, now)),
        limitRow("Fable", limits.fable, fableReset),
    ];
}
