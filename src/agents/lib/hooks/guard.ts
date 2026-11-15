import { detectShellViolations, type RenderOptions, renderViolations } from "@genesiscz/utils/shell/rules";
import type { ShellRule, ShellViolation } from "@genesiscz/utils/shell/rules/types";
import type { HarnessName, HookOutcome, HooksConfig } from "./config";
import { resolveModel } from "./model";
import { LONG_MISREAD_DOWNGRADE, resolveOutcome } from "./outcome";
import type { HookPayload } from "./payload";
import { HARNESS_HOOK_FACTS, hookCallerFacts, isTerminalTool, normalizeEvent } from "./payload";
import { MAIN_LOOP, readHookState, safeSessionId } from "./state";

export interface GuardViolation extends ShellViolation {
    /** The outcome after config, which may differ from `severity`. */
    outcome: HookOutcome;
}

export interface GuardVerdict {
    outcome: HookOutcome;
    violations: GuardViolation[];
    /** Text for the model: the deny reason (block) or the additional context. */
    message: string;
    /**
     * Text for the user's `systemMessage`: every rule in full (never the compact form), and of a long command only the
     * corrected part (`guard.corrected`).
     */
    userMessage: string;
    /** Rules this message explained in full; the caller records them for the loop, so the next firing is compact. */
    explainedRules: string[];
    /** Rule ids, in violation order, for the log line. */
    tags: string[];
    /** Blocks that became warns because the command is long; empty otherwise. */
    demoted: string[];
    /** Context notes shown this run; the caller bumps their per-session counters. */
    shownContextRules: string[];
    /** Rules whose text is in `message`; the caller records the time the loop saw them. */
    seenRules: string[];
    /** Warns and context notes left out because the loop saw them within `guard.quietMinutes`. */
    quieted: string[];
}

const OUTCOME_RANK: Record<HookOutcome, number> = { allow: 0, context: 1, warn: 2, block: 3 };

export const DEFAULT_CONTEXT_CAP = 3;

export interface EvaluateOptions {
    model?: string | null;
    harness?: HarnessName;
    /** Context notes already shown this session, per rule. */
    contextCounts?: Record<string, number>;
    /** The folder the command runs in (the payload's `cwd`), for rules that read the project. */
    cwd?: string;
    /** The rules to run. Default: the built-in registry; the hooks pass it plus the custom rules. */
    rules?: readonly ShellRule[];
    /** Whether this loop already read the rule in full since its last compaction; it then gets the compact form. */
    explainedEarlier?: (ruleId: string) => boolean;
    /** Whether this loop saw the rule's message within `guard.quietMinutes`; a warn or a note is then left out. */
    seenRecently?: (ruleId: string) => boolean;
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
    const graded = detectShellViolations(command, options.rules, { cwd: options.cwd }).map((violation) => {
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
    const explainedEarlier = options.explainedEarlier ?? (() => false);
    const seenRecently = options.seenRecently ?? (() => false);
    const render = (shown: readonly GuardViolation[], heading: string, denied: boolean) => {
        const explained = new Set(
            shown.map((violation) => violation.ruleId).filter((ruleId) => explainedEarlier(ruleId))
        );
        const renderOptions: RenderOptions = { command, explained, denied, corrected: config.guard.corrected };
        return {
            message: renderViolations(shown, heading, renderOptions),
            // Every rule in full, but the corrected command by the same limits as the model's text: the whole of a
            // long command is no correction to read (2026-11-12: a 244-line heredoc printed again for one changed line).
            userMessage: renderViolations(shown, heading, { command, corrected: config.guard.corrected }),
            explainedRules: [
                ...new Set(shown.map((violation) => violation.ruleId).filter((ruleId) => !explained.has(ruleId))),
            ],
        };
    };

    if (blocks.length > 0) {
        return {
            outcome: "block",
            violations: resolved,
            ...render(blocks, "Blocked: this command would produce a wrong answer or destroy work.", true),
            tags: resolved.map((violation) => violation.ruleId),
            demoted,
            shownContextRules: [],
            seenRules: [...new Set(blocks.map((violation) => violation.ruleId))],
            quieted: [],
        };
    }

    // A block always shows (the command did not run). A warn or a note the loop saw a few minutes ago says nothing new.
    const quietedRules = new Set(
        resolved.map((violation) => violation.ruleId).filter((ruleId) => seenRecently(ruleId))
    );
    const quieted = [...quietedRules];
    const shown = resolved.filter(
        (violation) =>
            !quietedRules.has(violation.ruleId) &&
            (violation.outcome !== "context" || (counts[violation.ruleId] ?? 0) < cap)
    );

    if (shown.length === 0) {
        return {
            outcome: "allow",
            violations: resolved,
            message: "",
            userMessage: "",
            explainedRules: [],
            tags: resolved.map((violation) => violation.ruleId),
            demoted,
            shownContextRules: [],
            seenRules: [],
            quieted,
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
        ...render(shown, heading, false),
        tags: shown.map((violation) => violation.ruleId),
        demoted,
        shownContextRules: shown
            .filter((violation) => violation.outcome === "context")
            .map((violation) => violation.ruleId),
        seenRules: [...new Set(shown.map((violation) => violation.ruleId))],
        quieted,
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

    const resolved = resolveModel(payload.harness, payload.transcriptPath);

    return resolved.model ?? "";
}

/** The loop a call belongs to: a subagent is its own loop, with its own context and its own compactions. */
export function guardLoop(payload: HookPayload): string {
    return payload.agentId ?? MAIN_LOOP;
}

/**
 * Whether the loop saw a rule's message within `quietMinutes` and has not compacted since. Only the clock and the
 * state file decide a rule the loop never saw, so the common case costs no transcript read.
 */
function seenRecentlyIn(options: {
    seen: Record<string, number>;
    quietMinutes: number;
    now: number;
    explainedEarlier: (ruleId: string) => boolean;
}): (ruleId: string) => boolean {
    return (ruleId) => {
        const at = options.seen[ruleId];

        if (options.quietMinutes <= 0 || at === undefined || options.now - at >= options.quietMinutes * 60_000) {
            return false;
        }

        return options.explainedEarlier(ruleId);
    };
}

/**
 * Whether the loop already read a rule in full: it was explained to the loop, and the loop's transcript records no
 * compaction since, because a compaction summary does not keep the explanation. The transcript is only read for a
 * rule the loop was told before, so a first firing costs no read.
 *
 * `compactedSince` reads up to 4 MiB of the transcript's tail, and a command can fire several familiar rules, so one
 * guard call asks it once per explanation time. The earliest explanation is asked first: no compaction since it (the
 * usual case) means none since any later one either, so that one read settles every rule.
 */
function explainedEarlierIn(payload: HookPayload, explained: Record<string, number>): (ruleId: string) => boolean {
    const earliest = Math.min(...Object.values(explained));
    const answers = new Map<number, boolean>();
    let transcript: string | undefined | null = null;
    const compactedSince = (path: string, since: number): boolean => {
        let compacted = answers.get(since);

        if (compacted === undefined) {
            compacted = HARNESS_HOOK_FACTS[payload.harness].compactedSince(path, since);
            answers.set(since, compacted);
        }

        return compacted;
    };

    return (ruleId) => {
        const since = explained[ruleId];

        if (since === undefined) {
            return false;
        }

        transcript ??= hookCallerFacts(payload).transcriptPath;

        if (!transcript) {
            return false;
        }

        return !compactedSince(transcript, earliest) || !compactedSince(transcript, since);
    };
}

/** `null` means the guard has nothing to say: no rule fired, or this is not a shell call. */
export function evaluateGuard(
    payload: HookPayload,
    config: HooksConfig,
    rules?: readonly ShellRule[]
): GuardVerdict | null {
    if (!config.guard.enabled || !isTerminalTool(payload.tool) || payload.command.length === 0) {
        return null;
    }

    if (normalizeEvent(payload.event) !== "pretooluse") {
        return null;
    }

    const sessionId = safeSessionId(payload.sessionId);
    const state = sessionId ? readHookState(sessionId).guard : null;
    const loop = guardLoop(payload);
    const explainedEarlier = explainedEarlierIn(payload, state?.explained[loop] ?? {});
    const verdict = evaluateCommand(payload.command, config, {
        model: modelFor(payload, config),
        harness: payload.harness,
        contextCounts: state?.contextNotes ?? {},
        cwd: payload.cwd,
        rules,
        explainedEarlier,
        seenRecently: seenRecentlyIn({
            seen: state?.seen[loop] ?? {},
            quietMinutes: config.guard.quietMinutes,
            now: Date.now(),
            explainedEarlier,
        }),
    });

    // A firing that shows nothing (all quiet, or a context rule past its session cap) still comes back, so the hook
    // can count it; settleGuardVerdict keeps an allow verdict from producing output.
    return verdict.outcome === "allow" && verdict.violations.length === 0 ? null : verdict;
}
