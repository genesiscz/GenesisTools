import type { LowQuotaSwitch } from "@app/claude/lib/config";
import type { ClaudeModelFamily } from "@app/claude/lib/models";
import type { AccountUsage } from "@genesiscz/utils/ai/providers/plugins/anthropic-sub/api";
import {
    type CompactLimit,
    effectiveLeftPct,
    extractCompactLimits,
} from "@genesiscz/utils/ai/providers/plugins/anthropic-sub/compact-limits";

export type LowQuotaWindow = "weekly" | "fable-weekly" | "five-hour";

export interface LowQuotaHit {
    window: LowQuotaWindow;
    /** 0 to 100, what is left of the window now (a reset that already passed reads as a fresh window). */
    leftPct: number;
    /** The setting the window fell under. */
    belowPct: number;
    resetsAt: string | null;
}

/** How the question names each window. */
export const LOW_QUOTA_WINDOW_NAMES: Record<LowQuotaWindow, string> = {
    weekly: "weekly limit",
    "fable-weekly": "Fable weekly limit",
    "five-hour": "5-hour window",
};

/**
 * The window of `usage` that has less left than the setting allows, or null. The weekly limits come first, because
 * they take days to refill and the 5-hour window takes hours. The Fable weekly limit counts only for a Fable session:
 * another model does not spend it. An account without usage, or without a 5-hour limit, gives no hit for what it lacks.
 */
export function lowQuotaHit(input: {
    usage: AccountUsage | undefined;
    modelFamily?: ClaudeModelFamily;
    setting: Pick<LowQuotaSwitch, "fiveHourLeftBelowPct" | "weeklyLeftBelowPct">;
    now?: Date;
}): LowQuotaHit | null {
    if (!input.usage?.usage) {
        return null;
    }

    const now = input.now ?? new Date();
    const limits = extractCompactLimits(input.usage.usage);
    const candidates: [LowQuotaWindow, CompactLimit | undefined, number][] = [
        ["weekly", limits.weekly, input.setting.weeklyLeftBelowPct],
        ["fable-weekly", input.modelFamily === "fable" ? limits.fable : undefined, input.setting.weeklyLeftBelowPct],
        ["five-hour", limits.session, input.setting.fiveHourLeftBelowPct],
    ];

    for (const [window, limit, belowPct] of candidates) {
        if (!limit) {
            continue;
        }

        const leftPct = effectiveLeftPct(limit, now);

        if (leftPct < belowPct) {
            return { window, leftPct, belowPct, resetsAt: limit.resetsAt };
        }
    }

    return null;
}

/** Flags of claude that name the session to open. `--resume` and `-r` may stand alone (claude's own picker). */
const SESSION_FLAGS_WITH_VALUE = new Set(["--session-id"]);
const SESSION_FLAGS_OPTIONAL_VALUE = new Set(["--resume", "-r"]);
const SESSION_FLAGS_ALONE = new Set(["--continue", "-c", "--fork-session"]);

/** `args` without the flags that name a session, so a relaunch can name the session itself. */
export function withoutSessionArgs(args: readonly string[]): string[] {
    const kept: string[] = [];

    for (let i = 0; i < args.length; i++) {
        if (args[i] === "--") {
            kept.push(...args.slice(i));
            break;
        }

        const flag = args[i].split("=")[0];

        if (SESSION_FLAGS_ALONE.has(flag)) {
            continue;
        }

        const takesValue = SESSION_FLAGS_WITH_VALUE.has(flag);

        if (!takesValue && !SESSION_FLAGS_OPTIONAL_VALUE.has(flag)) {
            kept.push(args[i]);
            continue;
        }

        const next = args[i + 1];
        const valueFollows = !args[i].includes("=") && next !== undefined && (takesValue || !next.startsWith("-"));

        if (valueFollows) {
            i += 1;
        }
    }

    return kept;
}

/** The launch options the switch changes; the others (model, keychain, cmux, tmux) stay as the user gave them. */
interface SwitchedOptions {
    resume?: string | boolean;
    continue?: boolean;
    pick?: boolean;
    autopick?: boolean;
}

/**
 * The relaunch after a yes: no account name and `--pick`, so the usage-ranked account picker opens as for a plain
 * `tools claude run --resume`, and the session that was open resumes. When that session is not known, a bare
 * `--resume` opens the session picker of the folder after the account picker.
 */
export function switchRelaunch<O extends SwitchedOptions>(input: {
    opts: O;
    passthrough: readonly string[];
    sessionId: string | null;
}): { opts: Omit<O, keyof SwitchedOptions> & SwitchedOptions; passthrough: string[] } {
    const passthrough = withoutSessionArgs(input.passthrough);

    return {
        opts: {
            ...input.opts,
            resume: input.sessionId ? undefined : true,
            continue: undefined,
            pick: true,
            autopick: undefined,
        },
        passthrough: input.sessionId ? ["--resume", input.sessionId, ...passthrough] : passthrough,
    };
}
