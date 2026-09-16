import type { AccountSegmentData } from "./types";

/**
 * The segment formatters. Each returns the exact bytes the shell script produced for the same
 * inputs, leading space included, so the two can be diffed with `--compare --command`.
 */
export const ANSI = {
    blue: "\x1b[0;34m",
    magenta: "\x1b[0;35m",
    cyan: "\x1b[0;36m",
    green: "\x1b[0;32m",
    yellow: "\x1b[0;33m",
    red: "\x1b[0;31m",
    dim: "\x1b[2m",
    reset: "\x1b[0m",
} as const;

/** `claude-opus-4-6-20260301` -> `Opus 4.6`; `claude-fable-5-1` -> `Fable 5.1`; unknown ids pass through. */
export function modelDisplayFromId(modelId: string): string {
    const match = /^claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d+))?/.exec(modelId);

    if (!match) {
        return modelId;
    }

    const family = match[1]!;
    const name = `${family[0]!.toUpperCase()}${family.slice(1)}`;
    const version = match[3] ? `${match[2]}.${match[3]}` : match[2];

    return `${name} ${version}`;
}

/** `Opus 4.6` -> `O4.6`, `Sonnet 4.5` -> `S4.5`, `Haiku 4.5` -> `H4.5`; anything else unchanged. */
export function shortModel(model: string): string {
    const match = /^(Opus|Sonnet|Haiku|Fable|Mythos) (.+)$/.exec(model);

    if (!match) {
        return model;
    }

    return `${match[1]![0]}${match[2]}`;
}

/** awk's `%.0fk` above 10k, `%.1fk` below, matching the script. */
export function formatK(tokens: number): string {
    const v = tokens / 1000;

    return v >= 10 ? `${roundHalfEven(v, 0)}k` : `${roundHalfEven(v, 1).toFixed(1)}k`;
}

/** The delta variant: whole tokens under 1k. */
export function formatDeltaK(absDelta: number): string {
    const v = absDelta / 1000;

    if (v >= 10) {
        return `${roundHalfEven(v, 0)}k`;
    }

    if (v >= 1) {
        return `${roundHalfEven(v, 1).toFixed(1)}k`;
    }

    return String(absDelta);
}

/** awk's printf rounds half to even on the binary value; `toFixed` rounds half up. Match awk. */
function roundHalfEven(value: number, digits: number): number {
    const factor = 10 ** digits;
    const scaled = value * factor;
    const floor = Math.floor(scaled);
    const diff = scaled - floor;

    if (Math.abs(diff - 0.5) < 1e-9) {
        return (floor % 2 === 0 ? floor : floor + 1) / factor;
    }

    return Math.round(scaled) / factor;
}

/**
 * What the first cell reads as.
 *
 * `"id"` is the default because `~/.claude/statusline.sh` prints the raw id and this renderer
 * exists to produce the line Martin already reads. `"short"` runs the id through the display
 * mapping first (`claude-opus-5` to `Opus 5` to `O5`), and falls back to the host's own label
 * when the id is missing or the mapping does not recognise it.
 */
export function modelLabel(modelId: string | null, hostLabel: string | null, style: "id" | "short"): string {
    if (style === "id") {
        return modelId ?? hostLabel ?? "Claude";
    }

    const display = modelId ? modelDisplayFromId(modelId) : hostLabel;

    return display ? shortModel(display) : "Claude";
}

export function modelDirSegment(short: string, dirName: string): string {
    return `${ANSI.dim}${short}${ANSI.reset} ${ANSI.blue}${dirName}${ANSI.reset}`;
}

export function gitSegment(branch: string | null): string {
    return branch ? ` ${ANSI.magenta}${branch}${ANSI.reset}` : "";
}

export function dirtySegment(branch: string | null, dirty: number): string {
    return branch && dirty > 0 ? `${ANSI.cyan}*${dirty}${ANSI.reset}` : "";
}

export interface ContextSegmentInput {
    usedTokens: number;
    contextWindowSize: number;
    autocompact: boolean;
}

export interface ContextSegment {
    context: string;
    ac: string;
    usable: number;
    usedPct: number;
}

/** Free-space maths from the script: 22.5% of the window is reserved while autocompact is on. */
export function contextSegment(input: ContextSegmentInput): ContextSegment {
    const buffer = Math.floor((input.contextWindowSize * 225) / 1000);
    const usable = input.autocompact ? input.contextWindowSize - buffer : input.contextWindowSize;
    const usedPct = roundHalfEven((input.usedTokens * 100) / usable, 0);
    const color = usedPct < 50 ? ANSI.green : usedPct < 75 ? ANSI.yellow : ANSI.red;
    const context = ` ${color}${formatK(input.usedTokens)}/${formatK(usable)}(${usedPct}%)${ANSI.reset}`;
    const ac = input.autocompact ? ` ${ANSI.dim}AC${ANSI.reset}` : ` ${ANSI.dim}AC:OFF${ANSI.reset}`;

    return { context, ac, usable, usedPct };
}

export function deltaSegment(delta: number): string {
    if (delta === 0) {
        return "";
    }

    const shown = formatDeltaK(Math.abs(delta));

    return delta > 0 ? ` ${ANSI.green}+${shown}${ANSI.reset}` : ` ${ANSI.red}-${shown}${ANSI.reset}`;
}

export function sessionSegment(input: {
    sessionId: string;
    sessionName: string | null;
    lastMessageTime: string | null;
}): string {
    const label = input.sessionName ? input.sessionName : input.sessionId.slice(0, 8);
    const time = input.lastMessageTime ? ` ${ANSI.dim}@${input.lastMessageTime}${ANSI.reset}` : "";

    return ` ${ANSI.dim}${label}${ANSI.reset}${time}`;
}

function pctColor(pct: number): string {
    return pct >= 80 ? ANSI.red : pct >= 50 ? ANSI.yellow : ANSI.green;
}

/** `⚿ oli…son (U:39%;54%;F:12%) ⌁` with the same staleness marks as the script. */
export function accountSegment(account: AccountSegmentData, now = Date.now()): string {
    const name = account.name;
    const chars = Array.from(name);
    const shortName = chars.length > 7 ? `${chars.slice(0, 3).join("")}…${chars.slice(-3).join("")}` : name;
    let usage = "";

    if (account.fiveHour !== null || account.sevenDay !== null) {
        const c5 = pctColor(account.fiveHour ?? 0);
        const cw = pctColor(account.sevenDay ?? 0);
        const u5 = account.fiveHour === null ? "?" : String(account.fiveHour);
        const uw = account.sevenDay === null ? "?" : String(account.sevenDay);
        usage = ` ${ANSI.dim}(U:${ANSI.reset}${c5}${u5}%${ANSI.reset}${ANSI.dim};${ANSI.reset}${cw}${uw}%${ANSI.reset}`;

        if (account.sevenDayFable !== null) {
            usage += `${ANSI.dim};F:${ANSI.reset}${pctColor(account.sevenDayFable)}${account.sevenDayFable}%${ANSI.reset}`;
        }

        usage += `${ANSI.dim})${ANSI.reset}${ageMark(account, now)}`;
    }

    return ` ${ANSI.yellow}⚿ ${shortName}${ANSI.reset}${usage}`;
}

function ageMark(account: AccountSegmentData, now: number): string {
    if (account.stale) {
        return ` ${ANSI.yellow}⌁?${ANSI.reset}`;
    }

    if (account.fetchedAt === null) {
        return "";
    }

    const ageSeconds = Math.floor((now - account.fetchedAt) / 1000);

    if (ageSeconds >= 3600) {
        return ` ${ANSI.red}⌁!${ANSI.reset}`;
    }

    if (ageSeconds >= 300) {
        return ` ${ANSI.yellow}⌁${ANSI.reset}`;
    }

    return "";
}
