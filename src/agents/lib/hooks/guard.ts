import { detectShellViolations, renderViolations } from "@genesiscz/utils/shell/rules";
import type { ShellViolation } from "@genesiscz/utils/shell/rules/types";
import type { HarnessName, HookOutcome, HooksConfig } from "./config";
import { resolveModel } from "./model";
import { LONG_MISREAD_DOWNGRADE, resolveOutcome } from "./outcome";
import type { HookPayload } from "./payload";
import { isTerminalTool, normalizeEvent } from "./payload";
import { readContextCounts, safeSessionId } from "./state";

export interface GuardViolation extends ShellViolation {
    /** The outcome after config, which may differ from `severity`. */
    outcome: HookOutcome;
}

export interface GuardVerdict {
    outcome: HookOutcome;
    violations: GuardViolation[];
    /** Text for the deny reason (block) or the additional context / advisory. */
    message: string;
    /** Rule ids, in violation order, for the log line. */
    tags: string[];
    /** Blocks that became warns because the command is long; empty otherwise. */
    demoted: string[];
    /** Context notes shown this run; the caller bumps their per-session counters. */
    shownContextRules: string[];
}

const OUTCOME_RANK: Record<HookOutcome, number> = { allow: 0, context: 1, warn: 2, block: 3 };

export const DEFAULT_CONTEXT_CAP = 3;

export interface EvaluateOptions {
    model?: string | null;
    harness?: HarnessName;
    /** Context notes already shown this session, per rule. */
    contextCounts?: Record<string, number>;
}

/**
 * Which threshold actually demoted it. A one-line 3000-character command is demoted by the
 * CHARACTER threshold, and saying "it is 1 lines long" was both the wrong reason and
 * ungrammatical.
 */
function sizeReason(command: string, config: HooksConfig["guard"]): string {
    const lines = command.split("\n").length;
    const chars = command.length;
    const byLines = lines >= config.longCommand.lines;
    const byChars = chars >= config.longCommand.chars;

    if (byLines && byChars) {
        return `${lines} lines and ${chars} characters long`;
    }

    if (byChars) {
        return `${chars} characters long`;
    }

    return `${lines} lines long`;
}

function sortRank(violation: { outcome: HookOutcome; wasDemoted: boolean }): number {
    return violation.wasDemoted ? OUTCOME_RANK.block : OUTCOME_RANK[violation.outcome];
}

export function isLongCommand(command: string, config: HooksConfig["guard"]): boolean {
    return command.split("\n").length >= config.longCommand.lines || command.length >= config.longCommand.chars;
}

/**
 * The ladder and the ordering are load-bearing for the rendered message: blocks first,
 * then warns, then context, and by index within an outcome. Sorting uses the RESOLVED
 * outcome, so a block demoted to a warn sorts as a warn.
 */
export function evaluateCommand(command: string, config: HooksConfig, options: EvaluateOptions = {}): GuardVerdict {
    const guard = config.guard;
    const cap = guard.contextCapPerSession ?? DEFAULT_CONTEXT_CAP;
    const counts = options.contextCounts ?? {};
    const harness = options.harness ?? "claude";
    const model = options.model ?? "";
    // The length downgrade lives in `resolveOutcome`, so the `rules test` diagnostic and
    // this hot path can never disagree. `demoted` is read back off the trace rather than
    // re-applied here, which is what a second implementation would silently drift from.
    const graded = detectShellViolations(command).map((violation) => {
        const resolution = resolveOutcome({
            ruleId: violation.ruleId,
            ruleSeverity: violation.severity,
            kind: violation.kind,
            harness,
            model,
            command,
            config: guard,
        });

        const wasDemoted = resolution.trace.some(([layer]) => layer === LONG_MISREAD_DOWNGRADE);

        return { ...violation, outcome: resolution.outcome, wasDemoted };
    });

    // Sorted on the outcome BEFORE the length downgrade, so a demoted block keeps the place
    // a block would have had. Sorting on the demoted value reorders the rendered notes
    // relative to the guard this replaces.
    const kept = graded
        .filter((violation) => violation.outcome !== "allow")
        .sort((a, b) => sortRank(b) - sortRank(a) || a.index - b.index);
    const resolved: GuardViolation[] = kept.map(({ wasDemoted: _wasDemoted, ...violation }) => violation);
    const demoted = kept.filter((violation) => violation.wasDemoted).map((violation) => violation.ruleId);

    const blocks = resolved.filter((violation) => violation.outcome === "block");

    if (blocks.length > 0) {
        return {
            outcome: "block",
            violations: resolved,
            message: renderViolations(blocks, "Blocked: this command would produce a wrong answer or destroy work."),
            tags: resolved.map((violation) => violation.ruleId),
            demoted,
            shownContextRules: [],
        };
    }

    const shown = resolved.filter(
        (violation) => violation.outcome !== "context" || (counts[violation.ruleId] ?? 0) < cap
    );

    if (shown.length === 0) {
        return {
            outcome: "allow",
            violations: resolved,
            message: "",
            tags: resolved.map((violation) => violation.ruleId),
            demoted,
            shownContextRules: [],
        };
    }

    const outcome: HookOutcome = shown.some((violation) => violation.outcome === "warn") ? "warn" : "context";
    const heading =
        demoted.length > 0
            ? `⚠️ Shell hygiene: the command ran as written. It was NOT blocked only because it is ${sizeReason(command, guard)} and a re-run would cost more than the mistake; read the notes before trusting the output at those points.`
            : "⚠️ Shell hygiene (the command ran as written):";

    return {
        outcome,
        violations: resolved,
        message: renderViolations(shown, heading),
        tags: shown.map((violation) => violation.ruleId),
        demoted,
        shownContextRules: shown
            .filter((violation) => violation.outcome === "context")
            .map((violation) => violation.ruleId),
    };
}

/**
 * The model is only resolved when a `models` glob exists, because reading a transcript tail
 * on every Bash call would buy nothing while the config names no model.
 */
function modelFor(payload: HookPayload, config: HooksConfig): string {
    if (payload.model.length > 0) {
        return payload.model;
    }

    if (Object.keys(config.guard.models ?? {}).length === 0) {
        return "";
    }

    const transcript = payload.raw.transcript_path ?? payload.raw.transcriptPath;
    const resolved = resolveModel(typeof transcript === "string" ? transcript : undefined, {
        settingsFallback: payload.harness === "claude",
    });

    return resolved.model ?? "";
}

/** `null` means the guard has nothing to say: no rule fired, or this is not a shell call. */
export function evaluateGuard(payload: HookPayload, config: HooksConfig): GuardVerdict | null {
    if (!config.guard.enabled || !isTerminalTool(payload.tool) || payload.command.length === 0) {
        return null;
    }

    if (normalizeEvent(payload.event) !== "pretooluse") {
        return null;
    }

    const sessionId = safeSessionId(payload.sessionId);
    const verdict = evaluateCommand(payload.command, config, {
        model: modelFor(payload, config),
        harness: payload.harness,
        contextCounts: sessionId ? readContextCounts(sessionId) : {},
    });

    return verdict.outcome === "allow" ? null : verdict;
}
